# Fulfillment tracking receipts

Mova's Stellar contract decides whether an order is `Paid`, `Shipped`, or `Refunded`. This feature does **not** add another payment or dispatch authority. It binds merchant-provided carrier/tracking facts to an immutable digest before the existing on-chain dispatch is attempted, then publishes that receipt to the authenticated buyer only after `Shipped` is authoritatively observed.

## State machine

1. **PREPARED** — normalized tracking evidence is stored with a SHA-256 digest. Exact replay is idempotent; different evidence for the same `order_id` is refused. PREPARED rows are not buyer-visible.
2. The existing `dispatchOrder()` path remains the only escrow-release action. The control re-reads the chain first, so a retry never dispatches an order already observed as `Shipped`.
3. **DISPATCHED** — only an observed `Shipped` state may promote the immutable receipt. Buyers can then read it through RLS and the order-history card verifies the packet digest before rendering it.

If dispatch succeeds but the follow-up read/finalization is temporarily unavailable, the row remains PREPARED. Re-open **Tracking** and submit the identical prefilled record after the chain reports `Shipped`; the recovery path finalizes without dispatching again.

## Authority ceiling

The receipt means: **the merchant attested to these exact tracking facts and the bytes have not changed**. It does not prove that the carrier accepted, scanned, delivered, or guaranteed the shipment. `carrierDeliveryVerified`, `dispatchAuthorized`, `refundAuthorized`, `paymentAuthorized`, and `inventoryMutationAuthorized` are all hard-false in the packet.

Tracking links must be HTTPS and may not contain URL credentials or fragments. Timestamps must be canonical UTC, expected delivery cannot precede shipment, identifiers are bounded, and control characters are rejected.

## Database setup

Apply `supabase/migrations/20260913_fulfillment_receipts.sql` after the base schema. Admin read/insert/update requires `public.is_admin()`. Buyers can select only `DISPATCHED` receipts whose `order_id` belongs to their authenticated `public.orders.user_id`. There is intentionally no anonymous buyer-read policy and no delete policy.

Guest checkout therefore remains device-local and does not gain a public tracking lookup that could leak order evidence. A future guest tracking design should use a separate unguessable capability/token rather than weakening this table's RLS.
