#![cfg(test)]

use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::{contract, contractimpl, contracttype, Address, BytesN, Env, Vec};

use crate::errors::Error;
use crate::order::Status;
use crate::{Checkout, CheckoutClient, QuoteLine, QUOTE_TTL_SECONDS};

#[contracttype]
pub enum MockTokenDataKey {
    Balance(Address),
}

#[contract]
pub struct MockToken;

#[contractimpl]
impl MockToken {
    pub fn mint(env: Env, to: Address, amount: i128) {
        let balance: i128 = env
            .storage()
            .persistent()
            .get(&MockTokenDataKey::Balance(to.clone()))
            .unwrap_or(0);
        env.storage()
            .persistent()
            .set(&MockTokenDataKey::Balance(to), &(balance + amount));
    }

    pub fn balance(env: Env, id: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&MockTokenDataKey::Balance(id))
            .unwrap_or(0)
    }

    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        let from_balance: i128 = env
            .storage()
            .persistent()
            .get(&MockTokenDataKey::Balance(from.clone()))
            .unwrap_or(0);
        let to_balance: i128 = env
            .storage()
            .persistent()
            .get(&MockTokenDataKey::Balance(to.clone()))
            .unwrap_or(0);
        env.storage()
            .persistent()
            .set(&MockTokenDataKey::Balance(from), &(from_balance - amount));
        env.storage()
            .persistent()
            .set(&MockTokenDataKey::Balance(to), &(to_balance + amount));
    }
}

fn id(env: &Env, byte: u8) -> BytesN<32> {
    BytesN::from_array(env, &[byte; 32])
}

fn cart(env: &Env, rows: &[(u8, u32)]) -> Vec<QuoteLine> {
    let mut lines = Vec::new(env);
    for (product, quantity) in rows.iter() {
        lines.push_back(QuoteLine {
            product_id: id(env, *product),
            quantity: *quantity,
        });
    }
    lines
}

fn setup(env: &Env) -> (CheckoutClient<'_>, Address, Address, Address, Address) {
    let token = env.register(MockToken, ());
    let checkout = env.register(Checkout, ());
    let merchant = Address::generate(env);
    let buyer = Address::generate(env);
    let client = CheckoutClient::new(env, &checkout);

    client.initialize(&merchant);
    client.add_token(&token);
    MockTokenClient::new(env, &token).mint(&buyer, &10_000_000);

    (client, token, merchant, buyer, checkout)
}

fn balance(env: &Env, token: &Address, address: &Address) -> i128 {
    MockTokenClient::new(env, token).balance(address)
}

fn set_price(client: &CheckoutClient<'_>, token: &Address, env: &Env, product: u8, price: i128) {
    client.set_product_price(&id(env, product), token, &price);
}

#[test]
fn quote_uses_merchant_catalog_not_client_price() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, token, _, buyer, _) = setup(&env);
    set_price(&client, &token, &env, 1, 125_000);
    set_price(&client, &token, &env, 2, 90_000);

    let order_id = id(&env, 101);
    let amount = client.create_quote(&buyer, &order_id, &token, &cart(&env, &[(1, 2), (2, 3)]));

    assert_eq!(amount, 520_000);
    let stored = client.order(&order_id).unwrap();
    assert_eq!(stored.buyer, buyer);
    assert_eq!(stored.token, token);
    assert_eq!(stored.amount, 520_000);
    assert_eq!(stored.status, Status::Pending);
    assert_eq!(client.quote_expires_at(&order_id), Some(QUOTE_TTL_SECONDS));
}

#[test]
fn unquoted_payment_fails_before_transfer() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, token, _, buyer, checkout) = setup(&env);
    let before = balance(&env, &token, &buyer);

    let result = client.try_pay(&token, &buyer, &id(&env, 102), &1);

    assert_eq!(result, Err(Ok(Error::QuoteRequired)));
    assert_eq!(balance(&env, &token, &buyer), before);
    assert_eq!(balance(&env, &token, &checkout), 0);
}

