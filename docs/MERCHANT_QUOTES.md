# Merchant-authoritative checkout quotes

Mova's browser cart is presentation state, not pricing authority. `cartItems`, item `price` fields, and `totalPrice` live in localStorage and can be edited by the buyer. A successful Stellar transaction therefore must not be interpreted as merchant-approved payment unless its terms came from a trusted merchant quote.

## Authority chain

1. The browser sends only product identities, integer quantities, the buyer Stellar public key, and the configured USDC token to `POST /api/checkout/quote`.
2. The server re-reads `id,name,price` from the canonical Supabase `products` table. Browser-supplied price/total fields are ignored.
3. `deriveMerchantQuote` converts the canonical USD prices to exact 7-decimal USDC raw units without floating-point multiplication. Duplicate product ids, invalid quantities, unknown products, non-positive prices, or over-precise catalog prices fail closed.
4. The server generates a unique quote/order id and short expiry.
5. `issueMerchantAuthorizedOrder` signs a Soroban `create_order` invocation with the merchant's server-only Stellar key. The contract stores buyer, token, exact raw amount, and a separate expiry record as an immutable Pending order.
6. The buyer's `pay` invocation is accepted only when the order exists, is Pending, has not expired, and buyer/token/raw amount exactly equal the stored merchant quote. Missing, stale, wrong-buyer, wrong-token, underpayment, overpayment and replay attempts fail before token transfer.
7. Fulfillment/payment UI must bind completion to the exact quote order id, token and raw amount. A browser localStorage total is never sufficient evidence.

## Token scope

Catalog prices are denominated in USD. The quote API intentionally supports only the configured USDC token. XLM checkout would require a merchant-controlled FX/oracle quote; accepting a browser-selected XLM conversion would recreate the pricing-authority flaw.

## Merchant key custody

`STELLAR_MERCHANT_SECRET_KEY` is a server-only deployment secret for the address configured as the checkout contract merchant/admin.

- Never prefix it with `NEXT_PUBLIC_`.
- Never serialize or log its value.
- Keep it in the deployment provider's encrypted server environment, not source control or browser storage.
- Rotate the key if exposure is suspected, then use the contract's `set_merchant` procedure under the existing merchant's authorization to move authority.
- The quote API fails closed when the key is absent or invalid.
- The merchant key authorizes only quote/order creation and merchant lifecycle actions. Buyer payment still requires the buyer's own Stellar authorization.

No deployment or live-chain mutation is required to test the pure quote derivation or contract unit suite. Integration validation should use the repository CI and a dedicated testnet deployment before production key provisioning.

## Upgrade behavior

The existing persisted `Order` struct is intentionally unchanged. Quote expiry is stored under a separate `OrderExpiry(order_id)` key. Existing Paid/Shipped/Refunded orders remain decodable. A legacy Pending order created before strict quote enforcement has no expiry record, so `pay` fails closed rather than treating an old buyer-self-priced order as merchant-authoritative.
