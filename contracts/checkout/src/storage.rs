use soroban_sdk::{contracttype, Address, BytesN, Env};

use crate::errors::Error;
use crate::order::Order;

/// TTL policy: keep order/merchant data alive well beyond typical testnet usage.
pub const LEDGER_THRESHOLD: u32 = 1000;
pub const LEDGER_TO_EXTEND_TO: u32 = 10_000;

#[contracttype]
pub enum DataKey {
    /// The merchant wallet that owns the contract and can dispatch/refund.
    Admin,
    /// An order registry entry, keyed by 32-byte order id.
    Order(BytesN<32>),
    /// Expiry for a merchant-authorized pending quote/order.
    OrderExpiry(BytesN<32>),
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

pub fn get_order(env: &Env, order_id: &BytesN<32>) -> Option<Order> {
    let key = DataKey::Order(order_id.clone());
    let order: Option<Order> = env.storage().persistent().get(&key);
    if order.is_some() {
        extend_ttl(env, &key);
    }
    order
}

pub fn set_order(env: &Env, order_id: &BytesN<32>, order: &Order) {
    let key = DataKey::Order(order_id.clone());
    env.storage().persistent().set(&key, order);
    extend_ttl(env, &key);
}

pub fn get_order_expiry(env: &Env, order_id: &BytesN<32>) -> Option<u64> {
    let key = DataKey::OrderExpiry(order_id.clone());
    let expiry: Option<u64> = env.storage().persistent().get(&key);
    if expiry.is_some() {
        extend_ttl(env, &key);
    }
    expiry
}

pub fn set_order_expiry(env: &Env, order_id: &BytesN<32>, expires_at: u64) {
    let key = DataKey::OrderExpiry(order_id.clone());
    env.storage().persistent().set(&key, &expires_at);
    extend_ttl(env, &key);
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
