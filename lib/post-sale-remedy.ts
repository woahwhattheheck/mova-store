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

function object(value: unknown, field: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PostSaleRemedyValidationError(`${field} must be an object`);
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new PostSaleRemedyValidationError(`${field} must be a plain object`);
  }
}

function keys(
  value: unknown,
  field: string,
  required: readonly string[],
  optional: readonly string[] = []
): asserts value is Record<string, unknown> {
  object(value, field);
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new PostSaleRemedyValidationError(`${field} is missing ${key}`);
    }
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new PostSaleRemedyValidationError(`${field} contains unknown key ${key}`);
  }
}

function array(value: unknown, field: string): asserts value is unknown[] {
  if (!Array.isArray(value)) throw new PostSaleRemedyValidationError(`${field} must be an array`);
}

function canonicalUtc(value: unknown, field: string): string {
  if (typeof value !== "string") throw new PostSaleRemedyValidationError(`${field} must be canonical UTC`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new PostSaleRemedyValidationError(`${field} must be canonical UTC`);
  }
  return value;
}

function wholeSecondUtc(value: unknown, field: string): string {
  const canonical = canonicalUtc(value, field);
  if (new Date(canonical).getUTCMilliseconds() !== 0) {
    throw new PostSaleRemedyValidationError(`${field} must use whole-second UTC precision`);
  }
  return canonical;
}

function digest(value: unknown, field: string): string {
  if (typeof value !== "string" || !SHA256_RE.test(value)) {
    throw new PostSaleRemedyValidationError(`${field} must be lowercase SHA-256`);
  }
  return value;
}

function sourceText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") throw new PostSaleRemedyValidationError(`${field} must be text`);
  const normalized = value.trim();
  if (!normalized || normalized.length > max || /\p{C}/u.test(normalized)) {
    throw new PostSaleRemedyValidationError(`${field} is invalid`);
  }
  return normalized;
}

function opaque(value: unknown, field: string): string {
  if (typeof value !== "string") throw new PostSaleRemedyValidationError(`${field} must be opaque`);
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

function project(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(project);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, project(entry)])
    );
  }
  return value;
}

export function canonicalPostSaleRemedyJson(value: unknown): string {
  return JSON.stringify(project(value));
}

export async function postSaleRemedySha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const result = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(result), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function action(value: unknown): RemedyAction {
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

function reason(value: unknown): RemedyReasonCode {
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

function normalizeDecision(value: MerchantRemedyDecision): MerchantRemedyDecision {
  keys(value, "decision", [
    "decisionId",
    "decidedAt",
    "action",
    "reasonCode",
    "evidenceRef",
    "evidenceSha256",
    "sourcePacketDigest",
  ]);
  return {
    decisionId: opaque(value.decisionId, "decision.decisionId"),
    decidedAt: wholeSecondUtc(value.decidedAt, "decision.decidedAt"),
    action: action(value.action),
    reasonCode: reason(value.reasonCode),
    evidenceRef: opaque(value.evidenceRef, "decision.evidenceRef"),
    evidenceSha256: digest(value.evidenceSha256, "decision.evidenceSha256"),
    sourcePacketDigest: digest(value.sourcePacketDigest, "decision.sourcePacketDigest"),
  };
}

function normalizeDecisions(values: MerchantRemedyDecision[]) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 16) {
    throw new PostSaleRemedyValidationError("decisions must contain 1-16 events");
  }
  const byId = new Map<string, MerchantRemedyDecision>();
  let conflict = false;
  for (const value of values) {
    const normalized = normalizeDecision(value);
    const prior = byId.get(normalized.decisionId);
    if (prior && canonicalPostSaleRemedyJson(prior) !== canonicalPostSaleRemedyJson(normalized)) {
      conflict = true;
    } else if (!prior) {
      byId.set(normalized.decisionId, normalized);
    }
  }
  return { values: [...byId.values()].sort((a, b) => a.decisionId.localeCompare(b.decisionId)), conflict };
}

function validateSourceInput(source: RemedySource): void {
  const input = source.input as unknown;
  keys(input, "source.input", ["order", "request", "verification", "evaluatedAt"]);

  keys(input.order, "source.input.order", ["orderId", "paymentMethod", "status", "createdAt", "items"]);
  array(input.order.items, "source.input.order.items");
  input.order.items.forEach((item, index) => {
    if (source.kind === "RETURN") {
      keys(item, `source.input.order.items[${index}]`, ["name", "price"], ["id", "quantity"]);
    } else {
      keys(item, `source.input.order.items[${index}]`, ["name"], ["id", "quantity"]);
    }
  });

  if (source.kind === "RETURN") {
    keys(input.request, "source.input.request", ["requestedAt", "reason", "selections"], ["details"]);
  } else {
    keys(
      input.request,
      "source.input.request",
      ["requestedAt", "firstObservedAt", "symptom", "selections"],
      ["details", "evidence"]
    );
  }
  array(input.request.selections, "source.input.request.selections");
  input.request.selections.forEach((selection, index) => {
    keys(selection, `source.input.request.selections[${index}]`, ["lineIndex", "quantity"]);
  });

  if (source.kind === "WARRANTY" && input.request.evidence !== undefined) {
    array(input.request.evidence, "source.input.request.evidence");
    input.request.evidence.forEach((entry, index) => {
      keys(
        entry,
        `source.input.request.evidence[${index}]`,
        ["evidenceId", "revision", "kind", "capturedAt", "sourceRef", "sourceSha256"]
      );
    });
  }
  keys(input.verification, "source.input.verification", ["checkedAt", "verified"], ["onChainStatus"]);
}

