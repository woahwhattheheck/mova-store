#![no_std]

mod errors;
mod events;
mod order;
mod storage;
mod test;

use soroban_sdk::token::TokenClient;
use soroban_sdk::xdr::ToXdr;
use soroban_sdk::{contract, contractimpl, Address, Bytes, BytesN, Env, MuxedAddress};

use crate::errors::Error;
use crate::events::{OrderCreated, OrderRefunded, OrderShipped, PaymentReceived};
use crate::order::{Order, Status};
use crate::storage::{
    get_admin, get_order, get_quote_signer, has_admin, is_token_allowed, set_admin, set_order,
    set_quote_signer as store_quote_signer, set_token_allowed,
};

const QUOTE_DOMAIN: &[u8] = b"MOVA_STORE_CHECKOUT_QUOTE_V1";

/// Canonical byte string signed by the dedicated checkout quote key.
///
/// The contract address is included so a quote cannot be replayed into a
/// different deployment that happens to trust the same signer. Every field is
/// serialized as a Soroban ScVal XDR value in a fixed order so the server can
/// reproduce the exact bytes with stellar-sdk.
pub(crate) fn build_quote_message(
    env: &Env,
    contract_id: &Address,
    token: &Address,
    buyer: &Address,
    order_id: &BytesN<32>,
    amount: i128,
    expires_at: u64,
) -> Bytes {
    let mut message = Bytes::from_slice(env, QUOTE_DOMAIN);
    message.append(&contract_id.clone().to_xdr(env));
    message.append(&order_id.clone().to_xdr(env));
    message.append(&buyer.clone().to_xdr(env));
    message.append(&token.clone().to_xdr(env));
    message.append(&amount.to_xdr(env));
    message.append(&expires_at.to_xdr(env));
    message
}

#[contract]
pub struct Checkout;

#[contractimpl]
impl Checkout {
    /// Initialize the contract with the merchant's Stellar public key.
    /// The merchant address must authorize this call (deployer signs).
    pub fn initialize(env: Env, merchant: Address) -> Result<(), Error> {
        if has_admin(&env) {
            return Err(Error::AlreadyInitialized);
        }
        merchant.require_auth();
        set_admin(&env, &merchant);
        Ok(())
    }

    /// Change the merchant wallet that owns the contract.
    /// Only the current merchant can authorize this.
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

    /// Configure a dedicated Ed25519 key that may authorize catalog prices.
    ///
    /// This key is intentionally separate from the merchant/admin address. It
    /// can authorize only the exact quote bytes checked by `pay_with_quote`;
    /// it cannot dispatch/refund funds, rotate the merchant, or manage tokens.
    pub fn set_quote_signer(env: Env, signer: BytesN<32>) -> Result<(), Error> {
        let admin = get_admin(&env)?;
        admin.require_auth();
        store_quote_signer(&env, &signer);
        Ok(())
    }

    /// Read the configured checkout quote signer public key.
    pub fn quote_signer(env: Env) -> Result<BytesN<32>, Error> {
        get_quote_signer(&env)
    }

    /// Approve a SEP-41 token contract for payments. Only the merchant can
    /// call this. Every accepted token (USDC, native XLM via its Stellar
    /// Asset Contract, ...) must be whitelisted before it can fund orders.
    pub fn add_token(env: Env, token: Address) -> Result<(), Error> {
        let admin = get_admin(&env)?;
        admin.require_auth();
        set_token_allowed(&env, &token, true);
        Ok(())
    }

    /// Remove a token from the approved list. Only the merchant can call this.
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

    /// Register a buyer's intent to fund an order. The buyer authorizes this.
    ///
    /// A pending order is not price authority. Only a valid merchant quote
    /// passed to `pay_with_quote` can move funds or mark the order paid.
    pub fn create_order(
        env: Env,
        buyer: Address,
        order_id: BytesN<32>,
        token: Address,
        amount: i128,
    ) -> Result<(), Error> {
        buyer.require_auth();

        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        if !is_token_allowed(&env, &token) {
            return Err(Error::TokenNotAllowed);
        }
        if get_order(&env, &order_id).is_some() {
            return Err(Error::OrderAlreadyPaid);
        }

        let timestamp = env.ledger().timestamp();
        let order = Order {
            buyer: buyer.clone(),
            amount,
            token: token.clone(),
            timestamp,
            status: Status::Pending,
        };
        set_order(&env, &order_id, &order);

        OrderCreated {
            token,
            buyer,
            order_id,
            amount,
            timestamp,
        }
        .publish(&env);

        Ok(())
    }

    /// Legacy unquoted payment entry point.
    ///
    /// Kept in the ABI so an older client fails closed instead of silently
    /// paying a buyer-controlled amount. No funds can move through this path.
    pub fn pay(
        env: Env,
        token: Address,
        buyer: Address,
        _order_id: BytesN<32>,
        amount: i128,
    ) -> Result<(), Error> {
        buyer.require_auth();
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        if !is_token_allowed(&env, &token) {
            return Err(Error::TokenNotAllowed);
        }
        Err(Error::QuoteRequired)
    }

    /// Pay an exact, short-lived merchant-authorized quote.
    ///
    /// The quote signature covers this contract deployment, order id, buyer,
    /// token, raw amount, and expiry. The buyer still authorizes the token
    /// transfer; the dedicated quote signer authorizes only the catalog terms.
    pub fn pay_with_quote(
        env: Env,
        token: Address,
        buyer: Address,
        order_id: BytesN<32>,
        amount: i128,
        expires_at: u64,
        quote_signature: BytesN<64>,
    ) -> Result<(), Error> {
        buyer.require_auth();

        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        if !is_token_allowed(&env, &token) {
            return Err(Error::TokenNotAllowed);
        }
        if expires_at <= env.ledger().timestamp() {
            return Err(Error::QuoteExpired);
        }

        if let Some(existing) = get_order(&env, &order_id) {
            if existing.status != Status::Pending {
                return Err(Error::OrderAlreadyPaid);
            }
        }

        let signer = get_quote_signer(&env)?;
        let contract_id = env.current_contract_address();
        let message = build_quote_message(
            &env,
            &contract_id,
            &token,
            &buyer,
            &order_id,
            amount,
            expires_at,
        );
        env.crypto()
            .ed25519_verify(&signer, &message, &quote_signature);

        let merchant = get_admin(&env)?;
        let token_client = TokenClient::new(&env, &token);

        // Escrow: buyer -> contract. The contract's own authorization on the
        // transfer is derived from this invocation (it holds the funds).
        token_client.transfer(
            &buyer,
            &MuxedAddress::from(&contract_id),
            &amount,
        );

        // A valid quote supersedes any buyer-authored pending intent. The paid
        // record therefore reflects the merchant-authorized terms exactly.
        let order = Order {
            buyer: buyer.clone(),
            amount,
            token: token.clone(),
            timestamp: env.ledger().timestamp(),
            status: Status::Paid,
        };
        set_order(&env, &order_id, &order);

        PaymentReceived {
            token: token.clone(),
            buyer: buyer.clone(),
            merchant: merchant.clone(),
            order_id: order_id.clone(),
            amount,
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
            order_id: order_id.clone(),
            merchant: merchant.clone(),
            amount: order.amount,
        }
        .publish(&env);

        Ok(())
    }

    /// Refund a paid order's escrow back to the buyer. Only the merchant can
    /// call this (e.g. the goods could not be dispatched).
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
            order_id: order_id.clone(),
            buyer: order.buyer.clone(),
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
