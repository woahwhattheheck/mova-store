#![no_std]

mod errors;
mod events;
mod order;
mod quote;
mod storage;
mod test;

use soroban_sdk::token::TokenClient;
use soroban_sdk::{contract, contractimpl, Address, BytesN, Env, MuxedAddress, Vec};

use crate::errors::Error;
use crate::events::{OrderCreated, OrderRefunded, OrderShipped, PaymentReceived};
use crate::order::{Order, Status};
pub use crate::quote::QuoteLine;
use crate::storage::{
    get_admin, get_order, get_product_price, get_quote_expiry, get_quote_signer, has_admin,
    is_token_allowed, remove_product_price as delete_product_price, set_admin, set_order,
    set_product_price as write_product_price, set_quote_expiry,
    set_quote_signer as write_quote_signer, set_token_allowed,
};

/// Quotes are intentionally short-lived so a stale browser session cannot lock
/// in a merchant price indefinitely.
pub const QUOTE_TTL_SECONDS: u64 = 15 * 60;
/// Bound quote computation/cost and make duplicate detection deterministic.
pub const MAX_QUOTE_LINES: u32 = 64;

#[contract]
pub struct Checkout;

#[contractimpl]
impl Checkout {
    /// Initialize the contract with the merchant's Stellar public key.
    /// The merchant address must authorize this call (deployer signs).
    ///
    /// The merchant is also the initial quote signer. Production deployments
    /// can rotate quote registration to a dedicated server-side signer so the
    /// escrow/admin key never has to live in the web tier.
    pub fn initialize(env: Env, merchant: Address) -> Result<(), Error> {
        if has_admin(&env) {
            return Err(Error::AlreadyInitialized);
        }
        merchant.require_auth();
        set_admin(&env, &merchant);
        write_quote_signer(&env, &merchant);
        Ok(())
    }

    /// Change the merchant wallet that owns the contract.
    /// Only the current merchant can authorize this. The quote signer is kept
    /// independent and is not implicitly rotated by this operation.
    pub fn set_merchant(env: Env, new_merchant: Address) -> Result<(), Error> {
        let admin = get_admin(&env)?;
        admin.require_auth();
        set_admin(&env, &new_merchant);
        Ok(())
    }

    /// Read the merchant wallet that owns the contract.
    pub fn merchant(env: Env) -> Result<Address, Error> {
        get_admin(&env)
    }

    /// Rotate the account authorized to register pending quotes. Only the
    /// merchant/admin can rotate this key. The signer authorizes quote creation
    /// but never supplies catalog prices: the contract still re-computes the
    /// exact amount from merchant-controlled product/token prices.
    pub fn set_quote_signer(env: Env, new_signer: Address) -> Result<(), Error> {
        let admin = get_admin(&env)?;
        admin.require_auth();
        write_quote_signer(&env, &new_signer);
        Ok(())
    }

    /// Read the account currently authorized to register pending quotes.
    pub fn quote_signer(env: Env) -> Result<Address, Error> {
        get_quote_signer(&env)
    }

    /// Approve a SEP-41 token contract for payments. Only the merchant can
    /// call this. Every accepted token must be whitelisted before it can fund
    /// catalog prices, quotes, or orders.
    pub fn add_token(env: Env, token: Address) -> Result<(), Error> {
        let admin = get_admin(&env)?;
        admin.require_auth();
        set_token_allowed(&env, &token, true);
        Ok(())
    }

    /// Remove a token from the approved list. Existing quotes for the token
    /// fail closed at payment time until/unless it is approved again.
    pub fn remove_token(env: Env, token: Address) -> Result<(), Error> {
        let admin = get_admin(&env)?;
        admin.require_auth();
        set_token_allowed(&env, &token, false);
        Ok(())
    }

    /// Query whether a token contract is accepted for payments.
    pub fn is_token_allowed(env: Env, token: Address) -> bool {
        is_token_allowed(&env, &token)
    }

    /// Set the merchant-authoritative unit price for one product/token pair.
    /// Product identity is a 32-byte canonical digest chosen by the storefront;
    /// callers never supply a unit price when creating a quote.
    pub fn set_product_price(
        env: Env,
        product_id: BytesN<32>,
        token: Address,
        unit_price: i128,
    ) -> Result<(), Error> {
        let admin = get_admin(&env)?;
        admin.require_auth();
        if unit_price <= 0 {
            return Err(Error::InvalidAmount);
        }
        if !is_token_allowed(&env, &token) {
            return Err(Error::TokenNotAllowed);
        }
        write_product_price(&env, &product_id, &token, unit_price);
        Ok(())
    }

