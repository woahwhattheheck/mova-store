use soroban_sdk::{contracttype, Address, BytesN, Env};

use crate::errors::Error;
use crate::order::Order;
use crate::quote::QuoteAuth;

/// TTL policy: keep order/merchant data alive well beyond typical testnet usage.
pub const LEDGER_THRESHOLD: u32 = 1000;
pub const LEDGER_TO_EXTEND_TO: u32 = 10_000;

#[contracttype]
pub enum DataKey {
    /// The merchant wallet that owns the contract and can dispatch/refund.
    Admin,
    /// Ed25519 public key that authorizes canonical merchant quotes.
    QuoteSigner,
    /// An order registry entry, keyed by 32-byte order id.
    Order(BytesN<32>),
    /// Short-lived merchant quote authorization for one pending order.
    QuoteAuth(BytesN<32>),
    /// Whether the given SEP-41 token contract is accepted by the merchant.
    TokenAllowed(Address),
}

pub fn has_admin(env: &Env) -> bool {
    env.storage().persistent().has(&DataKey::Admin)
}

pub fn get_admin(env: &Env) -> Result<Address, Error> {
    let admin: Option<Address> = env.storage().persistent().get(&DataKey::Admin);
    match admin {
        Some(admin) => {
            extend_ttl(env, &DataKey::Admin);
            Ok(admin)
        }
        None => Err(Error::NotInitialized),
    }
}

pub fn set_admin(env: &Env, admin: &Address) {
    env.storage().persistent().set(&DataKey::Admin, admin);
    extend_ttl(env, &DataKey::Admin);
}

pub fn get_quote_signer(env: &Env) -> Result<BytesN<32>, Error> {
    let signer: Option<BytesN<32>> = env.storage().persistent().get(&DataKey::QuoteSigner);
    match signer {
        Some(signer) => {
            extend_ttl(env, &DataKey::QuoteSigner);
            Ok(signer)
        }
        None => Err(Error::QuoteSignerNotSet),
    }
}

pub fn set_quote_signer(env: &Env, signer: &BytesN<32>) {
    env.storage().persistent().set(&DataKey::QuoteSigner, signer);
    extend_ttl(env, &DataKey::QuoteSigner);
}

pub fn get_order(env: &Env, order_id: &BytesN<32>) -> Option<Order> {
    let order: Option<Order> = env.storage().persistent().get(&DataKey::Order(order_id.clone()));
    if order.is_some() {
        extend_ttl(env, &DataKey::Order(order_id.clone()));
    }
    order
}

pub fn set_order(env: &Env, order_id: &BytesN<32>, order: &Order) {
    env.storage().persistent().set(&DataKey::Order(order_id.clone()), order);
    extend_ttl(env, &DataKey::Order(order_id.clone()));
}

pub fn get_quote_auth(env: &Env, order_id: &BytesN<32>) -> Option<QuoteAuth> {
    let key = DataKey::QuoteAuth(order_id.clone());
    let quote: Option<QuoteAuth> = env.storage().persistent().get(&key);
    if quote.is_some() {
        extend_ttl(env, &key);
    }
    quote
}

pub fn set_quote_auth(env: &Env, order_id: &BytesN<32>, quote: &QuoteAuth) {
    let key = DataKey::QuoteAuth(order_id.clone());
    env.storage().persistent().set(&key, quote);
    extend_ttl(env, &key);
}

pub fn remove_quote_auth(env: &Env, order_id: &BytesN<32>) {
    env.storage()
        .persistent()
        .remove(&DataKey::QuoteAuth(order_id.clone()));
}

pub fn is_token_allowed(env: &Env, token: &Address) -> bool {
    env.storage()
        .persistent()
        .get::<_, bool>(&DataKey::TokenAllowed(token.clone()))
        .unwrap_or(false)
}

pub fn set_token_allowed(env: &Env, token: &Address, allowed: bool) {
    let key = DataKey::TokenAllowed(token.clone());
    if allowed {
        env.storage().persistent().set(&key, &true);
    } else {
        env.storage().persistent().remove(&key);
    }
}

pub fn extend_ttl(env: &Env, key: &DataKey) {
    env.storage()
        .persistent()
        .extend_ttl(key, LEDGER_THRESHOLD, LEDGER_TO_EXTEND_TO);
}
