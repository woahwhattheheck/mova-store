#![cfg(test)]

use ed25519_dalek::{Signer as _, SigningKey};
use soroban_sdk::testutils::{Address as _, Events, Ledger as _};
use soroban_sdk::token::{StellarAssetClient, TokenClient};
use soroban_sdk::{contract, contractimpl, contracttype, Address, BytesN, Env};

use crate::errors::Error;
use crate::order::Status;
use crate::{build_quote_message, Checkout, CheckoutClient};

const QUOTE_TTL_SECONDS: u64 = 300;

// ---------------------------------------------------------------------------
// Minimal SEP-41-style mock token so tests don't depend on a real token
// contract (SDK 27 testutils no longer bundles a Token mock). The native
// asset path is covered with the real Stellar Asset Contract via
// `register_stellar_asset_contract_v2`.
// ---------------------------------------------------------------------------

#[contracttype]
pub enum MockTokenDataKey {
    Balance(Address),
}

#[contract]
pub struct MockToken;

#[contractimpl]
impl MockToken {
    pub fn mint(env: Env, to: Address, amount: i128) {
        let mut bal: i128 = env
            .storage()
            .persistent()
            .get(&MockTokenDataKey::Balance(to.clone()))
            .unwrap_or(0);
        bal += amount;
        env.storage()
            .persistent()
            .set(&MockTokenDataKey::Balance(to), &bal);
    }

    pub fn balance(env: Env, id: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&MockTokenDataKey::Balance(id))
            .unwrap_or(0)
    }

    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        let mut from_bal: i128 = env
            .storage()
            .persistent()
            .get(&MockTokenDataKey::Balance(from.clone()))
            .unwrap_or(0);
        let mut to_bal: i128 = env
            .storage()
            .persistent()
            .get(&MockTokenDataKey::Balance(to.clone()))
            .unwrap_or(0);
        from_bal -= amount;
        to_bal += amount;
        env.storage()
            .persistent()
            .set(&MockTokenDataKey::Balance(from), &from_bal);
        env.storage()
            .persistent()
            .set(&MockTokenDataKey::Balance(to), &to_bal);
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn order_id(env: &Env, byte: u8) -> BytesN<32> {
    BytesN::from_array(env, &[byte; 32])
}

fn quote_signing_key() -> SigningKey {
    SigningKey::from_bytes(&[7u8; 32])
}

fn quote_public_key(env: &Env) -> BytesN<32> {
    BytesN::from_array(env, &quote_signing_key().verifying_key().to_bytes())
}

fn quote_signature(
    env: &Env,
    checkout: &Address,
    token: &Address,
    buyer: &Address,
    id: &BytesN<32>,
    amount: i128,
    expires_at: u64,
) -> BytesN<64> {
    let message = build_quote_message(env, checkout, token, buyer, id, amount, expires_at);
    let signature = quote_signing_key().sign(&message.to_alloc_vec());
    BytesN::from_array(env, &signature.to_bytes())
}

fn pay_quoted(
    env: &Env,
    client: &CheckoutClient<'_>,
    checkout: &Address,
    token: &Address,
    buyer: &Address,
    id: &BytesN<32>,
    amount: i128,
) {
    let expires_at = env.ledger().timestamp() + QUOTE_TTL_SECONDS;
    let signature = quote_signature(env, checkout, token, buyer, id, amount, expires_at);
    client.pay_with_quote(token, buyer, id, &amount, &expires_at, &signature);
}

/// Register the checkout contract, a mock USDC token, initialize with the
/// merchant, configure the dedicated quote signer, whitelist the token, and
/// fund the buyer.
fn setup_usdc(env: &Env) -> (CheckoutClient<'_>, Address, Address, Address, Address) {
    let token = env.register(MockToken, ());
    let contract = env.register(Checkout, ());
    let merchant = Address::generate(env);
    let buyer = Address::generate(env);

    let client = CheckoutClient::new(env, &contract);
    client.initialize(&merchant);
    client.set_quote_signer(&quote_public_key(env));
    client.add_token(&token);
    MockTokenClient::new(env, &token).mint(&buyer, &1_000_000);

    (client, token, merchant, buyer, contract)
}

