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
    /// No merchant-authorized pending order exists for the given order id.
    OrderNotFound = 6,
    /// The order is not in a state that allows this transition.
    InvalidOrderStatus = 7,
    /// The order id has already been reserved and cannot be reused.
    OrderAlreadyExists = 8,
    /// The merchant-authorized quote is no longer payable.
    QuoteExpired = 9,
    /// Buyer, token, or amount differs from the merchant-authorized quote.
    QuoteMismatch = 10,
}