#[test]
fn exact_quote_payment_escrows_then_dispatches() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, token, merchant, buyer, checkout) = setup(&env);
    set_price(&client, &token, &env, 3, 200_000);
    let order_id = id(&env, 103);
    let amount = client.create_quote(&buyer, &order_id, &token, &cart(&env, &[(3, 2)]));

    client.pay(&token, &buyer, &order_id, &amount);
    assert_eq!(client.status(&order_id), Some(Status::Paid));
    assert_eq!(balance(&env, &token, &buyer), 9_600_000);
    assert_eq!(balance(&env, &token, &checkout), 400_000);
    assert_eq!(balance(&env, &token, &merchant), 0);

    client.dispatch(&order_id);
    assert_eq!(client.status(&order_id), Some(Status::Shipped));
    assert_eq!(balance(&env, &token, &checkout), 0);
    assert_eq!(balance(&env, &token, &merchant), 400_000);
}

#[test]
fn refund_returns_exact_escrow_and_prevents_replay() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, token, _, buyer, checkout) = setup(&env);
    set_price(&client, &token, &env, 4, 300_000);
    let order_id = id(&env, 104);
    let amount = client.create_quote(&buyer, &order_id, &token, &cart(&env, &[(4, 1)]));

    client.pay(&token, &buyer, &order_id, &amount);
    client.refund(&order_id);
    assert_eq!(client.status(&order_id), Some(Status::Refunded));
    assert_eq!(balance(&env, &token, &buyer), 10_000_000);
    assert_eq!(balance(&env, &token, &checkout), 0);

    let replay = client.try_pay(&token, &buyer, &order_id, &amount);
    assert_eq!(replay, Err(Ok(Error::OrderAlreadyPaid)));
}

#[test]
fn wrong_buyer_token_or_amount_never_moves_funds() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, token, _, buyer, checkout) = setup(&env);
    let attacker = Address::generate(&env);
    let other_token = env.register(MockToken, ());
    client.add_token(&other_token);
    MockTokenClient::new(&env, &other_token).mint(&buyer, &10_000_000);
    set_price(&client, &token, &env, 5, 700_000);
    let order_id = id(&env, 105);
    let amount = client.create_quote(&buyer, &order_id, &token, &cart(&env, &[(5, 1)]));
    let buyer_before = balance(&env, &token, &buyer);

    assert_eq!(
        client.try_pay(&token, &attacker, &order_id, &amount),
        Err(Ok(Error::BuyerMismatch))
    );
    assert_eq!(
        client.try_pay(&other_token, &buyer, &order_id, &amount),
        Err(Ok(Error::TokenMismatch))
    );
    assert_eq!(
        client.try_pay(&token, &buyer, &order_id, &(amount - 1)),
        Err(Ok(Error::AmountMismatch))
    );
    assert_eq!(
        client.try_pay(&token, &buyer, &order_id, &(amount + 1)),
        Err(Ok(Error::AmountMismatch))
    );

    assert_eq!(balance(&env, &token, &buyer), buyer_before);
    assert_eq!(balance(&env, &token, &checkout), 0);
    assert_eq!(client.status(&order_id), Some(Status::Pending));
}

#[test]
fn expired_quote_fails_before_transfer() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, token, _, buyer, checkout) = setup(&env);
    set_price(&client, &token, &env, 6, 100_000);
    let order_id = id(&env, 106);
    let amount = client.create_quote(&buyer, &order_id, &token, &cart(&env, &[(6, 1)]));
    let expires_at = client.quote_expires_at(&order_id).unwrap();

    env.ledger().with_mut(|ledger| ledger.timestamp = expires_at);
    let result = client.try_pay(&token, &buyer, &order_id, &amount);

    assert_eq!(result, Err(Ok(Error::QuoteExpired)));
    assert_eq!(balance(&env, &token, &checkout), 0);
    assert_eq!(client.status(&order_id), Some(Status::Pending));
}