fn usdc_balance(env: &Env, token: &Address, address: &Address) -> i128 {
    MockTokenClient::new(env, token).balance(address)
}

// ---------------------------------------------------------------------------
// Core escrow lifecycle
// ---------------------------------------------------------------------------

#[test]
fn test_pay_escrows_then_dispatch_releases_to_merchant() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, token, merchant, buyer, checkout) = setup_usdc(&env);
    let id = order_id(&env, 7);
    pay_quoted(&env, &client, &checkout, &token, &buyer, &id, 100_000);

    assert_eq!(usdc_balance(&env, &token, &buyer), 900_000);
    assert_eq!(usdc_balance(&env, &token, &checkout), 100_000);
    assert_eq!(usdc_balance(&env, &token, &merchant), 0);
    assert!(client.is_paid(&id));
    assert_eq!(client.status(&id), Some(Status::Paid));

    client.dispatch(&id);
    assert_eq!(usdc_balance(&env, &token, &checkout), 0);
    assert_eq!(usdc_balance(&env, &token, &merchant), 100_000);
    assert_eq!(client.status(&id), Some(Status::Shipped));
    assert!(client.is_paid(&id));
}

#[test]
fn test_refund_returns_escrow_to_buyer() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, token, _, buyer, checkout) = setup_usdc(&env);
    let id = order_id(&env, 8);
    pay_quoted(&env, &client, &checkout, &token, &buyer, &id, 100_000);
    assert_eq!(usdc_balance(&env, &token, &checkout), 100_000);

    client.refund(&id);
    assert_eq!(usdc_balance(&env, &token, &checkout), 0);
    assert_eq!(usdc_balance(&env, &token, &buyer), 1_000_000);
    assert_eq!(client.status(&id), Some(Status::Refunded));
}

#[test]
fn test_refund_after_dispatch_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, token, _, buyer, checkout) = setup_usdc(&env);
    let id = order_id(&env, 11);
    pay_quoted(&env, &client, &checkout, &token, &buyer, &id, 10_000);
    client.dispatch(&id);

    let result = client.try_refund(&id);
    assert_eq!(result, Err(Ok(Error::InvalidOrderStatus)));
}

#[test]
fn test_dispatch_pending_order_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, token, _, buyer, _) = setup_usdc(&env);
    let id = order_id(&env, 12);
    client.create_order(&buyer, &id, &token, &10_000);

    let result = client.try_dispatch(&id);
    assert_eq!(result, Err(Ok(Error::InvalidOrderStatus)));
}

#[test]
fn test_dispatch_unknown_order_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _, _, _, _) = setup_usdc(&env);
    let result = client.try_dispatch(&order_id(&env, 99));
    assert_eq!(result, Err(Ok(Error::OrderNotFound)));
}

// ---------------------------------------------------------------------------
// Merchant-authoritative quote guards
// ---------------------------------------------------------------------------

#[test]
fn test_unquoted_pay_fails_closed() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, token, _, buyer, _) = setup_usdc(&env);
    let id = order_id(&env, 30);

    let result = client.try_pay(&token, &buyer, &id, &50_000);
    assert_eq!(result, Err(Ok(Error::QuoteRequired)));
    assert_eq!(usdc_balance(&env, &token, &buyer), 1_000_000);
}

#[test]
fn test_quote_signer_is_required() {
    let env = Env::default();
    env.mock_all_auths();
    let token = env.register(MockToken, ());
    let checkout = env.register(Checkout, ());
    let merchant = Address::generate(&env);
    let buyer = Address::generate(&env);
    let client = CheckoutClient::new(&env, &checkout);
    client.initialize(&merchant);
    client.add_token(&token);
    MockTokenClient::new(&env, &token).mint(&buyer, &1_000_000);

    let id = order_id(&env, 31);
    let amount = 50_000;
    let expires_at = env.ledger().timestamp() + QUOTE_TTL_SECONDS;
    let signature = quote_signature(&env, &checkout, &token, &buyer, &id, amount, expires_at);
    let result = client.try_pay_with_quote(
        &token,
        &buyer,
        &id,
        &amount,
        &expires_at,
        &signature,
    );
    assert_eq!(result, Err(Ok(Error::QuoteSignerNotConfigured)));
}

