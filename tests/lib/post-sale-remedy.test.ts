import { describe, expect, it } from "vitest";
import { compileReturnReview, type CompileReturnReviewInput } from "../../lib/return-review";
import { compileWarrantyReview, type CompileWarrantyReviewInput } from "../../lib/warranty-review";
import {
  canonicalPostSaleRemedyJson,
  compilePostSaleRemedy,
  type CompilePostSaleRemedyInput,
  type MerchantRemedyDecision,
  type ReturnRemedySource,
  type WarrantyRemedySource,
  verifyPostSaleRemedyPacket,
} from "../../lib/post-sale-remedy";

const H64 = "a".repeat(64);

function returnSourceInput(): CompileReturnReviewInput {
  return {
    order: {
      orderId: "order-remedy-return-1",
      paymentMethod: "stellar",
      status: "Shipped",
      createdAt: "2026-09-13T20:00:00.000Z",
      items: [{ id: "sku-return-1", name: "Trail Shell", price: 120, quantity: 2 }],
    },
    request: {
      requestedAt: "2026-09-13T21:00:00.000Z",
      reason: "DEFECTIVE",
      selections: [{ lineIndex: 0, quantity: 1 }],
    },
    verification: {
      checkedAt: "2026-09-13T21:01:00.000Z",
      verified: true,
      onChainStatus: "Shipped",
    },
    evaluatedAt: "2026-09-13T21:02:00.000Z",
  };
}

function warrantySourceInput(): CompileWarrantyReviewInput {
  return {
    order: {
      orderId: "order-remedy-warranty-1",
      paymentMethod: "stellar",
      status: "Shipped",
      createdAt: "2026-09-13T20:00:00.000Z",
      items: [{ id: "sku-warranty-1", name: "Trail Lamp", quantity: 2 }],
    },
    request: {
      requestedAt: "2026-09-13T21:00:00.000Z",
      firstObservedAt: "2026-09-13T20:30:00.000Z",
      symptom: "NOT_WORKING",
      selections: [{ lineIndex: 0, quantity: 1 }],
      evidence: [],
    },
    verification: {
      checkedAt: "2026-09-13T21:01:00.000Z",
      verified: true,
      onChainStatus: "Shipped",
    },
    evaluatedAt: "2026-09-13T21:02:00.000Z",
  };
}

function decision(
  sourcePacketDigest: string,
  action: MerchantRemedyDecision["action"] = "APPROVE_REFUND_REVIEW_HANDOFF",
  reasonCode: MerchantRemedyDecision["reasonCode"] = "EVIDENCE_SUFFICIENT"
): MerchantRemedyDecision {
  return {
    decisionId: "decision-remedy-1",
    decidedAt: "2026-09-13T21:03:00.000Z",
    action,
    reasonCode,
    evidenceRef: "merchant-review-1",
    evidenceSha256: H64,
    sourcePacketDigest,
  };
}

type ReturnCompileInput = CompilePostSaleRemedyInput & { source: ReturnRemedySource };
type WarrantyCompileInput = CompilePostSaleRemedyInput & { source: WarrantyRemedySource };

async function validReturnCompileInput(): Promise<ReturnCompileInput> {
  const sourceInput = returnSourceInput();
  const packet = await compileReturnReview(sourceInput);
  return {
    source: { kind: "RETURN", packet, input: sourceInput },
    decisions: [decision(packet.receipt.packetDigest)],
    evaluatedAt: "2026-09-13T21:04:00.000Z",
  };
}

async function validWarrantyCompileInput(): Promise<WarrantyCompileInput> {
  const sourceInput = warrantySourceInput();
  const packet = await compileWarrantyReview(sourceInput);
  return {
    source: { kind: "WARRANTY", packet, input: sourceInput },
    decisions: [
      decision(
        packet.receipt.packetDigest,
        "APPROVE_REPAIR_REVIEW_HANDOFF",
        "TECHNICAL_REVIEW"
      ),
    ],
    evaluatedAt: "2026-09-13T21:04:00.000Z",
  };
}

