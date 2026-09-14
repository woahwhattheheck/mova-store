# Post-sale remedy disposition

`lib/post-sale-remedy.ts` closes the local review gap between Mova's evidence-bound return/warranty intake and any later separately authorized operational remedy.

## What it does

The compiler accepts exactly one already-built return-review or warranty-review source, validates the exact runtime shape of that source input, **re-runs that source module's verifier against the exact source input**, and requires the source receipt to be review-ready. It then binds an immutable merchant decision to the exact source packet digest, order, review/claim identity, and selected line set.

Approved dispositions can create a deterministic local handoff for one of:

- refund review;
- replacement review;
- exchange review;
- repair review (warranty sources only).

The handoff is always `externalStatus: "NOT_SENT"`. A return packet cannot be promoted to repair review. Denial, request-more-evidence, and owner hold are first-class terminal review states and emit no execution handoff.

## Authority boundary

`READY_FOR_OWNER_EXECUTION_REVIEW` means only that the supplied merchant decision is internally coherent with the exact verified source packet. It is **not** execution authority.

The product never:

- signs a wallet transaction or calls the Soroban refund entry point;
- issues or confirms a card refund;
- mutates payment-provider state;
- reserves, decrements, restocks, or otherwise changes inventory;
- authorizes replacement dispatch or repair work;
- buys a shipping label;
- contacts the buyer;
- decides legal return/warranty entitlement, product defect, fault, or liability;
- claims buyer acceptance, settlement, cash, accounting treatment, or revenue.

Every generated handoff and receipt carries those authority fields as false.

## Integrity model

- Source packets are not trusted by self-hash: the existing return/warranty verifier recompiles from the exact source input.
- The wrapper rejects unknown runtime keys in upstream order/request/selection/evidence/verification input before calling the source verifier, so ignored source-input fields cannot become unbound side-channel authority.
- Merchant decision events use exact runtime key sets and controlled enums. Durable authority fields reject URLs, email/phone, path-shaped values, and common credential shapes.
- Merchant `decidedAt` and trusted wrapper `evaluatedAt` must use canonical whole-second UTC; upstream review timestamps retain the source module's canonical UTC precision.
- Exact duplicate decision replay collapses deterministically. Changed bytes under the same decision ID fail closed. Multiple independent decision IDs are a v1 conflict rather than an inferred supersession chain.
- Decision chronology must follow the source review and precede the trusted evaluation time.
- Canonical JSON and SHA-256 bind the selected line set, decision, optional handoff, and final receipt.
- `verifyPostSaleRemedyPacket()` recompiles from the exact source, decision events, and evaluation time; packet self-hash alone is insufficient.

## Composition

This module intentionally leaves these existing systems read-only:

- checkout / paid-order persistence;
- Stellar dispatch/refund;
- Supabase order storage;
- fulfillment tracking;
- return intake;
- warranty intake.

A later executor may consume a review-ready handoff only after it establishes its own independent authority for the actual external action.