#[test]
fn test_expired_quote_is_rejected_without_transfer() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let (client, token, _, buyer, checkout) = setup_usdc(&env);
    let id = order_id(&env, 32);
    let amount = 50_000;
    let expires_at = 999;
    let signature = quote_signature(&env, &checkout, &token, &buyer, &id, amount, expires_at);

    let result = client.try_pay_with_quote(
        &token,
        &buyer,
        &id,
        &amount,
        &expires_at,
        &signature,
    );
    assert_eq!(result, Err(Ok(Error::QuoteExpired)));
    assert_eq!(usdc_balance(&env, &token, &buyer), 1_000_000);
}

#[test]
fn test_tampered_amount_invalidates_quote() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, token, _, buyer, checkout) = setup_usdc(&env);
    let id = order_id(&env, 33);
    let quoted_amount = 50_000;
    let tampered_amount = 1;
    let expires_at = env.ledger().timestamp() + QUOTE_TTL_SECONDS;
    let signature = quote_signature(
        &env,
        &checkout,
        &token,
        &buyer,
        &id,
        quoted_amount,
        expires_at,
    );

    let result = client.try_pay_with_quote(
        &token,
        &buyer,
        &id,
        &tampered_amount,
        &expires_at,
        &signature,
    );
    assert!(result.is_err());
    assert_eq!(usdc_balance(&env, &token, &buyer), 1_000_000);
}

#[test]
fn test_tampered_token_invalidates_quote() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, token, _, buyer, checkout) = setup_usdc(&env);
    let other_token = env.register(MockToken, ());
    client.add_token(&other_token);
    MockTokenClient::new(&env, &other_token).mint(&buyer, &1_000_000);
    let id = order_id(&env, 34);
    let amount = 50_000;
    let expires_at = env.ledger().timestamp() + QUOTE_TTL_SECONDS;
    let signature = quote_signature(&env, &checkout, &token, &buyer, &id, amount, expires_at);

    let result = client.try_pay_with_quote(
        &other_token,
        &buyer,
        &id,
        &amount,
        &expires_at,
        &signature,
    );
    assert!(result.is_err());
    assert_eq!(usdc_balance(&env, &other_token, &buyer), 1_000_000);
}

#[test]
fn test_tampered_buyer_invalidates_quote() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, token, _, buyer, checkout) = setup_usdc(&env);
    let other_buyer = Address::generate(&env);
    MockTokenClient::new(&env, &token).mint(&other_buyer, &1_000_000);
    let id = order_id(&env, 35);
    let amount = 50_000;
    let expires_at = env.ledger().timestamp() + QUOTE_TTL_SECONDS;
    let signature = quote_signature(&env, &checkout, &token, &buyer, &id, amount, expires_at);

    let result = client.try_pay_with_quote(
        &token,
        &other_buyer,
        &id,
        &amount,
        &expires_at,
        &signature,
    );
    assert!(result.is_err());
    assert_eq!(usdc_balance(&env, &token, &other_buyer), 1_000_000);
}

#[test]
fn test_signed_quote_overrides_buyer_pending_price_intent() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, token, _, buyer, checkout) = setup_usdc(&env);
    let id = order_id(&env, 36);

    client.create_order(&buyer, &id, &token, &1);
    pay_quoted(&env, &client, &checkout, &token, &buyer, &id, 50_000);

    let order = client.order(&id).unwrap();
    assert_eq!(order.amount, 50_000);
    assert_eq!(order.status, Status::Paid);
    assert_eq!(usdc_balance(&env, &token, &buyer), 950_000);
}

// ---------------------------------------------------------------------------
// Order registry
// ---------------------------------------------------------------------------

