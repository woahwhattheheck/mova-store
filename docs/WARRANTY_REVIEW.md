# WarrantyCare — post-sale warranty review packets

WarrantyCare is an **evidence compiler and merchant-review surface**, not a warranty adjudicator or remedy executor.

It exists to keep a common post-sale support request structured and auditable: a buyer with a shipped order can identify exact purchased lines and quantities, record a controlled symptom and first-observed time, optionally bind a pre-existing evidence reference by SHA-256, and produce a deterministic packet for merchant review.

## What it does

The buyer-facing panel appears only for orders already shown as `Shipped` or `Completed` in the existing order-history UI. It binds:

- the exact order ID, payment method, local status, order time, and line snapshot;
- exact claimed line indexes and quantities;
- a controlled symptom: `NOT_WORKING`, `INTERMITTENT`, `PHYSICAL_DAMAGE`, `MISSING_PART`, `PERFORMANCE_DEGRADATION`, or `OTHER`;
- canonical request and first-observed UTC timestamps;
- optional opaque evidence references with type, revision, capture time, and SHA-256;
- a fresh read-only Stellar order verification when the order used Stellar;
- canonical SHA-256 digests for the order, request, evidence set, verification evidence, and final receipt.

The strongest possible state is:

`READY_FOR_MERCHANT_WARRANTY_REVIEW`

That means only that the structured claim packet is internally coherent and, for a Stellar order, a fresh exact contract read still reports the order as shipped. Card orders remain `HOLD` because this repository does not expose an independent buyer-side card-payment/shipment authority that WarrantyCare can prove.

## Evidence references

The UI never uploads or stores a photo/video/diagnostic and never accepts a URL, email address, phone number, credential, or raw file contents as an evidence reference. An optional reference is an opaque label plus the SHA-256 of evidence already stored under a separate owner-controlled process.

The core supports bounded revision histories. Exact replay collapses. Changed bytes under the same evidence identity/revision, kind changes across one evidence lineage, or capture-time rollback produce `EVIDENCE_REVISION_CONFLICT` and force `HOLD`. The canonical request also binds a SHA-256 of the **entire deduplicated revision history**, not only the latest evidence row, so mutating a superseded revision changes claim/receipt identity and invalidates semantic verification even when the latest revision is unchanged.

Every runtime object boundary uses an exact key set. Unknown top-level, order, line, request, selection, evidence, or verification fields are rejected rather than silently ignored, preventing unbound caller semantics from riding alongside an otherwise valid receipt.

## Fail-closed behavior

The compiler rejects malformed or ambiguous inputs including:

- empty/unknown/duplicate line selections;
- zero, negative, fractional, or over-purchased quantities;
- unsupported order status, payment method, symptom, or evidence kind;
- non-canonical or impossible UTC chronology;
- future evidence captures;
- `OTHER` without bounded explanatory text;
- malformed/uppercase/truncated evidence digests;
- non-integer evidence revisions, including JavaScript bool-like/type aliases;
- PII-, credential-, URL-, or path-shaped durable evidence references.

A syntactically valid packet is held rather than readied when:

- the order is not post-shipment;
- current Stellar evidence cannot verify the exact order as `Shipped`;
- the chain read predates the request or is older than five minutes;
- the order is card-based and therefore lacks independent buyer-side shipment/payment authority in this module;
- evidence revision lineage conflicts.

`verifyWarrantyReviewPacket(packet, source)` recompiles the source and compares canonical semantics, so receipt, blocker, authority, digest, and request tampering all fail verification.

## Authority ceiling

Every receipt permanently records `false` for warranty existence/coverage determination, product-defect determination, fault/liability determination, refund, exchange, repair, replacement, payment, inventory mutation, and merchant-contact authority.

WarrantyCare therefore does **not**:

- assert that any warranty exists, is legally required, remains in term, or covers an alleged condition;
- diagnose a product defect or admit fault/liability;
- approve or execute a repair, replacement, exchange, refund, payment, or inventory reservation;
- sign a wallet transaction or call Soroban `dispatch`/`refund`;
- write Supabase/provider state or create a support ticket;
- contact the merchant or buyer;
- establish buyer acceptance, settlement, cash, accounting, or recognized revenue.

It is a review-evidence boundary only. Merchant policy, warranty terms, legal interpretation, remedy choice, and every external action remain outside this module.
