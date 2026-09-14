import {
  type CompileReturnReviewInput,
  type ReturnReviewPacket,
  verifyReturnReviewPacket,
} from "./return-review";
import {
  type CompileWarrantyReviewInput,
  type WarrantyReviewPacket,
  verifyWarrantyReviewPacket,
} from "./warranty-review";

export const POST_SALE_REMEDY_SCHEMA = "mova.post-sale-remedy/v1" as const;

export type RemedySourceKind = "RETURN" | "WARRANTY";
export type RemedyAction =
  | "APPROVE_REFUND_REVIEW_HANDOFF"
  | "APPROVE_REPLACEMENT_REVIEW_HANDOFF"
  | "APPROVE_EXCHANGE_REVIEW_HANDOFF"
  | "APPROVE_REPAIR_REVIEW_HANDOFF"
  | "DENY_REMEDY"
  | "REQUEST_MORE_EVIDENCE"
  | "HOLD";
export type RemedyReasonCode =
  | "EVIDENCE_SUFFICIENT"
  | "EVIDENCE_INSUFFICIENT"
  | "POLICY_ELIGIBLE"
  | "POLICY_INELIGIBLE"
  | "GOODWILL"
  | "TECHNICAL_REVIEW"
  | "OWNER_HOLD";
export type RemedyState =
  | "READY_FOR_OWNER_EXECUTION_REVIEW"
  | "REMEDY_DENIED"
  | "MORE_EVIDENCE_REQUIRED"
  | "OWNER_HOLD"
  | "SOURCE_NOT_REVIEW_READY"
  | "HOLD";
export type RemedyKind = "REFUND" | "REPLACEMENT" | "EXCHANGE" | "REPAIR";

export interface ReturnRemedySource {
  kind: "RETURN";
  packet: ReturnReviewPacket;
  input: CompileReturnReviewInput;
}

export interface WarrantyRemedySource {
  kind: "WARRANTY";
  packet: WarrantyReviewPacket;
  input: CompileWarrantyReviewInput;
}

export type RemedySource = ReturnRemedySource | WarrantyRemedySource;

export interface MerchantRemedyDecision {
  decisionId: string;
  decidedAt: string;
  action: RemedyAction;
  reasonCode: RemedyReasonCode;
  evidenceRef: string;
  evidenceSha256: string;
  sourcePacketDigest: string;
}

export interface CompilePostSaleRemedyInput {
  source: RemedySource;
  decisions: MerchantRemedyDecision[];
  evaluatedAt: string;
}

export interface RemedyLineBinding {
  lineIndex: number;
  id?: string | number;
  name: string;
  quantity: number;
}

export interface RemedyHandoff {
  schemaVersion: typeof POST_SALE_REMEDY_SCHEMA;
  handoffId: string;
  sourceKind: RemedySourceKind;
  sourceReviewId: string;
  sourcePacketDigest: string;
  orderId: string;
  lineSetDigest: string;
  decisionId: string;
  decisionDigest: string;
  requestedRemedy: RemedyKind;
  createdAt: string;
  lines: RemedyLineBinding[];
  externalStatus: "NOT_SENT";
  walletActionAuthorized: false;
  stellarRefundAuthorized: false;
  cardRefundAuthorized: false;
  paymentMutationAuthorized: false;
  inventoryMutationAuthorized: false;
  replacementDispatchAuthorized: false;
  repairWorkAuthorized: false;
  customerContactAuthorized: false;
  providerMutationAuthorized: false;
  buyerAcceptanceClaimed: false;
  cashOrRevenueClaimed: false;
}

export interface PostSaleRemedyReceipt {
  schemaVersion: typeof POST_SALE_REMEDY_SCHEMA;
  state: RemedyState;
  blockers: string[];
  sourceKind: RemedySourceKind;
  sourceReviewId: string;
  sourcePacketDigest: string;
  orderId: string;
  lineSetDigest: string;
  decisionId?: string;
  decisionDigest?: string;
  handoffDigest?: string;
  evaluatedAt: string;
  ownerExecutionReviewReady: boolean;
  externalActionAuthorized: false;
  walletActionAuthorized: false;
  paymentMutationAuthorized: false;
  inventoryMutationAuthorized: false;
  customerContactAuthorized: false;
  providerMutationAuthorized: false;
  buyerAcceptanceClaimed: false;
  cashOrRevenueClaimed: false;
  packetDigest: string;
}