#[test]
fn test_create_order_then_pay_completes_it() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, token, _, buyer, checkout) = setup_usdc(&env);
    let id = order_id(&env, 13);

    client.create_order(&buyer, &id, &token, &50_000);
    assert_eq!(client.status(&id), Some(Status::Pending));
    assert_eq!(usdc_balance(&env, &token, &buyer), 1_000_000);

    pay_quoted(&env, &client, &checkout, &token, &buyer, &id, 50_000);
    assert_eq!(client.status(&id), Some(Status::Paid));
    assert!(client.is_paid(&id));

    let order = client.order(&id).unwrap();
    assert_eq!(order.buyer, buyer);
    assert_eq!(order.amount, 50_000);
    assert_eq!(order.token, token);
}

#[test]
fn test_create_order_duplicate_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, token, _, buyer, _) = setup_usdc(&env);
    let id = order_id(&env, 14);
    client.create_order(&buyer, &id, &token, &50_000);

    let result = client.try_create_order(&buyer, &id, &token, &50_000);
    assert_eq!(result, Err(Ok(Error::OrderAlreadyPaid)));
}

#[test]
fn test_order_reads() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, token, _, buyer, _) = setup_usdc(&env);
    let id = order_id(&env, 15);
    assert_eq!(client.order(&id), None);
    assert_eq!(client.status(&id), None);
    assert!(!client.is_paid(&id));

    client.create_order(&buyer, &id, &token, &25_000);
    assert_eq!(client.order(&id).unwrap().status, Status::Pending);
}

// ---------------------------------------------------------------------------
// Token whitelist
// ---------------------------------------------------------------------------

#[test]
fn test_token_not_allowed_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let token = env.register(MockToken, ());
    let contract = env.register(Checkout, ());
    let merchant = Address::generate(&env);
    let buyer = Address::generate(&env);

    let client = CheckoutClient::new(&env, &contract);
    client.initialize(&merchant);
    MockTokenClient::new(&env, &token).mint(&buyer, &1_000_000);

    let id = order_id(&env, 16);
    let result = client.try_pay(&token, &buyer, &id, &10_000);
    assert_eq!(result, Err(Ok(Error::TokenNotAllowed)));

    let result = client.try_create_order(&buyer, &id, &token, &10_000);
    assert_eq!(result, Err(Ok(Error::TokenNotAllowed)));
}

#[test]
fn test_remove_token_disables_payments() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, token, _, buyer, _) = setup_usdc(&env);
    client.remove_token(&token);
    assert!(!client.is_token_allowed(&token));

    let id = order_id(&env, 17);
    let result = client.try_pay(&token, &buyer, &id, &10_000);
    assert_eq!(result, Err(Ok(Error::TokenNotAllowed)));
}

#[test]
fn test_add_token_after_initialize() {
    let env = Env::default();
    env.mock_all_auths();

    let token = env.register(MockToken, ());
    let contract = env.register(Checkout, ());
    let merchant = Address::generate(&env);

    let client = CheckoutClient::new(&env, &contract);
    client.initialize(&merchant);
    assert!(!client.is_token_allowed(&token));

    client.add_token(&token);
    assert!(client.is_token_allowed(&token));
}

// ---------------------------------------------------------------------------
// Native XLM via the real Stellar Asset Contract
// ---------------------------------------------------------------------------

#[test]
fn test_native_asset_payment_and_dispatch() {
    let env = Env::default();
    env.mock_all_auths();

    let issuer = Address::generate(&env);
    let native = env.register_stellar_asset_contract_v2(issuer);
    let native_id = native.address();

    let contract = env.register(Checkout, ());
    let merchant = Address::generate(&env);
    let buyer = Address::generate(&env);

    let client = CheckoutClient::new(&env, &contract);
    client.initialize(&merchant);
    client.set_quote_signer(&quote_public_key(&env));
    client.add_token(&native_id);

    StellarAssetClient::new(&env, &native_id).mint(&buyer, &5_000_000);

    let id = order_id(&env, 21);
    pay_quoted(&env, &client, &contract, &native_id, &buyer, &id, 100_000);

    let native_client = TokenClient::new(&env, &native_id);
    assert_eq!(native_client.balance(&buyer), 4_900_000);
    assert_eq!(native_client.balance(&contract), 100_000);
    assert_eq!(native_client.balance(&merchant), 0);

    client.dispatch(&id);
    assert_eq!(native_client.balance(&contract), 0);
    assert_eq!(native_client.balance(&merchant), 100_000);
    assert_eq!(client.status(&id), Some(Status::Shipped));
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

#[test]
fn test_duplicate_order_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, token, _, buyer, checkout) = setup_usdc(&env);
    let id = order_id(&env, 9);
    pay_quoted(&env, &client, &checkout, &token, &buyer, &id, 50_000);

    let expires_at = env.ledger().timestamp() + QUOTE_TTL_SECONDS;
    let signature = quote_signature(&env, &checkout, &token, &buyer, &id, 50_000, expires_at);
    let result = client.try_pay_with_quote(
        &token,
        &buyer,
        &id,
        &50_000,
        &expires_at,
        &signature,
    );
    assert_eq!(result, Err(Ok(Error::OrderAlreadyPaid)));
}

