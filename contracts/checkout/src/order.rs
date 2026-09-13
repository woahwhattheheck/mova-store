use soroban_sdk::{contracttype, Address};

/// Lifecycle of an order.
///
/// * `Pending`  - merchant-authorized quote exists; nothing escrowed yet.
/// * `Paid`     - `pay` escrowed funds into the contract (buyer -> contract).
/// * `Shipped`  - merchant called `dispatch`; escrow released (contract -> merchant).
/// * `Refunded` - merchant called `refund`; escrow returned (contract -> buyer).
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
pub enum Status {
    Pending = 0,
    Paid = 1,
    Shipped = 2,
    Refunded = 3,
}

/// An on-chain order record. Pending records are immutable merchant-authorized
/// quotes: buyer, token, amount and expiry must all match when payment arrives.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
pub struct Order {
    /// The address that funded (or will fund) the order.
    pub buyer: Address,
    /// The merchant-authorized amount, in raw token units.
    pub amount: i128,
    /// The merchant-authorized SEP-41 token contract.
    pub token: Address,
    /// Ledger timestamp of the last status transition.
    pub timestamp: u64,
    /// Last timestamp at which a Pending quote may be paid.
    pub expires_at: u64,
    /// Current lifecycle state.
    pub status: Status,
}

impl Order {
    /// True once funds have actually been received into escrow.
    pub fn is_paid(&self) -> bool {
        matches!(self.status, Status::Paid | Status::Shipped)
    }

    /// True when the escrow is still held by the contract.
    pub fn is_escrowed(&self) -> bool {
        self.status == Status::Paid
    }
}
