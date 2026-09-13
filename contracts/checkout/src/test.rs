#![cfg(test)]

use soroban_sdk::testutils::{Address as _, Events, Ledger};
use soroban_sdk::token::{StellarAssetClient, TokenClient};
use soroban_sdk::{contract, contractimpl, contracttype, Address, BytesN, Env};

use crate::errors::Error;
use crate::order::Status;
use crate::{Checkout, CheckoutClient};

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

fn order_id(env: &Env, byte: u8) -> BytesN<32> {
    BytesN::from_array(env, &[byte; 32])
}

fn setup_usdc(env: &Env) -> (CheckoutClient<'_>, Address, Address, Address, Address) {
    let token = env.register(MockToken, ());
    let contract = env.register(Checkout, ());
    let merchant = Address::generate(env);
    let buyer = Address::generate(env);

    let client = CheckoutClient::new(env, &contract);
    client.initialize(&merchant);
    client.add_token(&token);
    MockTokenClient::new(env, &token).mint(&buyer, &1_000_000);

    (client, token, merchant, buyer, contract)
}

fn create_quote(
    env: &Env,
    client: &CheckoutClient<'_>,
    buyer: &Address,
    id: &BytesN<32>,
    token: &Address,
    amount: i128,
) -> u64 {
    let expires_at = env.ledger().timestamp() + 300;
    client.create_order(buyer, id, token, &amount, &expires_at);
    expires_at
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
    env.ledger().set_timestamp(1_000);

    let (client, token, merchant, buyer, checkout) = setup_usdc(&env);
    let id = order_id(&env, 7);
    create_quote(&env, &client, &buyer, &id, &token, 100_000);
    client.pay(&token, &buyer, &id, &100_000);

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
    create_quote(&env, &client, &buyer, &id, &token, 100_000);
    client.pay(&token, &buyer, &id, &100_000);
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

    let (client, token, _, buyer, _) = setup_usdc(&env);
    let id = order_id(&env, 11);
    create_quote(&env, &client, &buyer, &id, &token, 10_000);
    client.pay(&token, &buyer, &id, &10_000);
    client.dispatch(&id);

    assert_eq!(client.try_refund(&id), Err(Ok(Error::InvalidOrderStatus)));
}

#[test]
fn test_dispatch_pending_order_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, token, _, buyer, _) = setup_usdc(&env);
    let id = order_id(&env, 12);
    create_quote(&env, &client, &buyer, &id, &token, 10_000);

    assert_eq!(client.try_dispatch(&id), Err(Ok(Error::InvalidOrderStatus)));
}

#[test]
fn test_dispatch_unknown_order_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _, _, _, _) = setup_usdc(&env);
    assert_eq!(
        client.try_dispatch(&order_id(&env, 99)),
        Err(Ok(Error::OrderNotFound))
    );
}

// ---------------------------------------------------------------------------
// Merchant-authorized quote registry
// ---------------------------------------------------------------------------

#[test]
fn test_create_order_then_exact_pay_completes_it() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(500);

    let (client, token, _, buyer, _) = setup_usdc(&env);
    let id = order_id(&env, 13);
    let expiry = create_quote(&env, &client, &buyer, &id, &token, 50_000);

    assert_eq!(client.status(&id), Some(Status::Pending));
    assert_eq!(client.expires_at(&id), Some(expiry));
    assert_eq!(usdc_balance(&env, &token, &buyer), 1_000_000);

    client.pay(&token, &buyer, &id, &50_000);
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
    let expiry = create_quote(&env, &client, &buyer, &id, &token, 50_000);

    let later_expiry = expiry + 300;
    assert_eq!(
        client.try_create_order(&buyer, &id, &token, &50_000, &later_expiry),
        Err(Ok(Error::OrderAlreadyPaid))
    );
}

#[test]
fn test_create_order_rejects_non_future_expiry() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let (client, token, _, buyer, _) = setup_usdc(&env);
    let id = order_id(&env, 18);

    assert_eq!(
        client.try_create_order(&buyer, &id, &token, &10_000, &1_000),
        Err(Ok(Error::InvalidExpiry))
    );
    assert_eq!(client.order(&id), None);
}

#[test]
fn test_order_reads() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, token, _, buyer, _) = setup_usdc(&env);
    let id = order_id(&env, 15);
    assert_eq!(client.order(&id), None);
    assert_eq!(client.expires_at(&id), None);
    assert_eq!(client.status(&id), None);
    assert!(!client.is_paid(&id));

    create_quote(&env, &client, &buyer, &id, &token, 25_000);
    assert_eq!(client.order(&id).unwrap().status, Status::Pending);
}

// ---------------------------------------------------------------------------
// Hostile payment-term tampering
// ---------------------------------------------------------------------------

#[test]
fn test_unquoted_order_rejected_before_transfer() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, token, _, buyer, checkout) = setup_usdc(&env);
    let id = order_id(&env, 30);

    assert_eq!(
        client.try_pay(&token, &buyer, &id, &10_000),
        Err(Ok(Error::OrderNotFound))
    );
    assert_eq!(usdc_balance(&env, &token, &buyer), 1_000_000);
    assert_eq!(usdc_balance(&env, &token, &checkout), 0);
}

#[test]
fn test_wrong_buyer_rejected_before_transfer() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, token, _, buyer, checkout) = setup_usdc(&env);
    let attacker = Address::generate(&env);
    MockTokenClient::new(&env, &token).mint(&attacker, &500_000);
    let id = order_id(&env, 31);
    create_quote(&env, &client, &buyer, &id, &token, 10_000);

    assert_eq!(
        client.try_pay(&token, &attacker, &id, &10_000),
        Err(Ok(Error::QuoteMismatch))
    );
    assert_eq!(usdc_balance(&env, &token, &buyer), 1_000_000);
    assert_eq!(usdc_balance(&env, &token, &attacker), 500_000);
    assert_eq!(usdc_balance(&env, &token, &checkout), 0);
    assert_eq!(client.status(&id), Some(Status::Pending));
}