#[test]
fn test_duplicate_pay_after_dispatch_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, token, _, buyer, checkout) = setup_usdc(&env);
    let id = order_id(&env, 10);
    pay_quoted(&env, &client, &checkout, &token, &buyer, &id, 50_000);
    client.dispatch(&id);

    let expires_at = env.ledger().timestamp() + QUOTE_TTL_SECONDS;
    let signature = quote_signature(&env, &checkout, &token, &buyer, &id, 50_000, expires_at);
    let result = client.try_pay_with_quote(
        &token,
        &buyer,
        &id,
        &50_000,
        &expires_at,
        &signature,
    );
    assert_eq!(result, Err(Ok(Error::OrderAlreadyPaid)));
}

#[test]
fn test_pay_without_initialize() {
    let env = Env::default();
    env.mock_all_auths();

    let token = env.register(MockToken, ());
    let contract = env.register(Checkout, ());
    let buyer = Address::generate(&env);

    let client = CheckoutClient::new(&env, &contract);
    let id = order_id(&env, 1);

    let result = client.try_pay(&token, &buyer, &id, &1000);
    assert_eq!(result, Err(Ok(Error::TokenNotAllowed)));

    let result = client.try_dispatch(&id);
    assert_eq!(result, Err(Ok(Error::NotInitialized)));
}

#[test]
fn test_non_positive_amount_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, token, _, buyer, _) = setup_usdc(&env);
    let id = order_id(&env, 2);

    let result = client.try_pay(&token, &buyer, &id, &0);
    assert_eq!(result, Err(Ok(Error::InvalidAmount)));

    let result = client.try_create_order(&buyer, &id, &token, &-1);
    assert_eq!(result, Err(Ok(Error::InvalidAmount)));
}

#[test]
fn test_initialize_twice_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let contract = env.register(Checkout, ());
    let merchant = Address::generate(&env);
    let other = Address::generate(&env);

    let client = CheckoutClient::new(&env, &contract);
    client.initialize(&merchant);

    let result = client.try_initialize(&other);
    assert_eq!(result, Err(Ok(Error::AlreadyInitialized)));
}

#[test]
fn test_set_merchant_changes_escrow_destination() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, token, _, buyer, checkout) = setup_usdc(&env);
    let new_merchant = Address::generate(&env);
    client.set_merchant(&new_merchant);

    let id = order_id(&env, 3);
    pay_quoted(&env, &client, &checkout, &token, &buyer, &id, 10_000);

    assert_eq!(usdc_balance(&env, &token, &new_merchant), 0);
    assert_eq!(usdc_balance(&env, &token, &checkout), 10_000);
    assert_eq!(client.merchant(), new_merchant);

    client.dispatch(&id);
    assert_eq!(usdc_balance(&env, &token, &new_merchant), 10_000);
}

#[test]
fn test_events_emitted() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, token, _, buyer, checkout) = setup_usdc(&env);
    let id = order_id(&env, 5);

    client.create_order(&buyer, &id, &token, &10_000);
    pay_quoted(&env, &client, &checkout, &token, &buyer, &id, 10_000);
    client.dispatch(&id);

    let events = env.events().all().filter_by_contract(&checkout);
    assert!(
        !events.events().is_empty(),
        "expected contract events for create/pay/dispatch"
    );
}