export interface PostSaleRemedyPacket {
  schemaVersion: typeof POST_SALE_REMEDY_SCHEMA;
  source: {
    kind: RemedySourceKind;
    sourceReviewId: string;
    sourcePacketDigest: string;
    orderId: string;
    lineSetDigest: string;
    lines: RemedyLineBinding[];
  };
  decision?: MerchantRemedyDecision;
  handoff?: RemedyHandoff;
  receipt: PostSaleRemedyReceipt;
}

export class PostSaleRemedyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostSaleRemedyValidationError";
  }
}

const SHA256_RE = /^[0-9a-f]{64}$/;
const OPAQUE_RE = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/;
const PII_RE = /(?:[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\b(?:https?:\/\/|www\.)|\b(?:\+?1[-. ]?)?\(?\d{3}\)?[-. ]\d{3}[-. ]\d{4}\b)/i;
const SECRET_RE = /(?:sk_(?:live|test)_[A-Za-z0-9]{8,}|pk_(?:live|test)_[A-Za-z0-9]{8,}|gh[pousr]_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|api[_-]?key|bearer[:._-]?[A-Za-z0-9]{10,})/i;

function assertPlainObject(value: unknown, field: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PostSaleRemedyValidationError(`${field} must be an object`);
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new PostSaleRemedyValidationError(`${field} must be a plain object`);
  }
}

function assertKeys(
  value: unknown,
  field: string,
  required: readonly string[],
  optional: readonly string[] = []
): asserts value is Record<string, unknown> {
  assertPlainObject(value, field);
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new PostSaleRemedyValidationError(`${field} is missing ${key}`);
    }
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new PostSaleRemedyValidationError(`${field} contains unknown key ${key}`);
    }
  }
}

function canonicalUtc(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new PostSaleRemedyValidationError(`${field} must be a canonical UTC timestamp`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new PostSaleRemedyValidationError(`${field} must be a canonical UTC timestamp`);
  }
  return value;
}

function sha256Value(value: unknown, field: string): string {
  if (typeof value !== "string" || !SHA256_RE.test(value)) {
    throw new PostSaleRemedyValidationError(`${field} must be lowercase SHA-256`);
  }
  return value;
}

function boundedSourceText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") {
    throw new PostSaleRemedyValidationError(`${field} must be text`);
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > max || /\p{C}/u.test(normalized)) {
    throw new PostSaleRemedyValidationError(`${field} is invalid`);
  }
  return normalized;
}

function opaqueText(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new PostSaleRemedyValidationError(`${field} must be an opaque identifier`);
  }
  const normalized = value.trim();
  if (
    !OPAQUE_RE.test(normalized) ||
    normalized.includes("..") ||
    normalized.includes("/") ||
    normalized.includes("\\") ||
    PII_RE.test(normalized) ||
    SECRET_RE.test(normalized)
  ) {
    throw new PostSaleRemedyValidationError(`${field} must be a non-PII, non-secret opaque identifier`);
  }
  return normalized;
}

function stableProjection(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableProjection);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, stableProjection(entry)])
    );
  }
  return value;
}

export function canonicalPostSaleRemedyJson(value: unknown): string {
  return JSON.stringify(stableProjection(value));
}

export async function postSaleRemedySha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizeAction(value: unknown): RemedyAction {
  const allowed: RemedyAction[] = [
    "APPROVE_REFUND_REVIEW_HANDOFF",
    "APPROVE_REPLACEMENT_REVIEW_HANDOFF",
    "APPROVE_EXCHANGE_REVIEW_HANDOFF",
    "APPROVE_REPAIR_REVIEW_HANDOFF",
    "DENY_REMEDY",
    "REQUEST_MORE_EVIDENCE",
    "HOLD",
  ];
  if (typeof value !== "string" || !allowed.includes(value as RemedyAction)) {
    throw new PostSaleRemedyValidationError("decision.action is unsupported");
  }
  return value as RemedyAction;
}

function normalizeReason(value: unknown): RemedyReasonCode {
  const allowed: RemedyReasonCode[] = [
    "EVIDENCE_SUFFICIENT",
    "EVIDENCE_INSUFFICIENT",
    "POLICY_ELIGIBLE",
    "POLICY_INELIGIBLE",
    "GOODWILL",
    "TECHNICAL_REVIEW",
    "OWNER_HOLD",
  ];
  if (typeof value !== "string" || !allowed.includes(value as RemedyReasonCode)) {
    throw new PostSaleRemedyValidationError("decision.reasonCode is unsupported");
  }
  return value as RemedyReasonCode;
}

