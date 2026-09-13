use soroban_sdk::{contracttype, Address, BytesN, Env};

use crate::errors::Error;
use crate::order::Order;

/// TTL policy: keep order/merchant/catalog data alive well beyond typical testnet usage.
pub const LEDGER_THRESHOLD: u32 = 1000;
pub const LEDGER_TO_EXTEND_TO: u32 = 10_000;

#[contracttype]
#[derive(Clone)]
pub struct ProductPriceKey {
    pub product_id: BytesN<32>,
    pub token: Address,
}

#[contracttype]
pub enum DataKey {
    /// The merchant wallet that owns the contract and can dispatch/refund.
    Admin,
    /// An order registry entry, keyed by 32-byte order id.
    Order(BytesN<32>),
    /// Expiry timestamp for a merchant-authoritative pending quote.
    QuoteExpiry(BytesN<32>),
    /// Whether the given SEP-41 token contract is accepted by the merchant.
    TokenAllowed(Address),
    /// Merchant-authoritative unit price for a product/token pair.
    ProductPrice(ProductPriceKey),
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

pub fn get_quote_expiry(env: &Env, order_id: &BytesN<32>) -> Option<u64> {
    let key = DataKey::QuoteExpiry(order_id.clone());
    let expiry: Option<u64> = env.storage().persistent().get(&key);
    if expiry.is_some() {
        extend_ttl(env, &key);
    }
    expiry
}

pub fn set_quote_expiry(env: &Env, order_id: &BytesN<32>, expires_at: u64) {
    let key = DataKey::QuoteExpiry(order_id.clone());
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
        extend_ttl(env, &key);
    } else {
        env.storage().persistent().remove(&key);
    }
}

fn product_price_key(product_id: &BytesN<32>, token: &Address) -> DataKey {
    DataKey::ProductPrice(ProductPriceKey {
        product_id: product_id.clone(),
        token: token.clone(),
    })
}

pub fn get_product_price(env: &Env, product_id: &BytesN<32>, token: &Address) -> Option<i128> {
    let key = product_price_key(product_id, token);
    let price: Option<i128> = env.storage().persistent().get(&key);
    if price.is_some() {
        extend_ttl(env, &key);
    }
    price
}

pub fn set_product_price(env: &Env, product_id: &BytesN<32>, token: &Address, price: i128) {
    let key = product_price_key(product_id, token);
    env.storage().persistent().set(&key, &price);
    extend_ttl(env, &key);
}

pub fn remove_product_price(env: &Env, product_id: &BytesN<32>, token: &Address) {
    env.storage()
        .persistent()
        .remove(&product_price_key(product_id, token));
}

pub fn extend_ttl(env: &Env, key: &DataKey) {
    env.storage()
        .persistent()
        .extend_ttl(key, LEDGER_THRESHOLD, LEDGER_TO_EXTEND_TO);
}
