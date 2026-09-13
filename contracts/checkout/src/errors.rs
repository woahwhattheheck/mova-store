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
    /// This order id is already registered or has already received funds.
    OrderAlreadyPaid = 4,
    /// The token contract is not on the merchant's approved list.
    TokenNotAllowed = 5,
    /// No merchant-authorized pending order exists for the given order id.
    OrderNotFound = 6,
    /// The order is not in a state that allows this transition.
    InvalidOrderStatus = 7,
    /// The merchant-authorized quote expired before payment.
    QuoteExpired = 8,
    /// Buyer, token, or raw amount does not exactly match the pending quote.
    QuoteMismatch = 9,
    /// Quote expiry must be strictly in the future when the merchant creates it.
    InvalidExpiry = 10,
}