function normalizeDecision(input: MerchantRemedyDecision): MerchantRemedyDecision {
  assertKeys(input, "decision", [
    "decisionId",
    "decidedAt",
    "action",
    "reasonCode",
    "evidenceRef",
    "evidenceSha256",
    "sourcePacketDigest",
  ]);
  return {
    decisionId: opaqueText(input.decisionId, "decision.decisionId"),
    decidedAt: canonicalUtc(input.decidedAt, "decision.decidedAt"),
    action: normalizeAction(input.action),
    reasonCode: normalizeReason(input.reasonCode),
    evidenceRef: opaqueText(input.evidenceRef, "decision.evidenceRef"),
    evidenceSha256: sha256Value(input.evidenceSha256, "decision.evidenceSha256"),
    sourcePacketDigest: sha256Value(input.sourcePacketDigest, "decision.sourcePacketDigest"),
  };
}

function normalizeDecisionSet(decisions: MerchantRemedyDecision[]) {
  if (!Array.isArray(decisions) || decisions.length === 0 || decisions.length > 16) {
    throw new PostSaleRemedyValidationError("decisions must contain 1-16 events");
  }
  const byId = new Map<string, MerchantRemedyDecision>();
  let replayConflict = false;
  for (let i = 0; i < decisions.length; i += 1) {
    const normalized = normalizeDecision(decisions[i]);
    const prior = byId.get(normalized.decisionId);
    if (prior) {
      if (canonicalPostSaleRemedyJson(prior) !== canonicalPostSaleRemedyJson(normalized)) {
        replayConflict = true;
      }
      continue;
    }
    byId.set(normalized.decisionId, normalized);
  }
  const unique = Array.from(byId.values()).sort((a, b) => a.decisionId.localeCompare(b.decisionId));
  return { unique, replayConflict };
}

function normalizeLine(
  line: Record<string, unknown>,
  quantityKey: "quantityRequested" | "quantityClaimed",
  index: number
): RemedyLineBinding {
  const lineIndex = line.lineIndex;
  if (typeof lineIndex !== "number" || !Number.isSafeInteger(lineIndex) || lineIndex < 0) {
    throw new PostSaleRemedyValidationError(`source lines[${index}].lineIndex is invalid`);
  }
  const name = line.name;
  if (typeof name !== "string" || name.trim().length === 0 || name.length > 512 || /\p{C}/u.test(name)) {
    throw new PostSaleRemedyValidationError(`source lines[${index}].name is invalid`);
  }
  const quantity = line[quantityKey];
  if (typeof quantity !== "number" || !Number.isSafeInteger(quantity) || quantity <= 0 || quantity > 999) {
    throw new PostSaleRemedyValidationError(`source lines[${index}].${quantityKey} is invalid`);
  }
  let id: string | number | undefined;
  if (line.id !== undefined) {
    if (typeof line.id === "string") {
      if (line.id.trim().length === 0 || line.id.length > 256 || /\p{C}/u.test(line.id)) {
        throw new PostSaleRemedyValidationError(`source lines[${index}].id is invalid`);
      }
      id = line.id;
    } else if (typeof line.id === "number" && Number.isSafeInteger(line.id)) {
      id = line.id;
    } else {
      throw new PostSaleRemedyValidationError(`source lines[${index}].id is invalid`);
    }
  }
  return {
    lineIndex,
    ...(id === undefined ? {} : { id }),
    name: name.trim(),
    quantity,
  };
}

function reasonCompatible(action: RemedyAction, reason: RemedyReasonCode): boolean {
  if (action === "REQUEST_MORE_EVIDENCE") {
    return reason === "EVIDENCE_INSUFFICIENT" || reason === "TECHNICAL_REVIEW";
  }
  if (action === "HOLD") {
    return reason === "OWNER_HOLD" || reason === "TECHNICAL_REVIEW";
  }
  if (action === "DENY_REMEDY") {
    return (
      reason === "POLICY_INELIGIBLE" ||
      reason === "EVIDENCE_INSUFFICIENT" ||
      reason === "TECHNICAL_REVIEW"
    );
  }
  return (
    reason === "EVIDENCE_SUFFICIENT" ||
    reason === "POLICY_ELIGIBLE" ||
    reason === "GOODWILL" ||
    reason === "TECHNICAL_REVIEW"
  );
}

function remedyForAction(action: RemedyAction): RemedyKind | undefined {
  if (action === "APPROVE_REFUND_REVIEW_HANDOFF") return "REFUND";
  if (action === "APPROVE_REPLACEMENT_REVIEW_HANDOFF") return "REPLACEMENT";
  if (action === "APPROVE_EXCHANGE_REVIEW_HANDOFF") return "EXCHANGE";
  if (action === "APPROVE_REPAIR_REVIEW_HANDOFF") return "REPAIR";
  return undefined;
}

