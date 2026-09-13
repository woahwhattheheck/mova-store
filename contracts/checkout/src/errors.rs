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
    /// Checkout payment was attempted without a merchant-authoritative pending quote.
    QuoteRequired = 8,
    /// A pending quote has expired and must be re-priced before payment.
    QuoteExpired = 9,
    /// The paying address differs from the buyer bound into the quote.
    BuyerMismatch = 10,
    /// The payment token differs from the token bound into the quote.
    TokenMismatch = 11,
    /// The payment amount differs from the merchant-authoritative quoted amount.
    AmountMismatch = 12,
    /// No line items were supplied for a quote.
    EmptyQuote = 13,
    /// A line item quantity must be at least one.
    InvalidQuantity = 14,
    /// The requested product is not present in the merchant-authoritative catalog.
    ProductNotFound = 15,
    /// The same product id appeared more than once in one quote request.
    DuplicateProduct = 16,
    /// A quote request exceeded the contract's bounded line-item limit.
    TooManyItems = 17,
    /// Price multiplication or quote summation overflowed i128.
    AmountOverflow = 18,
}
