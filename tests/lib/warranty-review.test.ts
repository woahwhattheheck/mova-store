import { describe, expect, it } from "vitest";

import {
  CompileWarrantyReviewInput,
  WarrantyReviewValidationError,
  compileWarrantyReview,
  verifyWarrantyReviewPacket,
} from "../../lib/warranty-review";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);

function input(): CompileWarrantyReviewInput {
  return {
    order: {
      orderId: "order-42",
      paymentMethod: "stellar",
      status: "Shipped",
      createdAt: "2026-09-01T12:00:00.000Z",
      items: [
        { id: "sku-1", name: "Widget", quantity: 2 },
        { id: "sku-2", name: "Cable", quantity: 1 },
      ],
    },
    request: {
      requestedAt: "2026-09-13T20:00:00.000Z",
      firstObservedAt: "2026-09-12T19:00:00.000Z",
      symptom: "INTERMITTENT",
      details: "Power cycles under normal use.",
      selections: [{ lineIndex: 0, quantity: 1 }],
      evidence: [
        {
          evidenceId: "photo-1",
          revision: 1,
          kind: "PHOTO_REFERENCE",
          capturedAt: "2026-09-13T19:55:00.000Z",
          sourceRef: "buyer-photo-1",
          sourceSha256: SHA_A,
        },
      ],
    },
    verification: {
      checkedAt: "2026-09-13T20:01:00.000Z",
      verified: true,
      onChainStatus: "Shipped",
    },
    evaluatedAt: "2026-09-13T20:02:00.000Z",
  };
}