    /// Remove a product/token price from the checkout catalog. Only the
    /// merchant can authorize this. New quotes immediately fail closed.
    pub fn remove_product_price(
        env: Env,
        product_id: BytesN<32>,
        token: Address,
    ) -> Result<(), Error> {
        let admin = get_admin(&env)?;
        admin.require_auth();
        delete_product_price(&env, &product_id, &token);
        Ok(())
    }

    /// Read the authoritative raw-token unit price for a catalog row.
    pub fn product_price(env: Env, product_id: BytesN<32>, token: Address) -> Option<i128> {
        get_product_price(&env, &product_id, &token)
    }

    /// Register a pending quote from canonical product ids + quantities only.
    ///
    /// The configured quote signer authorizes creation. The caller has no
    /// price input: unit prices are resolved from the merchant-controlled
    /// on-chain catalog and the resulting buyer/token/amount/expiry tuple is
    /// persisted immutably under `order_id`. This makes browser/localStorage
    /// prices advisory only while keeping quote-registration authority off the
    /// public client.
    ///
    /// Returns the exact raw-token amount that `pay` will later require.
    pub fn create_quote(
        env: Env,
        buyer: Address,
        order_id: BytesN<32>,
        token: Address,
        lines: Vec<QuoteLine>,
    ) -> Result<i128, Error> {
        let signer = get_quote_signer(&env)?;
        signer.require_auth();

        if !is_token_allowed(&env, &token) {
            return Err(Error::TokenNotAllowed);
        }
        if get_order(&env, &order_id).is_some() {
            return Err(Error::OrderAlreadyPaid);
        }

        let line_count = lines.len();
        if line_count == 0 {
            return Err(Error::EmptyQuote);
        }
        if line_count > MAX_QUOTE_LINES {
            return Err(Error::TooManyItems);
        }

        let mut amount: i128 = 0;
        let mut index: u32 = 0;
        while index < line_count {
            let line = lines.get(index).ok_or(Error::EmptyQuote)?;
            if line.quantity == 0 {
                return Err(Error::InvalidQuantity);
            }

            // Duplicate product rows are rejected rather than silently summed;
            // this prevents client-side row duplication from changing semantics.
            let mut prior: u32 = 0;
            while prior < index {
                let previous = lines.get(prior).ok_or(Error::EmptyQuote)?;
                if previous.product_id == line.product_id {
                    return Err(Error::DuplicateProduct);
                }
                prior += 1;
            }

            let unit_price =
                get_product_price(&env, &line.product_id, &token).ok_or(Error::ProductNotFound)?;
            if unit_price <= 0 {
                return Err(Error::InvalidAmount);
            }
            let line_amount = unit_price
                .checked_mul(line.quantity as i128)
                .ok_or(Error::AmountOverflow)?;
            amount = amount
                .checked_add(line_amount)
                .ok_or(Error::AmountOverflow)?;
            index += 1;
        }

        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }

        let timestamp = env.ledger().timestamp();
        let expires_at = timestamp.saturating_add(QUOTE_TTL_SECONDS);
        let order = Order {
            buyer: buyer.clone(),
            amount,
            token: token.clone(),
            timestamp,
            status: Status::Pending,
        };
        set_order(&env, &order_id, &order);
        set_quote_expiry(&env, &order_id, expires_at);

        OrderCreated {
            token,
            buyer,
            order_id,
            amount,
            timestamp,
        }
        .publish(&env);