#[test]
fn test_wrong_token_rejected_before_transfer() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, token, _, buyer, checkout) = setup_usdc(&env);
    let other_token = env.register(MockToken, ());
    client.add_token(&other_token);
    MockTokenClient::new(&env, &other_token).mint(&buyer, &500_000);
    let id = order_id(&env, 32);
    create_quote(&env, &client, &buyer, &id, &token, 10_000);

    assert_eq!(
        client.try_pay(&other_token, &buyer, &id, &10_000),
        Err(Ok(Error::QuoteMismatch))
    );
    assert_eq!(usdc_balance(&env, &token, &checkout), 0);
    assert_eq!(usdc_balance(&env, &other_token, &checkout), 0);
    assert_eq!(client.status(&id), Some(Status::Pending));
}

#[test]
fn test_underpayment_and_overpayment_rejected_before_transfer() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, token, _, buyer, checkout) = setup_usdc(&env);
    let id = order_id(&env, 33);
    create_quote(&env, &client, &buyer, &id, &token, 100_000);

    assert_eq!(
        client.try_pay(&token, &buyer, &id, &99_999),
        Err(Ok(Error::QuoteMismatch))
    );
    assert_eq!(
        client.try_pay(&token, &buyer, &id, &100_001),
        Err(Ok(Error::QuoteMismatch))
    );
    assert_eq!(usdc_balance(&env, &token, &buyer), 1_000_000);
    assert_eq!(usdc_balance(&env, &token, &checkout), 0);
    assert_eq!(client.status(&id), Some(Status::Pending));
}

#[test]
fn test_expired_quote_rejected_before_transfer() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(10_000);

    let (client, token, _, buyer, checkout) = setup_usdc(&env);
    let id = order_id(&env, 34);
    client.create_order(&buyer, &id, &token, &100_000, &10_010);
    env.ledger().set_timestamp(10_010);

    assert_eq!(
        client.try_pay(&token, &buyer, &id, &100_000),
        Err(Ok(Error::QuoteExpired))
    );
    assert_eq!(usdc_balance(&env, &token, &buyer), 1_000_000);
    assert_eq!(usdc_balance(&env, &token, &checkout), 0);
    assert_eq!(client.status(&id), Some(Status::Pending));
}

#[test]
fn test_replay_rejected_after_exact_payment() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, token, _, buyer, checkout) = setup_usdc(&env);
    let id = order_id(&env, 35);
    create_quote(&env, &client, &buyer, &id, &token, 50_000);
    client.pay(&token, &buyer, &id, &50_000);

    assert_eq!(
        client.try_pay(&token, &buyer, &id, &50_000),
        Err(Ok(Error::OrderAlreadyPaid))
    );
    assert_eq!(usdc_balance(&env, &token, &buyer), 950_000);
    assert_eq!(usdc_balance(&env, &token, &checkout), 50_000);
}

// ---------------------------------------------------------------------------
// Token whitelist
// ---------------------------------------------------------------------------

#[test]
fn test_token_not_allowed_rejected_at_quote_creation() {
    let env = Env::default();
    env.mock_all_auths();

    let token = env.register(MockToken, ());
    let contract = env.register(Checkout, ());
    let merchant = Address::generate(&env);
    let buyer = Address::generate(&env);
    let client = CheckoutClient::new(&env, &contract);
    client.initialize(&merchant);

    let id = order_id(&env, 16);
    assert_eq!(
        client.try_create_order(&buyer, &id, &token, &10_000, &300),
        Err(Ok(Error::TokenNotAllowed))
    );
}

#[test]
fn test_remove_token_disables_exact_pending_quote_payment() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, token, _, buyer, _) = setup_usdc(&env);
    let id = order_id(&env, 17);
    create_quote(&env, &client, &buyer, &id, &token, 10_000);
    client.remove_token(&token);
    assert!(!client.is_token_allowed(&token));

    assert_eq!(
        client.try_pay(&token, &buyer, &id, &10_000),
        Err(Ok(Error::TokenNotAllowed))
    );
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
    client.add_token(&native_id);
    StellarAssetClient::new(&env, &native_id).mint(&buyer, &5_000_000);

    let id = order_id(&env, 21);
    create_quote(&env, &client, &buyer, &id, &native_id, 100_000);
    client.pay(&native_id, &buyer, &id, &100_000);

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
// General guards + events
// ---------------------------------------------------------------------------

#[test]
fn test_non_positive_amount_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, token, _, buyer, _) = setup_usdc(&env);
    let id = order_id(&env, 2);
    assert_eq!(
        client.try_create_order(&buyer, &id, &token, &0, &300),
        Err(Ok(Error::InvalidAmount))
    );
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

    assert_eq!(client.try_initialize(&other), Err(Ok(Error::AlreadyInitialized)));
}

#[test]
fn test_set_merchant_changes_escrow_destination() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, token, _, buyer, checkout) = setup_usdc(&env);
    let new_merchant = Address::generate(&env);
    client.set_merchant(&new_merchant);

    let id = order_id(&env, 3);
    create_quote(&env, &client, &buyer, &id, &token, 10_000);
    client.pay(&token, &buyer, &id, &10_000);

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

    create_quote(&env, &client, &buyer, &id, &token, 10_000);
    client.pay(&token, &buyer, &id, &10_000);
    client.dispatch(&id);

    let events = env.events().all().filter_by_contract(&checkout);
    assert!(
        !events.events().is_empty(),
        "expected contract events for create/pay/dispatch"
    );
}
