#![cfg(test)]

use soroban_sdk::testutils::{Address as _, Events, Ledger as _};
use soroban_sdk::token::{StellarAssetClient, TokenClient};
use soroban_sdk::{contract, contractimpl, contracttype, Address, BytesN, Env};

use crate::errors::Error;
use crate::order::Status;
use crate::{Checkout, CheckoutClient, DEFAULT_QUOTE_TTL_SECONDS};

#[contracttype]
pub enum MockTokenDataKey {
    Balance(Address),
}

#[contract]
pub struct MockToken;

#[contractimpl]
impl MockToken {
    pub fn mint(env: Env, to: Address, amount: i128) {
        let bal: i128 = env
            .storage()
            .persistent()
            .get(&MockTokenDataKey::Balance(to.clone()))
            .unwrap_or(0);
        env.storage()
            .persistent()
            .set(&MockTokenDataKey::Balance(to), &(bal + amount));
    }

    pub fn balance(env: Env, id: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&MockTokenDataKey::Balance(id))
            .unwrap_or(0)
    }

    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        let from_bal: i128 = env
            .storage()
            .persistent()
            .get(&MockTokenDataKey::Balance(from.clone()))
            .unwrap_or(0);
        let to_bal: i128 = env
            .storage()
            .persistent()
            .get(&MockTokenDataKey::Balance(to.clone()))
            .unwrap_or(0);
        env.storage()
            .persistent()
            .set(&MockTokenDataKey::Balance(from), &(from_bal - amount));
        env.storage()
            .persistent()
            .set(&MockTokenDataKey::Balance(to), &(to_bal + amount));
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

fn usdc_balance(env: &Env, token: &Address, address: &Address) -> i128 {
    MockTokenClient::new(env, token).balance(address)
}

fn quote(
    client: &CheckoutClient<'_>,
    buyer: &Address,
    id: &BytesN<32>,
    token: &Address,
    amount: i128,
    expires_at: u64,
) {
    client.create_quote(buyer, id, token, &amount, &expires_at);
}

#[test]
fn quoted_pay_escrows_then_dispatch_releases_to_merchant() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(100);

    let (client, token, merchant, buyer, checkout) = setup_usdc(&env);
    let id = order_id(&env, 1);
    quote(&client, &buyer, &id, &token, 100_000, 500);

    client.pay(&token, &buyer, &id, &100_000);
    assert_eq!(usdc_balance(&env, &token, &buyer), 900_000);
    assert_eq!(usdc_balance(&env, &token, &checkout), 100_000);
    assert_eq!(client.status(&id), Some(Status::Paid));

    client.dispatch(&id);
    assert_eq!(usdc_balance(&env, &token, &checkout), 0);
    assert_eq!(usdc_balance(&env, &token, &merchant), 100_000);
    assert_eq!(client.status(&id), Some(Status::Shipped));
}

#[test]
fn refund_returns_escrow_to_buyer() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, token, _, buyer, checkout) = setup_usdc(&env);
    let id = order_id(&env, 2);
    quote(&client, &buyer, &id, &token, 50_000, 500);
    client.pay(&token, &buyer, &id, &50_000);
    assert_eq!(usdc_balance(&env, &token, &checkout), 50_000);

    client.refund(&id);
    assert_eq!(usdc_balance(&env, &token, &buyer), 1_000_000);
    assert_eq!(usdc_balance(&env, &token, &checkout), 0);
    assert_eq!(client.status(&id), Some(Status::Refunded));
}

#[test]
fn unquoted_payment_is_rejected_before_transfer() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, token, _, buyer, checkout) = setup_usdc(&env);
    let id = order_id(&env, 3);
    let result = client.try_pay(&token, &buyer, &id, &10_000);

    assert_eq!(result, Err(Ok(Error::OrderNotFound)));
    assert_eq!(usdc_balance(&env, &token, &buyer), 1_000_000);
    assert_eq!(usdc_balance(&env, &token, &checkout), 0);
    assert_eq!(client.order(&id), None);
}

#[test]
fn wrong_amount_cannot_overwrite_pending_quote() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, token, _, buyer, checkout) = setup_usdc(&env);
    let id = order_id(&env, 4);
    quote(&client, &buyer, &id, &token, 75_000, 500);

    assert_eq!(
        client.try_pay(&token, &buyer, &id, &74_999),
        Err(Ok(Error::QuoteMismatch))
    );
    assert_eq!(
        client.try_pay(&token, &buyer, &id, &75_001),
        Err(Ok(Error::QuoteMismatch))
    );
    let pending = client.order(&id).unwrap();
    assert_eq!(pending.status, Status::Pending);
    assert_eq!(pending.amount, 75_000);
    assert_eq!(usdc_balance(&env, &token, &checkout), 0);
}

#[test]
fn wrong_buyer_and_token_are_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, token, _, buyer, checkout) = setup_usdc(&env);
    let other_buyer = Address::generate(&env);
    let other_token = env.register(MockToken, ());
    let id = order_id(&env, 5);
    quote(&client, &buyer, &id, &token, 20_000, 500);

    assert_eq!(
        client.try_pay(&token, &other_buyer, &id, &20_000),
        Err(Ok(Error::QuoteMismatch))
    );
    assert_eq!(
        client.try_pay(&other_token, &buyer, &id, &20_000),
        Err(Ok(Error::QuoteMismatch))
    );
    assert_eq!(client.status(&id), Some(Status::Pending));
    assert_eq!(usdc_balance(&env, &token, &checkout), 0);
}