function line(
  value: Record<string, unknown>,
  quantityKey: "quantityRequested" | "quantityClaimed",
  index: number
): RemedyLineBinding {
  const lineIndex = value.lineIndex;
  if (typeof lineIndex !== "number" || !Number.isSafeInteger(lineIndex) || lineIndex < 0) {
    throw new PostSaleRemedyValidationError(`source lines[${index}].lineIndex is invalid`);
  }
  const name = value.name;
  if (typeof name !== "string" || !name.trim() || name.length > 512 || /\p{C}/u.test(name)) {
    throw new PostSaleRemedyValidationError(`source lines[${index}].name is invalid`);
  }
  const quantity = value[quantityKey];
  if (typeof quantity !== "number" || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 999) {
    throw new PostSaleRemedyValidationError(`source lines[${index}].${quantityKey} is invalid`);
  }
  let id: string | number | undefined;
  if (value.id !== undefined) {
    if (typeof value.id === "string" && value.id.trim() && value.id.length <= 256 && !/\p{C}/u.test(value.id)) {
      id = value.id;
    } else if (typeof value.id === "number" && Number.isSafeInteger(value.id)) {
      id = value.id;
    } else {
      throw new PostSaleRemedyValidationError(`source lines[${index}].id is invalid`);
    }
  }
  return { lineIndex, ...(id === undefined ? {} : { id }), name: name.trim(), quantity };
}

async function inspect(source: RemedySource) {
  keys(source, "source", ["kind", "packet", "input"]);
  if (source.kind !== "RETURN" && source.kind !== "WARRANTY") {
    throw new PostSaleRemedyValidationError("source.kind is unsupported");
  }
  validateSourceInput(source);

  if (source.kind === "RETURN") {
    if (source.packet.schemaVersion !== "mova.return-review/v1") {
      throw new PostSaleRemedyValidationError("return source schema is unsupported");
    }
    const lines = source.packet.request.lines
      .map((value, index) => line(value as unknown as Record<string, unknown>, "quantityRequested", index))
      .sort((a, b) => a.lineIndex - b.lineIndex);
    return {
      kind: "RETURN" as const,
      verified: await verifyReturnReviewPacket(source.packet, source.input),
      ready: source.packet.receipt.decision === "READY_FOR_MERCHANT_RETURN_REVIEW",
      sourceReviewId: sourceText(source.packet.request.requestId, "source.requestId", 192),
      sourcePacketDigest: digest(source.packet.receipt.packetDigest, "source.packetDigest"),
      orderId: sourceText(source.packet.order.orderId, "source.orderId", 128),
      sourceEvaluatedAt: canonicalUtc(source.packet.receipt.evaluatedAt, "source.evaluatedAt"),
      lines,
    };
  }

  if (source.packet.schemaVersion !== "mova.warranty-review/v1") {
    throw new PostSaleRemedyValidationError("warranty source schema is unsupported");
  }
  const lines = source.packet.request.lines
    .map((value, index) => line(value as unknown as Record<string, unknown>, "quantityClaimed", index))
    .sort((a, b) => a.lineIndex - b.lineIndex);
  return {
    kind: "WARRANTY" as const,
    verified: await verifyWarrantyReviewPacket(source.packet, source.input),
    ready: source.packet.receipt.decision === "READY_FOR_MERCHANT_WARRANTY_REVIEW",
    sourceReviewId: sourceText(source.packet.request.claimId, "source.claimId", 192),
    sourcePacketDigest: digest(source.packet.receipt.packetDigest, "source.packetDigest"),
    orderId: sourceText(source.packet.order.orderId, "source.orderId", 128),
    sourceEvaluatedAt: canonicalUtc(source.packet.receipt.evaluatedAt, "source.evaluatedAt"),
    lines,
  };
}