describe("WarrantyCare review packets", () => {
  it("builds a deterministic ready packet without remedy authority", async () => {
    const source = input();
    const first = await compileWarrantyReview(source);
    const second = await compileWarrantyReview(source);
    expect(first).toEqual(second);
    expect(first.receipt.decision).toBe("READY_FOR_MERCHANT_WARRANTY_REVIEW");
    expect(first.receipt.warrantyCoverageDetermined).toBe(false);
    expect(first.receipt.refundAuthorized).toBe(false);
    expect(first.receipt.repairAuthorized).toBe(false);
    expect(first.receipt.merchantContactAuthorized).toBe(false);
    expect(await verifyWarrantyReviewPacket(first, source)).toBe(true);
  });

  it("holds card orders instead of inventing shipment/payment authority", async () => {
    const source = input();
    source.order.paymentMethod = "card";
    source.verification = { checkedAt: source.evaluatedAt, verified: false };
    const packet = await compileWarrantyReview(source);
    expect(packet.receipt.decision).toBe("HOLD");
    expect(packet.receipt.blockers).toContain("CARD_ORDER_REQUIRES_MERCHANT_SHIPMENT_EVIDENCE");
  });

  it("holds non-post-shipment orders", async () => {
    const source = input();
    source.order.status = "Paid";
    const packet = await compileWarrantyReview(source);
    expect(packet.receipt.decision).toBe("HOLD");
    expect(packet.receipt.blockers).toContain("ORDER_STATUS_PAID_NOT_POSTSHIP");
  });

  it("holds stale or mismatched Stellar evidence", async () => {
    const stale = input();
    stale.verification.checkedAt = "2026-09-13T19:00:00.000Z";
    const stalePacket = await compileWarrantyReview(stale);
    expect(stalePacket.receipt.blockers).toContain("CHAIN_CHECK_PREDATES_REQUEST");
    expect(stalePacket.receipt.blockers).toContain("CURRENT_CHAIN_CHECK_STALE");

    const wrong = input();
    wrong.verification.onChainStatus = "Refunded";
    const wrongPacket = await compileWarrantyReview(wrong);
    expect(wrongPacket.receipt.blockers).toContain("CURRENT_CHAIN_STATUS_NOT_SHIPPED");
  });

  it("rejects quantity ambiguity and over-claim", async () => {
    const zero = input();
    zero.request.selections[0].quantity = 0;
    await expect(compileWarrantyReview(zero)).rejects.toBeInstanceOf(WarrantyReviewValidationError);

    const over = input();
    over.request.selections[0].quantity = 3;
    await expect(compileWarrantyReview(over)).rejects.toBeInstanceOf(WarrantyReviewValidationError);

    const duplicate = input();
    duplicate.request.selections.push({ lineIndex: 0, quantity: 1 });
    await expect(compileWarrantyReview(duplicate)).rejects.toBeInstanceOf(WarrantyReviewValidationError);
  });

  it("rejects impossible or future chronology", async () => {
    const beforeOrder = input();
    beforeOrder.request.firstObservedAt = "2026-08-31T23:00:00.000Z";
    await expect(compileWarrantyReview(beforeOrder)).rejects.toBeInstanceOf(WarrantyReviewValidationError);

    const afterRequest = input();
    afterRequest.request.firstObservedAt = "2026-09-13T20:00:01.000Z";
    await expect(compileWarrantyReview(afterRequest)).rejects.toBeInstanceOf(WarrantyReviewValidationError);

    const futureEvidence = input();
    futureEvidence.request.evidence![0].capturedAt = "2026-09-13T20:03:00.000Z";
    await expect(compileWarrantyReview(futureEvidence)).rejects.toBeInstanceOf(WarrantyReviewValidationError);
  });

  it("requires details for OTHER and bounds free text", async () => {
    const missing = input();
    missing.request.symptom = "OTHER";
    delete missing.request.details;
    await expect(compileWarrantyReview(missing)).rejects.toBeInstanceOf(WarrantyReviewValidationError);

    const long = input();
    long.request.details = "x".repeat(501);
    await expect(compileWarrantyReview(long)).rejects.toBeInstanceOf(WarrantyReviewValidationError);
  });

  it("rejects PII/credential/path-shaped evidence references", async () => {
    for (const sourceRef of ["person@example.com", "https://example.com/photo", "../photo", "sk_live_ABCDEFGHIJKLMNOP"]) {
      const source = input();
      source.request.evidence![0].sourceRef = sourceRef;
      await expect(compileWarrantyReview(source)).rejects.toBeInstanceOf(WarrantyReviewValidationError);
    }
  });

  it("collapses exact evidence replay but holds changed same identity/revision", async () => {
    const replay = input();
    replay.request.evidence!.push({ ...replay.request.evidence![0] });
    const packet = await compileWarrantyReview(replay);
    expect(packet.receipt.decision).toBe("READY_FOR_MERCHANT_WARRANTY_REVIEW");
    expect(packet.request.evidence).toHaveLength(1);

    const conflict = input();
    conflict.request.evidence!.push({ ...conflict.request.evidence![0], sourceSha256: SHA_B });
    const conflictPacket = await compileWarrantyReview(conflict);
    expect(conflictPacket.receipt.decision).toBe("HOLD");
    expect(conflictPacket.receipt.blockers).toContain("EVIDENCE_REVISION_CONFLICT");
  });

  it("holds evidence lineage kind changes or capture rollback", async () => {
    const source = input();
    source.request.evidence!.push({
      ...source.request.evidence![0],
      revision: 2,
      kind: "DIAGNOSTIC_REFERENCE",
      capturedAt: "2026-09-13T19:00:00.000Z",
      sourceSha256: SHA_B,
    });
    const packet = await compileWarrantyReview(source);
    expect(packet.receipt.decision).toBe("HOLD");
    expect(packet.receipt.blockers).toContain("EVIDENCE_REVISION_CONFLICT");
  });

  it("sorts selections/evidence for order-independent semantics", async () => {
    const source = input();
    source.request.selections.push({ lineIndex: 1, quantity: 1 });
    source.request.evidence!.push({
      evidenceId: "diag-1",
      revision: 1,
      kind: "DIAGNOSTIC_REFERENCE",
      capturedAt: "2026-09-13T19:56:00.000Z",
      sourceRef: "diag-ref-1",
      sourceSha256: SHA_B,
    });
    const first = await compileWarrantyReview(source);
    source.request.selections.reverse();
    source.request.evidence!.reverse();
    const second = await compileWarrantyReview(source);
    expect(second).toEqual(first);
  });

  it("rejects bool/fractional revisions and malformed digests", async () => {
    const boolRevision = input();
    (boolRevision.request.evidence![0] as unknown as { revision: unknown }).revision = true;
    await expect(compileWarrantyReview(boolRevision)).rejects.toBeInstanceOf(WarrantyReviewValidationError);

    const fraction = input();
    fraction.request.evidence![0].revision = 1.5;
    await expect(compileWarrantyReview(fraction)).rejects.toBeInstanceOf(WarrantyReviewValidationError);

    const digest = input();
    digest.request.evidence![0].sourceSha256 = "ABC";
    await expect(compileWarrantyReview(digest)).rejects.toBeInstanceOf(WarrantyReviewValidationError);
  });

  it("rejects unknown runtime keys at every authority boundary", async () => {
    const mutations: Array<(source: Record<string, any>) => void> = [
      (source) => { source.extra = "ignored-before-hardening"; },
      (source) => { source.order.extra = "ignored-before-hardening"; },
      (source) => { source.order.items[0].extra = "ignored-before-hardening"; },
      (source) => { source.request.extra = "ignored-before-hardening"; },
      (source) => { source.request.selections[0].extra = "ignored-before-hardening"; },
      (source) => { source.request.evidence[0].extra = "ignored-before-hardening"; },
      (source) => { source.verification.extra = "ignored-before-hardening"; },
    ];

    for (const mutate of mutations) {
      const source = input() as unknown as Record<string, any>;
      mutate(source);
      await expect(
        compileWarrantyReview(source as unknown as CompileWarrantyReviewInput)
      ).rejects.toBeInstanceOf(WarrantyReviewValidationError);
    }
  });

  it("binds superseded evidence revisions into claim and packet identity", async () => {
    const source = input();
    source.request.evidence!.push({
      ...source.request.evidence![0],
      revision: 2,
      capturedAt: "2026-09-13T19:56:00.000Z",
      sourceRef: "buyer-photo-2",
      sourceSha256: SHA_B,
    });
    const original = await compileWarrantyReview(source);
    expect(original.receipt.decision).toBe("READY_FOR_MERCHANT_WARRANTY_REVIEW");
    expect(original.request.evidence).toHaveLength(1);
    expect(original.request.evidence[0].revision).toBe(2);

    const drifted = structuredClone(source);
    drifted.request.evidence![0].sourceSha256 = SHA_C;
    const changed = await compileWarrantyReview(drifted);

    expect(changed.request.evidence).toEqual(original.request.evidence);
    expect(changed.request.evidenceHistoryDigest).not.toBe(original.request.evidenceHistoryDigest);
    expect(changed.receipt.evidenceDigest).not.toBe(original.receipt.evidenceDigest);
    expect(changed.receipt.requestDigest).not.toBe(original.receipt.requestDigest);
    expect(changed.receipt.claimId).not.toBe(original.receipt.claimId);
    expect(changed.receipt.packetDigest).not.toBe(original.receipt.packetDigest);
    expect(await verifyWarrantyReviewPacket(original, drifted)).toBe(false);
  });

  it("detects packet/source tamper semantically", async () => {
    const source = input();
    const packet = await compileWarrantyReview(source);
    const tampered = structuredClone(packet);
    tampered.receipt.packetDigest = "0".repeat(64);
    expect(await verifyWarrantyReviewPacket(tampered, source)).toBe(false);

    const drifted = input();
    drifted.request.symptom = "NOT_WORKING";
    expect(await verifyWarrantyReviewPacket(packet, drifted)).toBe(false);
  });
});
