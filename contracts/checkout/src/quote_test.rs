#![cfg(test)]

use ed25519_dalek::{Signer, SigningKey};
use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::{contract, contractimpl, contracttype, Address, BytesN, Env};

use crate::errors::Error;
use crate::order::Status;
use crate::quote::quote_message;
use crate::{Checkout, CheckoutClient};

const SIGNING_SEED: [u8; 32] = [7u8; 32];

#[contracttype]
pub enum QuoteTokenDataKey {
    Balance(Address),
}

#[contract]
pub struct QuoteToken;

#[contractimpl]
impl QuoteToken {
    pub fn mint(env: Env, to: Address, amount: i128) {
        let current: i128 = env
            .storage()
            .persistent()
            .get(&QuoteTokenDataKey::Balance(to.clone()))
            .unwrap_or(0);
        env.storage()
            .persistent()
            .set(&QuoteTokenDataKey::Balance(to), &(current + amount));
    }

    pub fn balance(env: Env, id: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&QuoteTokenDataKey::Balance(id))
            .unwrap_or(0)
    }

    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        let from_balance: i128 = env
            .storage()
            .persistent()
            .get(&QuoteTokenDataKey::Balance(from.clone()))
            .unwrap_or(0);
        let to_balance: i128 = env
            .storage()
            .persistent()
            .get(&QuoteTokenDataKey::Balance(to.clone()))
            .unwrap_or(0);
        env.storage()
            .persistent()
            .set(&QuoteTokenDataKey::Balance(from), &(from_balance - amount));
        env.storage()
            .persistent()
            .set(&QuoteTokenDataKey::Balance(to), &(to_balance + amount));
    }
}

fn order_id(env: &Env, byte: u8) -> BytesN<32> {
    BytesN::from_array(env, &[byte; 32])
}

fn setup(env: &Env) -> (CheckoutClient<'_>, Address, Address, Address, Address) {
    let token = env.register(QuoteToken, ());
    let contract = env.register(Checkout, ());
    let merchant = Address::generate(env);
    let buyer = Address::generate(env);

    let client = CheckoutClient::new(env, &contract);
    client.initialize(&merchant);
    client.add_token(&token);

    let signing = SigningKey::from_bytes(&SIGNING_SEED);
    let signer = BytesN::from_array(env, &signing.verifying_key().to_bytes());
    client.set_quote_signer(&signer);

    QuoteTokenClient::new(env, &token).mint(&buyer, &1_000_000);
    (client, token, merchant, buyer, contract)
}

fn signature(
    env: &Env,
    order_id: &BytesN<32>,
    buyer: &Address,
    token: &Address,
    amount: i128,
    expires_at: u64,
) -> BytesN<64> {
    let message = quote_message(env, order_id, buyer, token, amount, expires_at);
    let buffer = message.to_buffer::<256>();
    let signing = SigningKey::from_bytes(&SIGNING_SEED);
    let signed = signing.sign(buffer.as_slice()).to_bytes();
    BytesN::from_array(env, &signed)
}

fn authorize(
    env: &Env,
    client: &CheckoutClient<'_>,
    token: &Address,
    buyer: &Address,
    order_id: &BytesN<32>,
    amount: i128,
    expires_at: u64,
) {
    let sig = signature(env, order_id, buyer, token, amount, expires_at);
    client.create_quoted_order(buyer, order_id, token, &amount, &expires_at, &sig);
}

#[test]
fn signed_quote_exact_payment_succeeds() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let (client, token, _, buyer, checkout) = setup(&env);
    let id = order_id(&env, 31);
    authorize(&env, &client, &token, &buyer, &id, 125_000, 1_600);

    assert_eq!(client.status(&id), Some(Status::Pending));
    client.pay_quoted(&token, &buyer, &id, &125_000);

    assert_eq!(client.status(&id), Some(Status::Paid));
    assert_eq!(QuoteTokenClient::new(&env, &token).balance(&buyer), 875_000);
    assert_eq!(QuoteTokenClient::new(&env, &token).balance(&checkout), 125_000);
}