async function inspectSource(source: RemedySource) {
  assertKeys(source, "source", ["kind", "packet", "input"]);
  if (source.kind === "RETURN") {
    const packet = source.packet;
    if (packet.schemaVersion !== "mova.return-review/v1") {
      throw new PostSaleRemedyValidationError("return source schema is unsupported");
    }
    const verified = await verifyReturnReviewPacket(packet, source.input);
    const lines = packet.request.lines.map((line, index) =>
      normalizeLine(line as unknown as Record<string, unknown>, "quantityRequested", index)
    );
    lines.sort((a, b) => a.lineIndex - b.lineIndex);
    return {
      kind: "RETURN" as const,
      verified,
      ready: packet.receipt.decision === "READY_FOR_MERCHANT_RETURN_REVIEW",
      sourceReviewId: boundedSourceText(packet.request.requestId, "source.requestId", 192),
      sourcePacketDigest: sha256Value(packet.receipt.packetDigest, "source.packetDigest"),
      orderId: boundedSourceText(packet.order.orderId, "source.orderId", 128),
      sourceEvaluatedAt: canonicalUtc(packet.receipt.evaluatedAt, "source.evaluatedAt"),
      lines,
    };
  }
  if (source.kind === "WARRANTY") {
    const packet = source.packet;
    if (packet.schemaVersion !== "mova.warranty-review/v1") {
      throw new PostSaleRemedyValidationError("warranty source schema is unsupported");
    }
    const verified = await verifyWarrantyReviewPacket(packet, source.input);
    const lines = packet.request.lines.map((line, index) =>
      normalizeLine(line as unknown as Record<string, unknown>, "quantityClaimed", index)
    );
    lines.sort((a, b) => a.lineIndex - b.lineIndex);
    return {
      kind: "WARRANTY" as const,
      verified,
      ready: packet.receipt.decision === "READY_FOR_MERCHANT_WARRANTY_REVIEW",
      sourceReviewId: boundedSourceText(packet.request.claimId, "source.claimId", 192),
      sourcePacketDigest: sha256Value(packet.receipt.packetDigest, "source.packetDigest"),
      orderId: boundedSourceText(packet.order.orderId, "source.orderId", 128),
      sourceEvaluatedAt: canonicalUtc(packet.receipt.evaluatedAt, "source.evaluatedAt"),
      lines,
    };
  }
  throw new PostSaleRemedyValidationError("source.kind is unsupported");
}

