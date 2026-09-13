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
    get_admin, get_order, get_quote_signer, has_admin, is_token_allowed, set_admin, set_order,
    set_quote_signer, set_token_allowed,
};

/// Compatibility lifetime for merchant-created orders which do not provide an
/// explicit expiry. The storefront uses `create_quote` with an explicit server
/// expiry; `create_order` remains an admin API for other integrations.
pub const DEFAULT_QUOTE_TTL_SECONDS: u64 = 600;

#[contract]
pub struct Checkout;

fn store_pending_quote(
    env: &Env,
    buyer: Address,
    order_id: BytesN<32>,
    token: Address,
    amount: i128,
    expires_at: u64,
) -> Result<(), Error> {
    if amount <= 0 {
        return Err(Error::InvalidAmount);
    }
    if !is_token_allowed(env, &token) {
        return Err(Error::TokenNotAllowed);
    }
    if get_order(env, &order_id).is_some() {
        return Err(Error::OrderAlreadyExists);
    }

    let timestamp = env.ledger().timestamp();
    if expires_at <= timestamp {
        return Err(Error::QuoteExpired);
    }

    let order = Order {
        buyer: buyer.clone(),
        amount,
        token: token.clone(),
        timestamp,
        expires_at,
        status: Status::Pending,
    };
    set_order(env, &order_id, &order);

    OrderCreated {
        token,
        buyer,
        order_id,
        amount,
        timestamp,
        expires_at,
    }
    .publish(env);

    Ok(())
}

#[contractimpl]
impl Checkout {
    /// Initialize the contract with the merchant's Stellar public key.
    /// The merchant address must authorize this call (deployer signs).
    ///
    /// The merchant is also the initial quote signer. Production deployments
    /// should rotate quote signing to a dedicated server account via
    /// `set_quote_signer`, keeping the escrow/admin wallet out of the web tier.
    pub fn initialize(env: Env, merchant: Address) -> Result<(), Error> {
        if has_admin(&env) {
            return Err(Error::AlreadyInitialized);
        }
        merchant.require_auth();
        set_admin(&env, &merchant);
        set_quote_signer(&env, &merchant);
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

    /// Rotate the account allowed to register merchant-authoritative quotes.
    /// Only the merchant/admin can authorize rotation.
    pub fn set_quote_signer(env: Env, new_signer: Address) -> Result<(), Error> {
        let admin = get_admin(&env)?;
        admin.require_auth();
        set_quote_signer(&env, &new_signer);
        Ok(())
    }

    /// Read the account currently authorized to register pending quotes.
    pub fn quote_signer(env: Env) -> Result<Address, Error> {
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

    /// Register a pending order with the default quote lifetime. This is a
    /// merchant-authorized compatibility API; buyers cannot self-price it.
    pub fn create_order(
        env: Env,
        buyer: Address,
        order_id: BytesN<32>,
        token: Address,
        amount: i128,
    ) -> Result<(), Error> {
        let signer = get_quote_signer(&env)?;
        signer.require_auth();
        let expires_at = env
            .ledger()
            .timestamp()
            .saturating_add(DEFAULT_QUOTE_TTL_SECONDS);
        store_pending_quote(&env, buyer, order_id, token, amount, expires_at)
    }

    /// Register a server/catalog-derived quote with an explicit expiry.
    ///
    /// The configured quote signer must authorize this call. The signer is set
    /// by the merchant, so browser-controlled price/total fields cannot create
    /// payable state without trusted merchant authorization.
    pub fn create_quote(
        env: Env,
        buyer: Address,
        order_id: BytesN<32>,
        token: Address,
        amount: i128,
        expires_at: u64,
    ) -> Result<(), Error> {
        let signer = get_quote_signer(&env)?;
        signer.require_auth();
        store_pending_quote(&env, buyer, order_id, token, amount, expires_at)
    }

    /// Pay an existing merchant-authorized pending quote. The buyer authorizes
    /// the token transfer; buyer, token, amount, order id and expiry are bound
    /// by the pending quote and cannot be replaced by payment input.
    pub fn pay(
        env: Env,
        token: Address,
        buyer: Address,
        order_id: BytesN<32>,
        amount: i128,
    ) -> Result<(), Error> {
        buyer.require_auth();

        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }

        let existing = get_order(&env, &order_id).ok_or(Error::OrderNotFound)?;
        if existing.status != Status::Pending {
            return Err(Error::OrderAlreadyPaid);
        }
        if env.ledger().timestamp() >= existing.expires_at {
            return Err(Error::QuoteExpired);
        }
        if existing.buyer != buyer || existing.token != token || existing.amount != amount {
            return Err(Error::QuoteMismatch);
        }
        if !is_token_allowed(&env, &token) {
            return Err(Error::TokenNotAllowed);
        }

        let merchant = get_admin(&env)?;
        let token_client = TokenClient::new(&env, &token);

        // Escrow: buyer -> contract. No order state is mutated before the
        // exact quote checks and token transfer succeed.
        token_client.transfer(
            &buyer,
            &MuxedAddress::from(&env.current_contract_address()),
            &amount,
        );

        set_order(
            &env,
            &order_id,
            &Order {
                status: Status::Paid,
                timestamp: env.ledger().timestamp(),
                ..existing.clone()
            },
        );

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
