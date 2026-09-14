# Post-shipment return review

Mova's return surface is an **intake and evidence compiler**, not a refund or exchange executor.

## What it does

For an order already displayed in the buyer's order history, the buyer can select exact line quantities, choose a controlled reason, and build a deterministic merchant-review packet. For Stellar orders, the compiler requires a fresh read of the exact checkout-contract order and only reaches its strongest state when the current on-chain state is `Shipped`.

The packet binds:

- the exact order ID, displayed order status, payment method, and order timestamp;
- the purchased line identities and quantities used by the request;
- the selected return line quantities and controlled reason;
- the fresh Stellar verification result when applicable;
- a canonical request ID and SHA-256 digests for the order snapshot, request, verification evidence, and final receipt.

Exact replay produces the same packet. Changing the order snapshot, selected quantity, reason, verification evidence, or evaluation time changes the corresponding receipt material.

## Decision ceiling

The strongest possible output is:

`READY_FOR_MERCHANT_RETURN_REVIEW`

That state means only that the buyer-side request is structurally complete and, for Stellar, the current contract read still reports the exact order as shipped. It is **not** merchant approval and does not prove delivery condition, carrier custody, policy eligibility, product defect, legal return rights, refund amount, replacement availability, or buyer identity beyond the existing order-history boundary.

Every receipt permanently carries these fields as `false`:

- `refundAuthorized`
- `exchangeAuthorized`
- `dispatchAuthorized`
- `replacementAuthorized`
- `paymentAuthorized`
- `inventoryMutationAuthorized`

The feature never calls `refundOrder`, `dispatchOrder`, wallet signing, payment submission, inventory mutation, email, or an external support API.

## Fail-closed behavior

The compiler rejects malformed or ambiguous input, including:

- empty requests;
- unknown or duplicate line indexes;
- zero, negative, fractional, non-finite, or over-purchased quantities;
- unsupported reason/status/payment vocabulary;
- malformed or non-canonical UTC timestamps;
- requests dated before the order or in the future;
- `OTHER` without bounded explanatory text.

A syntactically valid request is held rather than readied when:

- the local order is not post-shipment;
- a Stellar order cannot be freshly verified;
- the current chain state is not `Shipped`;
- the chain check predates the request or is older than five minutes;
- the order is a card order, because this repository has no independent card-payment/shipment authority that the buyer can self-assert.

## Relationship to checkout and fulfillment work

This feature deliberately does not modify checkout persistence, merchant quote authority, Soroban contract actions, the merchant order index, or Supabase schema. It consumes only the order snapshot already rendered to the buyer and the existing read-only `verifyOrderOnChain()` boundary.

That separation prevents a return-intake UI from silently becoming a second pricing, payment, dispatch, or refund authority.