describe("post-sale remedy disposition", () => {
  it("creates only an unsent owner-review handoff for a return refund", async () => {
    const packet = await compilePostSaleRemedy(await validReturnCompileInput());
    expect(packet.receipt.state).toBe("READY_FOR_OWNER_EXECUTION_REVIEW");
    expect(packet.receipt.blockers).toEqual([]);
    expect(packet.receipt.ownerExecutionReviewReady).toBe(true);
    expect(packet.handoff?.requestedRemedy).toBe("REFUND");
    expect(packet.handoff?.externalStatus).toBe("NOT_SENT");
    expect(packet.handoff?.stellarRefundAuthorized).toBe(false);
    expect(packet.handoff?.cardRefundAuthorized).toBe(false);
    expect(packet.handoff?.paymentMutationAuthorized).toBe(false);
    expect(packet.handoff?.inventoryMutationAuthorized).toBe(false);
    expect(packet.handoff?.customerContactAuthorized).toBe(false);
    expect(packet.receipt.cashOrRevenueClaimed).toBe(false);
  });

  it.each([
    ["APPROVE_REPLACEMENT_REVIEW_HANDOFF", "REPLACEMENT"],
    ["APPROVE_EXCHANGE_REVIEW_HANDOFF", "EXCHANGE"],
  ] as const)("supports return %s without external authority", async (action, remedy) => {
    const input = await validReturnCompileInput();
    input.decisions = [decision(input.source.packet.receipt.packetDigest, action, "POLICY_ELIGIBLE")];
    const packet = await compilePostSaleRemedy(input);
    expect(packet.receipt.state).toBe("READY_FOR_OWNER_EXECUTION_REVIEW");
    expect(packet.handoff?.requestedRemedy).toBe(remedy);
    expect(packet.handoff?.replacementDispatchAuthorized).toBe(false);
  });

  it("supports a warranty repair handoff while keeping repair execution false", async () => {
    const packet = await compilePostSaleRemedy(await validWarrantyCompileInput());
    expect(packet.receipt.state).toBe("READY_FOR_OWNER_EXECUTION_REVIEW");
    expect(packet.handoff?.requestedRemedy).toBe("REPAIR");
    expect(packet.handoff?.repairWorkAuthorized).toBe(false);
  });

  it("allows refund, replacement and exchange review from warranty evidence", async () => {
    for (const [action, remedy] of [
      ["APPROVE_REFUND_REVIEW_HANDOFF", "REFUND"],
      ["APPROVE_REPLACEMENT_REVIEW_HANDOFF", "REPLACEMENT"],
      ["APPROVE_EXCHANGE_REVIEW_HANDOFF", "EXCHANGE"],
    ] as const) {
      const input = await validWarrantyCompileInput();
      input.decisions = [decision(input.source.packet.receipt.packetDigest, action, "EVIDENCE_SUFFICIENT")];
      const packet = await compilePostSaleRemedy(input);
      expect(packet.receipt.state).toBe("READY_FOR_OWNER_EXECUTION_REVIEW");
      expect(packet.handoff?.requestedRemedy).toBe(remedy);
    }
  });

  it("rejects repair promotion from return-review evidence", async () => {
    const input = await validReturnCompileInput();
    input.decisions = [
      decision(input.source.packet.receipt.packetDigest, "APPROVE_REPAIR_REVIEW_HANDOFF", "TECHNICAL_REVIEW"),
    ];
    const packet = await compilePostSaleRemedy(input);
    expect(packet.receipt.state).toBe("HOLD");
    expect(packet.receipt.blockers).toContain("REPAIR_NOT_SUPPORTED_BY_RETURN_REVIEW");
    expect(packet.handoff).toBeUndefined();
  });

  it.each([
    ["DENY_REMEDY", "POLICY_INELIGIBLE", "REMEDY_DENIED"],
    ["REQUEST_MORE_EVIDENCE", "EVIDENCE_INSUFFICIENT", "MORE_EVIDENCE_REQUIRED"],
    ["HOLD", "OWNER_HOLD", "OWNER_HOLD"],
  ] as const)("maps %s to %s without a handoff", async (action, reason, state) => {
    const input = await validReturnCompileInput();
    input.decisions = [decision(input.source.packet.receipt.packetDigest, action, reason)];
    const packet = await compilePostSaleRemedy(input);
    expect(packet.receipt.state).toBe(state);
    expect(packet.handoff).toBeUndefined();
    expect(packet.receipt.ownerExecutionReviewReady).toBe(false);
  });

  it("fails closed when the exact source packet is tampered", async () => {
    const input = await validReturnCompileInput();
    input.source.packet.receipt.packetDigest = "0".repeat(64);
    const packet = await compilePostSaleRemedy(input);
    expect(packet.receipt.state).toBe("HOLD");
    expect(packet.receipt.blockers).toContain("SOURCE_VERIFICATION_FAILED");
    expect(packet.handoff).toBeUndefined();
  });

  it("fails closed when source input drifts under an unchanged packet", async () => {
    const input = await validReturnCompileInput();
    input.source.input.order.orderId = "different-order";
    const packet = await compilePostSaleRemedy(input);
    expect(packet.receipt.state).toBe("HOLD");
    expect(packet.receipt.blockers).toContain("SOURCE_VERIFICATION_FAILED");
  });

  it("binds the merchant decision to the exact source digest", async () => {
    const input = await validReturnCompileInput();
    input.decisions[0].sourcePacketDigest = "b".repeat(64);
    const packet = await compilePostSaleRemedy(input);
    expect(packet.receipt.state).toBe("HOLD");
    expect(packet.receipt.blockers).toContain("DECISION_SOURCE_DIGEST_MISMATCH");
  });

  it("rejects a decision that predates source review", async () => {
    const input = await validReturnCompileInput();
    input.decisions[0].decidedAt = "2026-09-13T21:01:30.000Z";
    const packet = await compilePostSaleRemedy(input);
    expect(packet.receipt.blockers).toContain("DECISION_PREDATES_SOURCE_REVIEW");
  });

  it("rejects future decision chronology", async () => {
    const input = await validReturnCompileInput();
    input.decisions[0].decidedAt = "2026-09-13T21:05:00.000Z";
    const packet = await compilePostSaleRemedy(input);
    expect(packet.receipt.blockers).toContain("DECISION_IN_FUTURE");
  });

  it("rejects changed bytes under the same decision id", async () => {
    const input = await validReturnCompileInput();
    const changed = { ...input.decisions[0], evidenceRef: "merchant-review-2" };
    input.decisions = [input.decisions[0], changed];
    const packet = await compilePostSaleRemedy(input);
    expect(packet.receipt.state).toBe("HOLD");
    expect(packet.receipt.blockers).toContain("DECISION_ID_REPLAY_CONFLICT");
  });

  it("rejects multiple independent decision identities in v1", async () => {
    const input = await validReturnCompileInput();
    input.decisions = [input.decisions[0], { ...input.decisions[0], decisionId: "decision-remedy-2" }];
    const packet = await compilePostSaleRemedy(input);
    expect(packet.receipt.blockers).toContain("MULTIPLE_DECISION_IDENTITIES");
  });

  it("collapses exact decision replay deterministically", async () => {
    const single = await validReturnCompileInput();
    const replay = await validReturnCompileInput();
    replay.decisions = [replay.decisions[0], structuredClone(replay.decisions[0])];
    const a = await compilePostSaleRemedy(single);
    const b = await compilePostSaleRemedy(replay);
    expect(canonicalPostSaleRemedyJson(a)).toBe(canonicalPostSaleRemedyJson(b));
  });

  it("rejects semantically incompatible action/reason combinations", async () => {
    const input = await validReturnCompileInput();
    input.decisions = [decision(input.source.packet.receipt.packetDigest, "DENY_REMEDY", "GOODWILL")];
    const packet = await compilePostSaleRemedy(input);
    expect(packet.receipt.blockers).toContain("DECISION_REASON_INCOMPATIBLE");
  });

  it.each([
    "merchant@example.com",
    "https://merchant.example/review/1",
    "../merchant-review",
    "folder/review",
    "sk_live_abcdefghijklmnop",
  ])("rejects unsafe decision evidence reference %s", async (evidenceRef) => {
    const input = await validReturnCompileInput();
    input.decisions[0].evidenceRef = evidenceRef;
    await expect(compilePostSaleRemedy(input)).rejects.toThrow();
  });

  it("rejects malformed hashes and timestamps", async () => {
    const badHash = await validReturnCompileInput();
    badHash.decisions[0].evidenceSha256 = "ABC";
    await expect(compilePostSaleRemedy(badHash)).rejects.toThrow();

    const badTime = await validReturnCompileInput();
    badTime.evaluatedAt = "2026-09-13T21:04:00Z";
    await expect(compilePostSaleRemedy(badTime)).rejects.toThrow();
  });

  it("rejects unknown runtime decision keys and bool/string coercion", async () => {
    const unknown = await validReturnCompileInput();
    (unknown.decisions[0] as unknown as Record<string, unknown>).extraAuthority = true;
    await expect(compilePostSaleRemedy(unknown)).rejects.toThrow(/unknown key/);

    const boolAlias = await validReturnCompileInput();
    (boolAlias.decisions[0] as unknown as Record<string, unknown>).action = true;
    await expect(compilePostSaleRemedy(boolAlias)).rejects.toThrow();
  });

  it("keeps a source HOLD as source-not-review-ready instead of promoting it", async () => {
    const sourceInput = returnSourceInput();
    sourceInput.order.status = "Paid";
    sourceInput.verification.onChainStatus = "Paid";
    const sourcePacket = await compileReturnReview(sourceInput);
    expect(sourcePacket.receipt.decision).toBe("HOLD");
    const input: ReturnCompileInput = {
      source: { kind: "RETURN", packet: sourcePacket, input: sourceInput },
      decisions: [decision(sourcePacket.receipt.packetDigest)],
      evaluatedAt: "2026-09-13T21:04:00.000Z",
    };
    const packet = await compilePostSaleRemedy(input);
    expect(packet.receipt.state).toBe("SOURCE_NOT_REVIEW_READY");
    expect(packet.handoff).toBeUndefined();
  });

  it("detects selected-line drift through source re-verification", async () => {
    const input = await validReturnCompileInput();
    input.source.packet.request.lines[0].quantityRequested = 2;
    const packet = await compilePostSaleRemedy(input);
    expect(packet.receipt.state).toBe("HOLD");
    expect(packet.receipt.blockers).toContain("SOURCE_VERIFICATION_FAILED");
  });

  it("rejects a packet transplanted onto a different exact source order", async () => {
    const input = await validReturnCompileInput();
    input.source.input.order.orderId = "different-order";
    const packet = await compilePostSaleRemedy(input);
    expect(packet.receipt.state).toBe("HOLD");
    expect(packet.receipt.blockers).toContain("SOURCE_VERIFICATION_FAILED");
  });

  it("is byte-stable and verifier rejects packet tamper", async () => {
    const input = await validReturnCompileInput();
    const a = await compilePostSaleRemedy(input);
    const b = await compilePostSaleRemedy(structuredClone(input));
    expect(canonicalPostSaleRemedyJson(a)).toBe(canonicalPostSaleRemedyJson(b));
    expect(await verifyPostSaleRemedyPacket(a, input)).toBe(true);

    const tampered = structuredClone(a);
    if (!tampered.handoff) throw new Error("expected handoff");
    tampered.handoff.requestedRemedy = "EXCHANGE";
    expect(await verifyPostSaleRemedyPacket(tampered, input)).toBe(false);
  });
});
