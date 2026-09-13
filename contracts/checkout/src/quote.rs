use soroban_sdk::{contracttype, BytesN};

/// A checkout line item expressed only as canonical product identity + quantity.
/// Price is intentionally absent: the contract resolves unit price from the
/// merchant-authoritative on-chain catalog.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct QuoteLine {
    pub product_id: BytesN<32>,
    pub quantity: u32,
}
