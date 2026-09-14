import { describe, expect, it } from "vitest";

import {
  CompileReturnReviewInput,
  ReturnReviewValidationError,
  compileReturnReview,
  verifyReturnReviewPacket,
} from "../../lib/return-review";

function input(): CompileReturnReviewInput {
  return {
    order: {
      orderId: "order-42",
      paymentMethod: "stellar",
      status: "Shipped",
      createdAt: "2026-09-12T12:00:00.000Z",
      items: [
        { id: "sku-red-9", name: "Red Runner", price: 99, quantity: 2 },
        { id: "sku-blue-8", name: "Blue Runner", price: 120, quantity: 1 },
      ],
    },
    request: {
      requestedAt: "2026-09-13T21:00:00.000Z",
      reason: "SIZE_FIT",
      details: "Too small",
      selections: [{ lineIndex: 0, quantity: 1 }],
    },
    verification: {
      checkedAt: "2026-09-13T21:00:30.000Z",
      verified: true,
      onChainStatus: "Shipped",
    },
    evaluatedAt: "2026-09-13T21:01:00.000Z",
  };
}

describe("return review compiler", () => {
  it("emits only merchant-review readiness for a fresh verified shipped Stellar order", async () => {
    const packet = await compileReturnReview(input());

    expect(packet.receipt.decision).toBe("READY_FOR_MERCHANT_RETURN_REVIEW");
    expect(packet.receipt.blockers).toEqual([]);
    expect(packet.request.lines).toEqual([
      {
        lineIndex: 0,
        id: "sku-red-9",
        name: "Red Runner",
        quantityPurchased: 2,
        quantityRequested: 1,
      },
    ]);
    expect(packet.receipt.packetDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(packet.receipt).toMatchObject({
      refundAuthorized: false,
      exchangeAuthorized: false,
      dispatchAuthorized: false,
      replacementAuthorized: false,
      paymentAuthorized: false,
      inventoryMutationAuthorized: false,
    });
  });

  it("is deterministic for exact replay and verifies the exact source packet", async () => {
    const source = input();
    const first = await compileReturnReview(source);
    const replay = await compileReturnReview(structuredClone(source));

    expect(replay).toEqual(first);
    await expect(verifyReturnReviewPacket(first, source)).resolves.toBe(true);
  });

  it("changes the tamper-evident digest when selected quantity changes", async () => {
    const first = await compileReturnReview(input());
    const changed = input();
    changed.request.selections[0].quantity = 2;
    const second = await compileReturnReview(changed);

    expect(second.receipt.packetDigest).not.toBe(first.receipt.packetDigest);
    await expect(verifyReturnReviewPacket(first, changed)).resolves.toBe(false);
  });

  it("rejects duplicate, unknown, fractional, zero, and over-purchased line quantities", async () => {
    const duplicate = input();
    duplicate.request.selections.push({ lineIndex: 0, quantity: 1 });
    await expect(compileReturnReview(duplicate)).rejects.toBeInstanceOf(ReturnReviewValidationError);

    const unknown = input();
    unknown.request.selections = [{ lineIndex: 99, quantity: 1 }];
    await expect(compileReturnReview(unknown)).rejects.toBeInstanceOf(ReturnReviewValidationError);

    const fractional = input();
    fractional.request.selections = [{ lineIndex: 0, quantity: 1.5 }];
    await expect(compileReturnReview(fractional)).rejects.toBeInstanceOf(ReturnReviewValidationError);

    const zero = input();
    zero.request.selections = [{ lineIndex: 0, quantity: 0 }];
    await expect(compileReturnReview(zero)).rejects.toBeInstanceOf(ReturnReviewValidationError);

    const overflow = input();
    overflow.request.selections = [{ lineIndex: 0, quantity: 3 }];
    await expect(compileReturnReview(overflow)).rejects.toBeInstanceOf(ReturnReviewValidationError);
  });

  it("holds refunded, paid, unverified, wrong-chain-state, and stale Stellar requests", async () => {
    const refunded = input();
    refunded.order.status = "Refunded";
    refunded.verification.onChainStatus = "Refunded";
    const refundedPacket = await compileReturnReview(refunded);
    expect(refundedPacket.receipt.decision).toBe("HOLD");
    expect(refundedPacket.receipt.blockers).toContain("ORDER_STATUS_REFUNDED_NOT_POSTSHIP");
    expect(refundedPacket.receipt.blockers).toContain("CURRENT_CHAIN_STATUS_NOT_SHIPPED");

    const paid = input();
    paid.order.status = "Paid";
    paid.verification.onChainStatus = "Paid";
    const paidPacket = await compileReturnReview(paid);
    expect(paidPacket.receipt.blockers).toContain("ORDER_STATUS_PAID_NOT_POSTSHIP");

    const unverified = input();
    unverified.verification.verified = false;
    const unverifiedPacket = await compileReturnReview(unverified);
    expect(unverifiedPacket.receipt.blockers).toContain("CURRENT_CHAIN_ORDER_NOT_VERIFIED");

    const stale = input();
    stale.verification.checkedAt = "2026-09-13T20:50:00.000Z";
    const stalePacket = await compileReturnReview(stale);
    expect(stalePacket.receipt.blockers).toContain("CHAIN_CHECK_PREDATES_REQUEST");
    expect(stalePacket.receipt.blockers).toContain("CURRENT_CHAIN_CHECK_STALE");
  });

  it("never lets a card order self-prove payment or shipment authority", async () => {
    const source = input();
    source.order.paymentMethod = "card";
    const packet = await compileReturnReview(source);

    expect(packet.receipt.decision).toBe("HOLD");
    expect(packet.receipt.blockers).toContain(
      "CARD_ORDER_REQUIRES_MERCHANT_PAYMENT_AND_SHIPMENT_EVIDENCE"
    );
    expect(packet.receipt.refundAuthorized).toBe(false);
  });

  it("requires OTHER details and rejects malformed or future chronology", async () => {
    const missingOther = input();
    missingOther.request.reason = "OTHER";
    missingOther.request.details = "";
    await expect(compileReturnReview(missingOther)).rejects.toBeInstanceOf(ReturnReviewValidationError);

    const malformed = input();
    malformed.request.requestedAt = "09/13/2026 21:00";
    await expect(compileReturnReview(malformed)).rejects.toBeInstanceOf(ReturnReviewValidationError);

    const futureRequest = input();
    futureRequest.request.requestedAt = "2026-09-13T21:02:00.000Z";
    await expect(compileReturnReview(futureRequest)).rejects.toThrow("future");

    const predatesOrder = input();
    predatesOrder.request.requestedAt = "2026-09-11T21:00:00.000Z";
    await expect(compileReturnReview(predatesOrder)).rejects.toThrow("predates the order");
  });
});