export async function compilePostSaleRemedy(
  input: CompilePostSaleRemedyInput
): Promise<PostSaleRemedyPacket> {
  assertKeys(input, "input", ["source", "decisions", "evaluatedAt"]);
  const evaluatedAt = canonicalUtc(input.evaluatedAt, "evaluatedAt");
  const source = await inspectSource(input.source);
  const decisionSet = normalizeDecisionSet(input.decisions);
  const blockers: string[] = [];

  const lineSetDigest = await postSaleRemedySha256Hex(canonicalPostSaleRemedyJson(source.lines));
  if (!source.verified) blockers.push("SOURCE_VERIFICATION_FAILED");
  if (decisionSet.replayConflict) blockers.push("DECISION_ID_REPLAY_CONFLICT");
  if (decisionSet.unique.length !== 1) blockers.push("MULTIPLE_DECISION_IDENTITIES");

  const decision = decisionSet.unique.length === 1 ? decisionSet.unique[0] : undefined;
  const evaluatedMs = new Date(evaluatedAt).getTime();
  const sourceEvaluatedMs = new Date(source.sourceEvaluatedAt).getTime();
  if (sourceEvaluatedMs > evaluatedMs) blockers.push("SOURCE_EVALUATED_IN_FUTURE");

  let decisionDigest: string | undefined;
  if (decision) {
    decisionDigest = await postSaleRemedySha256Hex(canonicalPostSaleRemedyJson(decision));
    const decidedMs = new Date(decision.decidedAt).getTime();
    if (decidedMs < sourceEvaluatedMs) blockers.push("DECISION_PREDATES_SOURCE_REVIEW");
    if (decidedMs > evaluatedMs) blockers.push("DECISION_IN_FUTURE");
    if (decision.sourcePacketDigest !== source.sourcePacketDigest) {
      blockers.push("DECISION_SOURCE_DIGEST_MISMATCH");
    }
    if (!reasonCompatible(decision.action, decision.reasonCode)) {
      blockers.push("DECISION_REASON_INCOMPATIBLE");
    }
    if (source.kind === "RETURN" && decision.action === "APPROVE_REPAIR_REVIEW_HANDOFF") {
      blockers.push("REPAIR_NOT_SUPPORTED_BY_RETURN_REVIEW");
    }
  }

  let state: RemedyState;
  if (blockers.length > 0) {
    state = "HOLD";
  } else if (!source.ready) {
    state = "SOURCE_NOT_REVIEW_READY";
  } else if (!decision) {
    state = "HOLD";
    blockers.push("DECISION_REQUIRED");
  } else if (decision.action === "DENY_REMEDY") {
    state = "REMEDY_DENIED";
  } else if (decision.action === "REQUEST_MORE_EVIDENCE") {
    state = "MORE_EVIDENCE_REQUIRED";
  } else if (decision.action === "HOLD") {
    state = "OWNER_HOLD";
  } else {
    state = "READY_FOR_OWNER_EXECUTION_REVIEW";
  }

  let handoff: RemedyHandoff | undefined;
  let handoffDigest: string | undefined;
  if (state === "READY_FOR_OWNER_EXECUTION_REVIEW" && decision && decisionDigest) {
    const requestedRemedy = remedyForAction(decision.action);
    if (!requestedRemedy) {
      throw new PostSaleRemedyValidationError("approved remedy action has no handoff mapping");
    }
    const handoffSeed = {
      schemaVersion: POST_SALE_REMEDY_SCHEMA,
      sourceKind: source.kind,
      sourceReviewId: source.sourceReviewId,
      sourcePacketDigest: source.sourcePacketDigest,
      orderId: source.orderId,
      lineSetDigest,
      decisionId: decision.decisionId,
      decisionDigest,
      requestedRemedy,
      createdAt: evaluatedAt,
      lines: source.lines,
      externalStatus: "NOT_SENT" as const,
      walletActionAuthorized: false as const,
      stellarRefundAuthorized: false as const,
      cardRefundAuthorized: false as const,
      paymentMutationAuthorized: false as const,
      inventoryMutationAuthorized: false as const,
      replacementDispatchAuthorized: false as const,
      repairWorkAuthorized: false as const,
      customerContactAuthorized: false as const,
      providerMutationAuthorized: false as const,
      buyerAcceptanceClaimed: false as const,
      cashOrRevenueClaimed: false as const,
    };
    const handoffId = `handoff:${(await postSaleRemedySha256Hex(canonicalPostSaleRemedyJson(handoffSeed))).slice(0, 32)}`;
    handoff = { ...handoffSeed, handoffId };
    handoffDigest = await postSaleRemedySha256Hex(canonicalPostSaleRemedyJson(handoff));
  }

  blockers.sort();
  const receiptCore = {
    schemaVersion: POST_SALE_REMEDY_SCHEMA,
    state,
    blockers,
    sourceKind: source.kind,
    sourceReviewId: source.sourceReviewId,
    sourcePacketDigest: source.sourcePacketDigest,
    orderId: source.orderId,
    lineSetDigest,
    ...(decision ? { decisionId: decision.decisionId } : {}),
    ...(decisionDigest ? { decisionDigest } : {}),
    ...(handoffDigest ? { handoffDigest } : {}),
    evaluatedAt,
    ownerExecutionReviewReady: state === "READY_FOR_OWNER_EXECUTION_REVIEW",
    externalActionAuthorized: false as const,
    walletActionAuthorized: false as const,
    paymentMutationAuthorized: false as const,
    inventoryMutationAuthorized: false as const,
    customerContactAuthorized: false as const,
    providerMutationAuthorized: false as const,
    buyerAcceptanceClaimed: false as const,
    cashOrRevenueClaimed: false as const,
  };
  const packetDigest = await postSaleRemedySha256Hex(canonicalPostSaleRemedyJson(receiptCore));
  const receipt: PostSaleRemedyReceipt = { ...receiptCore, packetDigest };

  return {
    schemaVersion: POST_SALE_REMEDY_SCHEMA,
    source: {
      kind: source.kind,
      sourceReviewId: source.sourceReviewId,
      sourcePacketDigest: source.sourcePacketDigest,
      orderId: source.orderId,
      lineSetDigest,
      lines: source.lines,
    },
    ...(decision ? { decision } : {}),
    ...(handoff ? { handoff } : {}),
    receipt,
  };
}

export async function verifyPostSaleRemedyPacket(
  packet: PostSaleRemedyPacket,
  source: CompilePostSaleRemedyInput
): Promise<boolean> {
  try {
    const rebuilt = await compilePostSaleRemedy(source);
    return canonicalPostSaleRemedyJson(rebuilt) === canonicalPostSaleRemedyJson(packet);
  } catch {
    return false;
  }
}
