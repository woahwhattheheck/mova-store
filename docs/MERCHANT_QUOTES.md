# Merchant-authoritative checkout quotes

Mova Store must not treat browser cart prices or `localStorage.totalPrice` as payment authority. A buyer controls those values and could otherwise ask the checkout contract to accept a real on-chain payment at a self-selected amount.

The quote flow closes that gap before funds move.

## Trust boundary

1. The browser sends only product identity and quantity to `POST /api/checkout/quote`. Client copies of price, name, subtotal, and total are discarded.
2. The server reads canonical `id,price` rows from the Supabase product catalog and computes the raw token amount with decimal arithmetic in `lib/merchant-quote.ts`.
3. The server registers `(buyer, order_id, token, amount, expires_at)` with the Soroban checkout contract by calling `create_quote` from the configured quote signer.
4. The buyer receives the registered quote and signs only the subsequent `pay` invocation with Freighter.
5. `pay` requires an existing Pending quote and rejects a mismatched buyer, token, amount, expired quote, missing quote, or replay before any transfer or order-state overwrite.
6. Payment completion still requires the exact `pay` event receipt for the configured checkout contract, token, buyer, order id, and raw amount.

A quote order id is single-use. A Pending quote cannot be replaced, and a Paid/Shipped/Refunded order cannot be paid again.

## Quote signer custody

`MOVA_QUOTE_SIGNER_SECRET` is a **server-only** environment variable. Never rename it with a `NEXT_PUBLIC_` prefix and never send it to the browser.

Use a dedicated operational Stellar account for quote registration rather than putting the merchant escrow/admin wallet in the web tier. Keep that account minimally funded for transaction fees. The merchant configures or rotates its public address on the contract with `set_quote_signer`.

The quote signer authorizes order terms; it cannot dispatch or refund escrow unless it is separately made the merchant/admin. The merchant/admin remains the authority for `set_quote_signer`, token whitelist changes, dispatch, and refund.

## Deployment sequence

After deploying the updated contract:

1. Call `initialize(merchant)` as the merchant. Initialization makes the merchant the initial quote signer for compatibility.
2. Call `add_token(token)` for each accepted SEP-41 token.
3. Create a dedicated Stellar quote-signing account and fund only what it needs for transaction fees.
4. Call `set_quote_signer(quote_signer_public_address)` as the merchant.
5. Store that account's secret as `MOVA_QUOTE_SIGNER_SECRET` only in the server runtime.
6. Configure the normal public RPC/network/contract/token environment variables.

Do not deploy a new contract or rotate a live signer as part of ordinary source review. Those are explicit operational actions.

## Failure behavior

The API and contract fail closed. Unknown/deleted products, invalid quantities, duplicate canonical catalog ids, unsupported tokens, stale quotes, mismatched payment arguments, and reused order ids do not fall back to browser totals. If the quote signer, catalog, or RPC is unavailable, checkout cannot mint a payable quote and returns an error rather than accepting buyer-selected pricing.

## Tests

The contract suite covers unquoted payments, wrong buyer/token, underpayment, overpayment, expiry, replay, token removal after quoting, escrow/dispatch/refund, and native-asset settlement. Frontend/unit tests verify that tampered browser price/total fields are discarded and that canonical catalog rows determine the exact 7-decimal raw amount.