#[test]
fn unknown_duplicate_zero_quantity_and_empty_quotes_fail_closed() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, token, _, buyer, _) = setup(&env);
    set_price(&client, &token, &env, 7, 10_000);

    assert_eq!(
        client.try_create_quote(&buyer, &id(&env, 107), &token, &cart(&env, &[(8, 1)])),
        Err(Ok(Error::ProductNotFound))
    );
    assert_eq!(
        client.try_create_quote(&buyer, &id(&env, 108), &token, &cart(&env, &[(7, 1), (7, 2)])),
        Err(Ok(Error::DuplicateProduct))
    );
    assert_eq!(
        client.try_create_quote(&buyer, &id(&env, 109), &token, &cart(&env, &[(7, 0)])),
        Err(Ok(Error::InvalidQuantity))
    );
    assert_eq!(
        client.try_create_quote(&buyer, &id(&env, 110), &token, &Vec::<QuoteLine>::new(&env)),
        Err(Ok(Error::EmptyQuote))
    );
}

#[test]
fn catalog_removal_and_token_revocation_fail_closed() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, token, _, buyer, _) = setup(&env);
    let product = id(&env, 9);
    client.set_product_price(&product, &token, &50_000);
    assert_eq!(client.product_price(&product, &token), Some(50_000));

    client.remove_product_price(&product, &token);
    assert_eq!(client.product_price(&product, &token), None);
    assert_eq!(
        client.try_create_quote(&buyer, &id(&env, 111), &token, &cart(&env, &[(9, 1)])),
        Err(Ok(Error::ProductNotFound))
    );

    client.set_product_price(&product, &token, &50_000);
    let order_id = id(&env, 112);
    let amount = client.create_quote(&buyer, &order_id, &token, &cart(&env, &[(9, 1)]));
    client.remove_token(&token);
    assert_eq!(
        client.try_pay(&token, &buyer, &order_id, &amount),
        Err(Ok(Error::TokenNotAllowed))
    );
}

#[test]
fn quote_math_overflow_fails_closed() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, token, _, buyer, _) = setup(&env);
    set_price(&client, &token, &env, 10, i128::MAX);

    let result = client.try_create_quote(
        &buyer,
        &id(&env, 113),
        &token,
        &cart(&env, &[(10, 2)]),
    );
    assert_eq!(result, Err(Ok(Error::AmountOverflow)));
}

#[test]
fn duplicate_order_id_cannot_replace_pending_quote() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, token, _, buyer, _) = setup(&env);
    set_price(&client, &token, &env, 11, 111_000);
    set_price(&client, &token, &env, 12, 999_000);
    let order_id = id(&env, 114);
    let first = client.create_quote(&buyer, &order_id, &token, &cart(&env, &[(11, 1)]));
    assert_eq!(first, 111_000);

    let replacement = client.try_create_quote(&buyer, &order_id, &token, &cart(&env, &[(12, 1)]));
    assert_eq!(replacement, Err(Ok(Error::OrderAlreadyPaid)));
    assert_eq!(client.order(&order_id).unwrap().amount, 111_000);
}

#[test]
fn initialize_and_catalog_guards_remain_fail_closed() {
    let env = Env::default();
    env.mock_all_auths();
    let token = env.register(MockToken, ());
    let checkout = env.register(Checkout, ());
    let merchant = Address::generate(&env);
    let other = Address::generate(&env);
    let client = CheckoutClient::new(&env, &checkout);

    assert_eq!(
        client.try_set_product_price(&id(&env, 13), &token, &1),
        Err(Ok(Error::NotInitialized))
    );
    client.initialize(&merchant);
    assert_eq!(client.try_initialize(&other), Err(Ok(Error::AlreadyInitialized)));
    assert_eq!(
        client.try_set_product_price(&id(&env, 13), &token, &1),
        Err(Ok(Error::TokenNotAllowed))
    );
    client.add_token(&token);
    assert_eq!(
        client.try_set_product_price(&id(&env, 13), &token, &0),
        Err(Ok(Error::InvalidAmount))
    );
}