        Ok(amount)
    }

    /// Read a quote expiry timestamp, if an authoritative quote exists.
    pub fn quote_expires_at(env: Env, order_id: BytesN<32>) -> Option<u64> {
        get_quote_expiry(&env, &order_id)
    }

    /// Pay an existing merchant-authoritative pending quote.
    ///
    /// The caller still supplies token/buyer/order/amount because those fields
    /// are useful transaction intent inputs, but every one is checked against
    /// the immutable pending quote before any token transfer is attempted.
    pub fn pay(
        env: Env,
        token: Address,
        buyer: Address,
        order_id: BytesN<32>,
        amount: i128,
    ) -> Result<(), Error> {
        buyer.require_auth();

        let quoted = get_order(&env, &order_id).ok_or(Error::QuoteRequired)?;
        if quoted.status != Status::Pending {
            return Err(Error::OrderAlreadyPaid);
        }

        let expires_at = get_quote_expiry(&env, &order_id).ok_or(Error::QuoteRequired)?;
        if env.ledger().timestamp() >= expires_at {
            return Err(Error::QuoteExpired);
        }
        if quoted.buyer != buyer {
            return Err(Error::BuyerMismatch);
        }
        if quoted.token != token {
            return Err(Error::TokenMismatch);
        }
        if quoted.amount != amount {
            return Err(Error::AmountMismatch);
        }
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        if !is_token_allowed(&env, &token) {
            return Err(Error::TokenNotAllowed);
        }

        let merchant = get_admin(&env)?;
        let token_client = TokenClient::new(&env, &token);

        // Escrow: buyer -> contract. All quote equality/expiry checks above run
        // before this transfer authorization, so hostile inputs cannot move funds.
        token_client.transfer(
            &buyer,
            &MuxedAddress::from(&env.current_contract_address()),
            &amount,
        );

        set_order(
            &env,
            &order_id,
            &Order {
                buyer: quoted.buyer.clone(),
                amount: quoted.amount,
                token: quoted.token.clone(),
                timestamp: env.ledger().timestamp(),
                status: Status::Paid,
            },
        );

        PaymentReceived {
            token: quoted.token,
            buyer: quoted.buyer,
            merchant,
            order_id,
            amount: quoted.amount,
        }
        .publish(&env);

        Ok(())
    }

    /// Release a paid order's escrow to the merchant. Only the merchant can
    /// call this. Once dispatched the order cannot be refunded.
    pub fn dispatch(env: Env, order_id: BytesN<32>) -> Result<(), Error> {
        let merchant = get_admin(&env)?;
        merchant.require_auth();

        let order = get_order(&env, &order_id).ok_or(Error::OrderNotFound)?;
        if order.status != Status::Paid {
            return Err(Error::InvalidOrderStatus);
        }

        let token_client = TokenClient::new(&env, &order.token);
        token_client.transfer(
            &env.current_contract_address(),
            &MuxedAddress::from(&merchant),
            &order.amount,
        );

        set_order(
            &env,
            &order_id,
            &Order {
                status: Status::Shipped,
                timestamp: env.ledger().timestamp(),
                ..order.clone()
            },
        );

        OrderShipped {
            order_id,
            merchant,
            amount: order.amount,
        }
        .publish(&env);

        Ok(())
    }

    /// Refund a paid order's escrow back to the buyer. Only the merchant can
    /// call this. Once refunded the quote/order id cannot be replayed.
    pub fn refund(env: Env, order_id: BytesN<32>) -> Result<(), Error> {
        let merchant = get_admin(&env)?;
        merchant.require_auth();

        let order = get_order(&env, &order_id).ok_or(Error::OrderNotFound)?;
        if order.status != Status::Paid {
            return Err(Error::InvalidOrderStatus);
        }

        let token_client = TokenClient::new(&env, &order.token);
        token_client.transfer(
            &env.current_contract_address(),
            &MuxedAddress::from(&order.buyer),
            &order.amount,
        );

        set_order(
            &env,
            &order_id,
            &Order {
                status: Status::Refunded,
                timestamp: env.ledger().timestamp(),
                ..order.clone()
            },
        );

        OrderRefunded {
            order_id,
            buyer: order.buyer,
            amount: order.amount,
        }
        .publish(&env);

        Ok(())
    }

    /// Read a full order record, if it exists.
    pub fn order(env: Env, order_id: BytesN<32>) -> Option<Order> {
        get_order(&env, &order_id)
    }

    /// Read the lifecycle status of an order, if it exists.
    pub fn status(env: Env, order_id: BytesN<32>) -> Option<Status> {
        get_order(&env, &order_id).map(|order| order.status)
    }

    /// Query whether an order has received funds (Paid or Shipped).
    pub fn is_paid(env: Env, order_id: BytesN<32>) -> bool {
        match get_order(&env, &order_id) {
            Some(order) => order.is_paid(),
            None => false,
        }
    }
}