function compatible(actionValue: RemedyAction, reasonValue: RemedyReasonCode): boolean {
  if (actionValue === "REQUEST_MORE_EVIDENCE") {
    return reasonValue === "EVIDENCE_INSUFFICIENT" || reasonValue === "TECHNICAL_REVIEW";
  }
  if (actionValue === "HOLD") return reasonValue === "OWNER_HOLD" || reasonValue === "TECHNICAL_REVIEW";
  if (actionValue === "DENY_REMEDY") {
    return ["POLICY_INELIGIBLE", "EVIDENCE_INSUFFICIENT", "TECHNICAL_REVIEW"].includes(reasonValue);
  }
  return ["EVIDENCE_SUFFICIENT", "POLICY_ELIGIBLE", "GOODWILL", "TECHNICAL_REVIEW"].includes(reasonValue);
}

function remedy(actionValue: RemedyAction): RemedyKind | undefined {
  if (actionValue === "APPROVE_REFUND_REVIEW_HANDOFF") return "REFUND";
  if (actionValue === "APPROVE_REPLACEMENT_REVIEW_HANDOFF") return "REPLACEMENT";
  if (actionValue === "APPROVE_EXCHANGE_REVIEW_HANDOFF") return "EXCHANGE";
  if (actionValue === "APPROVE_REPAIR_REVIEW_HANDOFF") return "REPAIR";
  return undefined;
}

export async function compilePostSaleRemedy(input: CompilePostSaleRemedyInput): Promise<PostSaleRemedyPacket> {
  keys(input, "input", ["source", "decisions", "evaluatedAt"]);
  const evaluatedAt = wholeSecondUtc(input.evaluatedAt, "evaluatedAt");
  const source = await inspect(input.source);
  const decisions = normalizeDecisions(input.decisions);
  const blockers: string[] = [];
  const lineSetDigest = await postSaleRemedySha256Hex(canonicalPostSaleRemedyJson(source.lines));

  if (!source.verified) blockers.push("SOURCE_VERIFICATION_FAILED");
  if (decisions.conflict) blockers.push("DECISION_ID_REPLAY_CONFLICT");
  if (decisions.values.length !== 1) blockers.push("MULTIPLE_DECISION_IDENTITIES");

  const selected = decisions.values.length === 1 ? decisions.values[0] : undefined;
  const evaluatedMs = new Date(evaluatedAt).getTime();
  const sourceMs = new Date(source.sourceEvaluatedAt).getTime();
  if (sourceMs > evaluatedMs) blockers.push("SOURCE_EVALUATED_IN_FUTURE");

  let decisionDigest: string | undefined;
  if (selected) {
    decisionDigest = await postSaleRemedySha256Hex(canonicalPostSaleRemedyJson(selected));
    const decisionMs = new Date(selected.decidedAt).getTime();
    if (decisionMs < sourceMs) blockers.push("DECISION_PREDATES_SOURCE_REVIEW");
    if (decisionMs > evaluatedMs) blockers.push("DECISION_IN_FUTURE");
    if (selected.sourcePacketDigest !== source.sourcePacketDigest) blockers.push("DECISION_SOURCE_DIGEST_MISMATCH");
    if (!compatible(selected.action, selected.reasonCode)) blockers.push("DECISION_REASON_INCOMPATIBLE");
    if (source.kind === "RETURN" && selected.action === "APPROVE_REPAIR_REVIEW_HANDOFF") {
      blockers.push("REPAIR_NOT_SUPPORTED_BY_RETURN_REVIEW");
    }
  }

  let state: RemedyState;
  if (blockers.length) state = "HOLD";
  else if (!source.ready) state = "SOURCE_NOT_REVIEW_READY";
  else if (!selected) state = "HOLD";
  else if (selected.action === "DENY_REMEDY") state = "REMEDY_DENIED";
  else if (selected.action === "REQUEST_MORE_EVIDENCE") state = "MORE_EVIDENCE_REQUIRED";
  else if (selected.action === "HOLD") state = "OWNER_HOLD";
  else state = "READY_FOR_OWNER_EXECUTION_REVIEW";

  let handoff: RemedyHandoff | undefined;
  let handoffDigest: string | undefined;
  if (state === "READY_FOR_OWNER_EXECUTION_REVIEW" && selected && decisionDigest) {
    const requestedRemedy = remedy(selected.action);
    if (!requestedRemedy) throw new PostSaleRemedyValidationError("approved action has no handoff mapping");
    const seed = {
      schemaVersion: POST_SALE_REMEDY_SCHEMA,
      sourceKind: source.kind,
      sourceReviewId: source.sourceReviewId,
      sourcePacketDigest: source.sourcePacketDigest,
      orderId: source.orderId,
      lineSetDigest,
      decisionId: selected.decisionId,
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
    const handoffId = `handoff:${(await postSaleRemedySha256Hex(canonicalPostSaleRemedyJson(seed))).slice(0, 32)}`;
    handoff = { ...seed, handoffId };
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
    ...(selected ? { decisionId: selected.decisionId } : {}),
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
  const receipt: PostSaleRemedyReceipt = {
    ...receiptCore,
    packetDigest: await postSaleRemedySha256Hex(canonicalPostSaleRemedyJson(receiptCore)),
  };
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
    ...(selected ? { decision: selected } : {}),
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
