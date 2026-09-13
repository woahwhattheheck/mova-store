#![no_std]

mod errors;
mod events;
mod order;
mod storage;
mod test;

use soroban_sdk::token::TokenClient;
use soroban_sdk::{contract, contractimpl, Address, BytesN, Env, MuxedAddress};

use crate::errors::Error;
use crate::events::{OrderCreated, OrderRefunded, OrderShipped, PaymentReceived};
use crate::order::{Order, Status};
use crate::storage::{
    get_admin, get_order, get_order_expiry, has_admin, is_token_allowed, set_admin, set_order,
    set_order_expiry, set_token_allowed,
};

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

    /// Register a merchant-authorized pending quote/order.
    ///
    /// The merchant, not the buyer, authorizes the immutable payment terms.
    /// A buyer cannot self-price an order by calling this entrypoint because
    /// the configured merchant address must authorize every creation.
    ///
    /// * `buyer`      - the only address permitted to fund the quote.
    /// * `order_id`   - unique 32-byte quote/order identifier.
    /// * `token`      - exact SEP-41 token contract the merchant quoted.
    /// * `amount`     - exact raw token amount the merchant quoted.
    /// * `expires_at` - ledger timestamp after which payment is rejected.
    ///
    /// Emits `create_order`. No funds move until `pay` is called.
    pub fn create_order(
        env: Env,
        buyer: Address,
        order_id: BytesN<32>,
        token: Address,
        amount: i128,
        expires_at: u64,
    ) -> Result<(), Error> {
        let merchant = get_admin(&env)?;
        merchant.require_auth();

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
        if expires_at <= timestamp {
            return Err(Error::InvalidExpiry);
        }

        let order = Order {
            buyer: buyer.clone(),
            amount,
            token: token.clone(),
            timestamp,
            status: Status::Pending,
        };
        set_order(&env, &order_id, &order);
        set_order_expiry(&env, &order_id, expires_at);

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

    /// Read the immutable expiry of a merchant-authorized pending quote/order.
    /// Existing records from before quote enforcement have no expiry and are
    /// therefore not payable through the strict `pay` path.
    pub fn expires_at(env: Env, order_id: BytesN<32>) -> Option<u64> {
        get_order_expiry(&env, &order_id)
    }

    /// Pay a merchant-authorized pending order. The buyer authorizes transfer.
    ///
    /// The supplied buyer, token and amount must exactly equal the immutable
    /// pending quote. Missing, expired, mismatched and replayed orders fail
    /// before any token transfer is attempted.
    pub fn pay(
        env: Env,
        token: Address,
        buyer: Address,
        order_id: BytesN<32>,
        amount: i128,
    ) -> Result<(), Error> {
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }

        let order = get_order(&env, &order_id).ok_or(Error::OrderNotFound)?;
        if order.status != Status::Pending {
            return Err(Error::OrderAlreadyPaid);
        }

        let expires_at = get_order_expiry(&env, &order_id).ok_or(Error::OrderNotFound)?;
        if env.ledger().timestamp() >= expires_at {
            return Err(Error::QuoteExpired);
        }

        if order.buyer != buyer || order.token != token || order.amount != amount {
            return Err(Error::QuoteMismatch);
        }
        if !is_token_allowed(&env, &token) {
            return Err(Error::TokenNotAllowed);
        }

        buyer.require_auth();
        let merchant = get_admin(&env)?;
        let token_client = TokenClient::new(&env, &order.token);

        // Escrow the exact merchant-quoted amount. The stored quote, not caller
        // input, is the source of truth for the transfer and paid record.
        token_client.transfer(
            &order.buyer,
            &MuxedAddress::from(&env.current_contract_address()),
            &order.amount,
        );

        set_order(
            &env,
            &order_id,
            &Order {
                timestamp: env.ledger().timestamp(),
                status: Status::Paid,
                ..order.clone()
            },
        );

        PaymentReceived {
            token: order.token.clone(),
            buyer: order.buyer.clone(),
            merchant: merchant.clone(),
            order_id: order_id.clone(),
            amount: order.amount,
        }
        .publish(&env);

        Ok(())
    }

    /// Release a paid order's escrow to the merchant. Only the merchant can
    /// call this. Once dispatched the order cannot be refunded.
    ///
    /// Emits `dispatch`.
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
    ///
    /// Emits `refund`.
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