#[test]
fn quoted_payment_rejects_wrong_buyer_before_transfer() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(2_000);

    let (client, token, _, buyer, checkout) = setup(&env);
    let other = Address::generate(&env);
    QuoteTokenClient::new(&env, &token).mint(&other, &1_000_000);
    let id = order_id(&env, 32);
    authorize(&env, &client, &token, &buyer, &id, 50_000, 2_600);

    assert_eq!(
        client.try_pay_quoted(&token, &other, &id, &50_000),
        Err(Ok(Error::QuoteMismatch))
    );
    assert_eq!(QuoteTokenClient::new(&env, &token).balance(&other), 1_000_000);
    assert_eq!(QuoteTokenClient::new(&env, &token).balance(&checkout), 0);
}

#[test]
fn quoted_payment_rejects_wrong_token_and_amount() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(3_000);

    let (client, token, _, buyer, checkout) = setup(&env);
    let other_token = env.register(QuoteToken, ());
    client.add_token(&other_token);
    QuoteTokenClient::new(&env, &other_token).mint(&buyer, &1_000_000);

    let id = order_id(&env, 33);
    authorize(&env, &client, &token, &buyer, &id, 75_000, 3_600);

    assert_eq!(
        client.try_pay_quoted(&other_token, &buyer, &id, &75_000),
        Err(Ok(Error::QuoteMismatch))
    );
    assert_eq!(
        client.try_pay_quoted(&token, &buyer, &id, &74_999),
        Err(Ok(Error::QuoteMismatch))
    );
    assert_eq!(
        client.try_pay_quoted(&token, &buyer, &id, &75_001),
        Err(Ok(Error::QuoteMismatch))
    );
    assert_eq!(QuoteTokenClient::new(&env, &token).balance(&checkout), 0);
}

#[test]
fn quote_expiry_is_bounded_and_enforced() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(4_000);

    let (client, token, _, buyer, _) = setup(&env);
    let expired_id = order_id(&env, 34);
    let expired_sig = signature(&env, &expired_id, &buyer, &token, 10_000, 4_000);
    assert_eq!(
        client.try_create_quoted_order(
            &buyer,
            &expired_id,
            &token,
            &10_000,
            &4_000,
            &expired_sig,
        ),
        Err(Ok(Error::InvalidQuoteExpiry))
    );

    let far_id = order_id(&env, 35);
    let far_expiry = 4_000 + 1_801;
    let far_sig = signature(&env, &far_id, &buyer, &token, 10_000, far_expiry);
    assert_eq!(
        client.try_create_quoted_order(
            &buyer,
            &far_id,
            &token,
            &10_000,
            &far_expiry,
            &far_sig,
        ),
        Err(Ok(Error::InvalidQuoteExpiry))
    );

    let id = order_id(&env, 36);
    authorize(&env, &client, &token, &buyer, &id, 10_000, 4_010);
    env.ledger().set_timestamp(4_010);
    assert_eq!(
        client.try_pay_quoted(&token, &buyer, &id, &10_000),
        Err(Ok(Error::QuoteExpired))
    );
}

#[test]
fn unquoted_pending_order_cannot_use_quoted_payment() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(5_000);

    let (client, token, _, buyer, checkout) = setup(&env);
    let id = order_id(&env, 37);
    client.create_order(&buyer, &id, &token, &20_000);

    assert_eq!(
        client.try_pay_quoted(&token, &buyer, &id, &20_000),
        Err(Ok(Error::QuoteRequired))
    );
    assert_eq!(QuoteTokenClient::new(&env, &token).balance(&checkout), 0);
}

#[test]
fn quoted_payment_is_single_use() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(6_000);

    let (client, token, _, buyer, _) = setup(&env);
    let id = order_id(&env, 38);
    authorize(&env, &client, &token, &buyer, &id, 30_000, 6_600);
    client.pay_quoted(&token, &buyer, &id, &30_000);

    assert_eq!(
        client.try_pay_quoted(&token, &buyer, &id, &30_000),
        Err(Ok(Error::OrderAlreadyPaid))
    );
}

#[test]
fn quote_signer_must_be_configured() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(7_000);

    let token = env.register(QuoteToken, ());
    let contract = env.register(Checkout, ());
    let merchant = Address::generate(&env);
    let buyer = Address::generate(&env);
    let client = CheckoutClient::new(&env, &contract);
    client.initialize(&merchant);
    client.add_token(&token);

    let id = order_id(&env, 39);
    let sig = signature(&env, &id, &buyer, &token, 10_000, 7_600);
    assert_eq!(
        client.try_create_quoted_order(&buyer, &id, &token, &10_000, &7_600, &sig),
        Err(Ok(Error::QuoteSignerNotSet))
    );
}
