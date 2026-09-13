use soroban_sdk::{contracttype, Address, Bytes, BytesN, Env};

/// Merchant-authorized pending-quote metadata retained until payment.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
pub struct QuoteAuth {
    /// Unix ledger timestamp after which this quote cannot be paid.
    pub expires_at: u64,
}

/// Server quotes are intentionally short-lived even if a signer attempts a
/// longer expiry. This bounds leaked/stale quote replay independently of the UI.
pub const MAX_QUOTE_TTL_SECONDS: u64 = 30 * 60;

/// Canonical bytes signed by the merchant quote service and verified on-chain.
///
/// Layout (all integers big-endian):
/// `MOVAQUOTE1 || order_id[32] || buyer_len[u32] || buyer_strkey ||
///  token_len[u32] || token_strkey || amount[i128] || expires_at[u64]`.
///
/// Length-prefixing address strings makes the encoding unambiguous while
/// preserving Soroban's canonical Stellar strkey representation on both sides.
pub fn quote_message(
    env: &Env,
    order_id: &BytesN<32>,
    buyer: &Address,
    token: &Address,
    amount: i128,
    expires_at: u64,
) -> Bytes {
    let mut message = Bytes::from_slice(env, b"MOVAQUOTE1");
    message.extend_from_array(&order_id.to_array());

    append_len_prefixed(&mut message, &buyer.to_string().to_bytes());
    append_len_prefixed(&mut message, &token.to_string().to_bytes());

    message.extend_from_array(&amount.to_be_bytes());
    message.extend_from_array(&expires_at.to_be_bytes());
    message
}

fn append_len_prefixed(message: &mut Bytes, value: &Bytes) {
    message.extend_from_array(&value.len().to_be_bytes());
    message.append(value);
}