#[test]
fn expired_quote_is_rejected_without_state_or_balance_change() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(100);

    let (client, token, _, buyer, checkout) = setup_usdc(&env);
    let id = order_id(&env, 6);
    quote(&client, &buyer, &id, &token, 30_000, 110);
    env.ledger().set_timestamp(110);

    assert_eq!(
        client.try_pay(&token, &buyer, &id, &30_000),
        Err(Ok(Error::QuoteExpired))
    );
    assert_eq!(client.status(&id), Some(Status::Pending));
    assert_eq!(usdc_balance(&env, &token, &buyer), 1_000_000);
    assert_eq!(usdc_balance(&env, &token, &checkout), 0);
}

#[test]
fn stale_quote_cannot_be_created() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(200);

    let (client, token, _, buyer, _) = setup_usdc(&env);
    let id = order_id(&env, 7);
    assert_eq!(
        client.try_create_quote(&buyer, &id, &token, &10_000, &200),
        Err(Ok(Error::QuoteExpired))
    );
    assert_eq!(client.order(&id), None);
}

#[test]
fn order_id_is_single_use_for_quote_and_payment_replay() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, token, _, buyer, _) = setup_usdc(&env);
    let id = order_id(&env, 8);
    quote(&client, &buyer, &id, &token, 10_000, 500);

    assert_eq!(
        client.try_create_quote(&buyer, &id, &token, &10_000, &600),
        Err(Ok(Error::OrderAlreadyExists))
    );

    client.pay(&token, &buyer, &id, &10_000);
    assert_eq!(
        client.try_pay(&token, &buyer, &id, &10_000),
        Err(Ok(Error::OrderAlreadyPaid))
    );
}

#[test]
fn compatibility_create_order_is_quote_signer_authorized_and_expires() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1000);

    let (client, token, merchant, buyer, _) = setup_usdc(&env);
    assert_eq!(client.quote_signer(), merchant);

    let id = order_id(&env, 9);
    client.create_order(&buyer, &id, &token, &25_000);
    let pending = client.order(&id).unwrap();
    assert_eq!(pending.status, Status::Pending);
    assert_eq!(pending.expires_at, 1000 + DEFAULT_QUOTE_TTL_SECONDS);
}

#[test]
fn merchant_can_rotate_quote_signer() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _, _, _, _) = setup_usdc(&env);
    let signer = Address::generate(&env);
    client.set_quote_signer(&signer);
    assert_eq!(client.quote_signer(), signer);
}

#[test]
fn token_removal_blocks_settlement_of_pending_quote() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, token, _, buyer, _) = setup_usdc(&env);
    let id = order_id(&env, 10);
    quote(&client, &buyer, &id, &token, 10_000, 500);
    client.remove_token(&token);

    assert_eq!(
        client.try_pay(&token, &buyer, &id, &10_000),
        Err(Ok(Error::TokenNotAllowed))
    );
    assert_eq!(client.status(&id), Some(Status::Pending));
}

#[test]
fn non_positive_amounts_are_rejected_at_quote_and_pay_boundary() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, token, _, buyer, _) = setup_usdc(&env);
    let id = order_id(&env, 11);
    assert_eq!(
        client.try_create_quote(&buyer, &id, &token, &0, &500),
        Err(Ok(Error::InvalidAmount))
    );
    assert_eq!(
        client.try_pay(&token, &buyer, &id, &0),
        Err(Ok(Error::InvalidAmount))
    );
}

#[test]
fn dispatch_pending_and_refund_after_dispatch_are_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, token, _, buyer, _) = setup_usdc(&env);
    let id = order_id(&env, 12);
    quote(&client, &buyer, &id, &token, 10_000, 500);
    assert_eq!(client.try_dispatch(&id), Err(Ok(Error::InvalidOrderStatus)));

    client.pay(&token, &buyer, &id, &10_000);
    client.dispatch(&id);
    assert_eq!(client.try_refund(&id), Err(Ok(Error::InvalidOrderStatus)));
}

#[test]
fn native_asset_payment_still_uses_authorized_quote() {
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

    let id = order_id(&env, 13);
    quote(&client, &buyer, &id, &native_id, 100_000, 500);
    client.pay(&native_id, &buyer, &id, &100_000);

    let native_client = TokenClient::new(&env, &native_id);
    assert_eq!(native_client.balance(&buyer), 4_900_000);
    assert_eq!(native_client.balance(&contract), 100_000);
    client.dispatch(&id);
    assert_eq!(native_client.balance(&merchant), 100_000);
}

#[test]
fn lifecycle_emits_contract_events() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, token, _, buyer, checkout) = setup_usdc(&env);
    let id = order_id(&env, 14);
    quote(&client, &buyer, &id, &token, 10_000, 500);
    client.pay(&token, &buyer, &id, &10_000);
    client.dispatch(&id);

    let events = env.events().all().filter_by_contract(&checkout);
    assert!(!events.events().is_empty());
}
