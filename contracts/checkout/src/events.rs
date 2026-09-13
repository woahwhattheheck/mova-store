use soroban_sdk::{contractevent, Address, BytesN};

/// Emitted on every successful payment into escrow.
///
/// Topics: `pay`, token, buyer, merchant, order_id
/// Data:   `{ amount }` (i128, raw token units)
#[contractevent]
pub struct PaymentReceived {
    /// The SEP-41 token contract used for the payment.
    #[topic]
    pub token: Address,
    /// The address that paid.
    #[topic]
    pub buyer: Address,
    /// The merchant the order belongs to.
    #[topic]
    pub merchant: Address,
    /// The 32-byte order id this payment settles.
    #[topic]
    pub order_id: BytesN<32>,
    /// The amount escrowed, in raw token units.
    pub amount: i128,
}

/// Emitted when the merchant-authorized quote signer registers a pending order.
///
/// Topics: `create_order`, token, buyer, order_id
/// Data:   `{ amount, timestamp, expires_at }`
#[contractevent]
pub struct OrderCreated {
    /// The SEP-41 token the buyer is authorized to pay with.
    #[topic]
    pub token: Address,
    /// The buyer authorized to fund the order.
    #[topic]
    pub buyer: Address,
    /// The immutable 32-byte order id.
    #[topic]
    pub order_id: BytesN<32>,
    /// The exact amount, in raw token units.
    pub amount: i128,
    /// Ledger timestamp of creation.
    pub timestamp: u64,
    /// Last timestamp at which the pending quote can be paid.
    pub expires_at: u64,
}

/// Emitted when the merchant dispatches an order and the escrow is released.
///
/// Topics: `dispatch`, order_id, merchant
/// Data:   `{ amount }`
#[contractevent]
pub struct OrderShipped {
    /// The 32-byte order id that was dispatched.
    #[topic]
    pub order_id: BytesN<32>,
    /// The merchant that released the escrow.
    #[topic]
    pub merchant: Address,
    /// The amount released, in raw token units.
    pub amount: i128,
}

/// Emitted when the merchant refunds a paid order back to the buyer.
///
/// Topics: `refund`, order_id, buyer
/// Data:   `{ amount }`
#[contractevent]
pub struct OrderRefunded {
    /// The 32-byte order id that was refunded.
    #[topic]
    pub order_id: BytesN<32>,
    /// The buyer that received the refund.
    #[topic]
    pub buyer: Address,
    /// The amount refunded, in raw token units.
    pub amount: i128,
}
