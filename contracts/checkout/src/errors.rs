use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// Contract has not been initialized with a merchant yet.
    NotInitialized = 1,
    /// Contract has already been initialized.
    AlreadyInitialized = 2,
    /// Amount must be a positive integer number of token units.
    InvalidAmount = 3,
    /// This order has already received funds (paid, shipped, or refunded).
    OrderAlreadyPaid = 4,
    /// The token contract is not on the merchant's approved list.
    TokenNotAllowed = 5,
    /// No order exists for the given order id.
    OrderNotFound = 6,
    /// The order is not in a state that allows this transition.
    InvalidOrderStatus = 7,
    /// The merchant has not configured a quote-verification key.
    QuoteSignerNotSet = 8,
    /// Quote expiry is already elapsed or exceeds the bounded TTL window.
    InvalidQuoteExpiry = 9,
    /// No merchant-authorized quote exists for this pending order.
    QuoteRequired = 10,
    /// Payment arguments do not exactly match the merchant-authorized quote.
    QuoteMismatch = 11,
    /// The merchant-authorized quote expired before payment.
    QuoteExpired = 12,
}
