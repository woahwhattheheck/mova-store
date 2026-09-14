export const WARRANTY_REVIEW_SCHEMA = "mova.warranty-review/v1" as const;
export const WARRANTY_VERIFICATION_MAX_AGE_MS = 5 * 60 * 1000;
export const WARRANTY_MAX_EVIDENCE = 12;

export type WarrantySymptom =
  | "NOT_WORKING"
  | "INTERMITTENT"
  | "PHYSICAL_DAMAGE"
  | "MISSING_PART"
  | "PERFORMANCE_DEGRADATION"
  | "OTHER";

export type WarrantyEvidenceKind =
  | "PHOTO_REFERENCE"
  | "VIDEO_REFERENCE"
  | "SERIAL_REFERENCE"
  | "DIAGNOSTIC_REFERENCE"
  | "OTHER_REFERENCE";

export type WarrantyOrderStatus =
  | "Pending"
  | "Paid"
  | "Shipped"
  | "Refunded"
  | "Completed";

export interface WarrantyOrderLine {
  id?: string | number;
  name: string;
  quantity?: number;
}

export interface WarrantyOrderSnapshot {
  orderId: string;
  paymentMethod: "stellar" | "card";
  status: WarrantyOrderStatus;
  createdAt: string;
  items: WarrantyOrderLine[];
}

export interface WarrantyLineSelection {
  lineIndex: number;
  quantity: number;
}

export interface WarrantyEvidenceReference {
  evidenceId: string;
  revision: number;
  kind: WarrantyEvidenceKind;
  capturedAt: string;
  sourceRef: string;
  sourceSha256: string;
}

export interface WarrantyRequestInput {
  requestedAt: string;
  firstObservedAt: string;
  symptom: WarrantySymptom;
  details?: string;
  selections: WarrantyLineSelection[];
  evidence?: WarrantyEvidenceReference[];
}

export interface WarrantyVerificationInput {
  checkedAt: string;
  verified: boolean;
  onChainStatus?: string;
}

export interface CompileWarrantyReviewInput {
  order: WarrantyOrderSnapshot;
  request: WarrantyRequestInput;
  verification: WarrantyVerificationInput;
  evaluatedAt: string;
}

export interface NormalizedWarrantyLine {
  lineIndex: number;
  id?: string | number;
  name: string;
  quantityPurchased: number;
  quantityClaimed: number;
}

export interface NormalizedWarrantyEvidence {
  evidenceId: string;
  revision: number;
  kind: WarrantyEvidenceKind;
  capturedAt: string;
  sourceRef: string;
  sourceSha256: string;
}

export interface WarrantyReviewReceipt {
  schemaVersion: typeof WARRANTY_REVIEW_SCHEMA;
  claimId: string;
  orderId: string;
  decision: "HOLD" | "READY_FOR_MERCHANT_WARRANTY_REVIEW";
  blockers: string[];
  evaluatedAt: string;
  requestedAt: string;
  firstObservedAt: string;
  verificationCheckedAt: string;
  orderSnapshotDigest: string;
  requestDigest: string;
  evidenceDigest: string;
  verificationDigest: string;
  packetDigest: string;
  warrantyExistsDetermined: false;
  warrantyCoverageDetermined: false;
  productDefectDetermined: false;
  faultOrLiabilityDetermined: false;
  refundAuthorized: false;
  exchangeAuthorized: false;
  repairAuthorized: false;
  replacementAuthorized: false;
  paymentAuthorized: false;
  inventoryMutationAuthorized: false;
  merchantContactAuthorized: false;
}

export interface WarrantyReviewPacket {
  schemaVersion: typeof WARRANTY_REVIEW_SCHEMA;
  order: {
    orderId: string;
    paymentMethod: "stellar" | "card";
    status: WarrantyOrderStatus;
    createdAt: string;
    lines: Array<{
      lineIndex: number;
      id?: string | number;
      name: string;
      quantityPurchased: number;
    }>;
  };
  request: {
    claimId: string;
    requestedAt: string;
    firstObservedAt: string;
    symptom: WarrantySymptom;
    details?: string;
    lines: NormalizedWarrantyLine[];
    evidence: NormalizedWarrantyEvidence[];
    evidenceHistoryDigest: string;
  };
  verification: {
    checkedAt: string;
    verified: boolean;
    onChainStatus?: string;
  };
  receipt: WarrantyReviewReceipt;
}

export class WarrantyReviewValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WarrantyReviewValidationError";
  }
}

const OPAQUE_RE = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const SECRET_RE = /(?:sk_(?:live|test)_[A-Za-z0-9]{8,}|pk_(?:live|test)_[A-Za-z0-9]{8,}|gh[pousr]_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|api[_-]?key|bearer[:._-]?[A-Za-z0-9]{10,})/i;
const PII_RE = /(?:[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\b(?:https?:\/\/|www\.)|\b(?:\+?1[-. ]?)?\(?\d{3}\)?[-. ]\d{3}[-. ]\d{4}\b)/i;

function assertPlainObject(value: unknown, field: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WarrantyReviewValidationError(`${field} must be an object`);
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new WarrantyReviewValidationError(`${field} must be a plain object`);
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
  const keys = Object.keys(value);
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new WarrantyReviewValidationError(`${field} is missing ${key}`);
    }
  }
  for (const key of keys) {
    if (!allowed.has(key)) {
      throw new WarrantyReviewValidationError(`${field} contains unknown key ${key}`);
    }
  }
}

function boundedText(value: unknown, field: string, max: number, required = true): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string") {
    throw new WarrantyReviewValidationError(`${field} must be text`);
  }
  const normalized = value.trim();
  if ((required && normalized.length === 0) || normalized.length > max || /\p{C}/u.test(normalized)) {
    throw new WarrantyReviewValidationError(`${field} is invalid`);
  }
  return normalized || undefined;
}

function opaqueText(value: unknown, field: string): string {
  const normalized = boundedText(value, field, 128)!;
  if (!OPAQUE_RE.test(normalized) || normalized.includes("..") || normalized.includes("/") || normalized.includes("\\")) {
    throw new WarrantyReviewValidationError(`${field} must be an opaque identifier`);
  }
  if (PII_RE.test(normalized) || SECRET_RE.test(normalized)) {
    throw new WarrantyReviewValidationError(`${field} contains disallowed PII or credential material`);
  }
  return normalized;
}

function strictPositiveInt(value: unknown, field: string, max = 999): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > max) {
    throw new WarrantyReviewValidationError(`${field} must be a positive integer <= ${max}`);
  }
  return value;
}

function canonicalUtc(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new WarrantyReviewValidationError(`${field} must be a canonical UTC timestamp`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new WarrantyReviewValidationError(`${field} must be a canonical UTC timestamp`);
  }
  return value;
}

function normalizeOrderId(value: unknown): string {
  const orderId = boundedText(value, "order.orderId", 128)!;
  if (/\p{C}/u.test(orderId)) {
    throw new WarrantyReviewValidationError("order.orderId contains control characters");
  }
  return orderId;
}

function normalizeSymptom(value: unknown): WarrantySymptom {
  const allowed: WarrantySymptom[] = [
    "NOT_WORKING",
    "INTERMITTENT",
    "PHYSICAL_DAMAGE",
    "MISSING_PART",
    "PERFORMANCE_DEGRADATION",
    "OTHER",
  ];
  if (typeof value !== "string" || !allowed.includes(value as WarrantySymptom)) {
    throw new WarrantyReviewValidationError("request.symptom is unsupported");
  }
  return value as WarrantySymptom;
}

function normalizeEvidenceKind(value: unknown): WarrantyEvidenceKind {
  const allowed: WarrantyEvidenceKind[] = [
    "PHOTO_REFERENCE",
    "VIDEO_REFERENCE",
    "SERIAL_REFERENCE",
    "DIAGNOSTIC_REFERENCE",
    "OTHER_REFERENCE",
  ];
  if (typeof value !== "string" || !allowed.includes(value as WarrantyEvidenceKind)) {
    throw new WarrantyReviewValidationError("evidence kind is unsupported");
  }
  return value as WarrantyEvidenceKind;
}

function normalizeStatus(value: unknown): WarrantyOrderStatus {
  const allowed: WarrantyOrderStatus[] = ["Pending", "Paid", "Shipped", "Refunded", "Completed"];
  if (typeof value !== "string" || !allowed.includes(value as WarrantyOrderStatus)) {
    throw new WarrantyReviewValidationError("order.status is unsupported");
  }
  return value as WarrantyOrderStatus;
}

function normalizePaymentMethod(value: unknown): "stellar" | "card" {
  if (value !== "stellar" && value !== "card") {
    throw new WarrantyReviewValidationError("order.paymentMethod is unsupported");
  }
  return value;
}

function stableProjection(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableProjection);
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return Object.fromEntries(entries.map(([key, entry]) => [key, stableProjection(entry)]));
  }
  return value;
}

export function canonicalWarrantyReviewJson(value: unknown): string {
  return JSON.stringify(stableProjection(value));
}

export async function warrantySha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizeOrder(orderInput: WarrantyOrderSnapshot) {
  assertKeys(orderInput, "order", ["orderId", "paymentMethod", "status", "createdAt", "items"]);
  const orderId = normalizeOrderId(orderInput.orderId);
  const paymentMethod = normalizePaymentMethod(orderInput.paymentMethod);
  const status = normalizeStatus(orderInput.status);
  const createdAt = canonicalUtc(orderInput.createdAt, "order.createdAt");

  if (!Array.isArray(orderInput.items) || orderInput.items.length === 0 || orderInput.items.length > 100) {
    throw new WarrantyReviewValidationError("order.items must contain 1-100 lines");
  }

  const items = orderInput.items.map((item, index) => {
    assertKeys(item, `order.items[${index}]`, ["name"], ["id", "quantity"]);
    const name = boundedText(item.name, `order.items[${index}].name`, 512)!;
    const quantity = item.quantity === undefined ? 1 : strictPositiveInt(item.quantity, `order.items[${index}].quantity`);
    let id: string | number | undefined;
    if (item.id !== undefined) {
      if (typeof item.id === "string") {
        id = boundedText(item.id, `order.items[${index}].id`, 256)!;
      } else if (typeof item.id === "number" && Number.isSafeInteger(item.id)) {
        id = item.id;
      } else {
        throw new WarrantyReviewValidationError(`order.items[${index}].id is invalid`);
      }
    }
    return { lineIndex: index, id, name, quantity };
  });

  return { orderId, paymentMethod, status, createdAt, items };
}

function normalizeEvidence(evidenceInput: WarrantyEvidenceReference[] | undefined) {
  if (evidenceInput === undefined) {
    return {
      evidence: [] as NormalizedWarrantyEvidence[],
      history: [] as NormalizedWarrantyEvidence[],
      conflict: false,
    };
  }
  if (!Array.isArray(evidenceInput) || evidenceInput.length > WARRANTY_MAX_EVIDENCE) {
    throw new WarrantyReviewValidationError(`request.evidence must contain at most ${WARRANTY_MAX_EVIDENCE} references`);
  }

  const byIdentity = new Map<string, NormalizedWarrantyEvidence>();
  let conflict = false;
  for (let i = 0; i < evidenceInput.length; i += 1) {
    const entry = evidenceInput[i];
    assertKeys(
      entry,
      `request.evidence[${i}]`,
      ["evidenceId", "revision", "kind", "capturedAt", "sourceRef", "sourceSha256"]
    );
    const normalized: NormalizedWarrantyEvidence = {
      evidenceId: opaqueText(entry.evidenceId, `request.evidence[${i}].evidenceId`),
      revision: strictPositiveInt(entry.revision, `request.evidence[${i}].revision`, Number.MAX_SAFE_INTEGER),
      kind: normalizeEvidenceKind(entry.kind),
      capturedAt: canonicalUtc(entry.capturedAt, `request.evidence[${i}].capturedAt`),
      sourceRef: opaqueText(entry.sourceRef, `request.evidence[${i}].sourceRef`),
      sourceSha256: (() => {
        if (typeof entry.sourceSha256 !== "string" || !SHA256_RE.test(entry.sourceSha256)) {
          throw new WarrantyReviewValidationError(`request.evidence[${i}].sourceSha256 must be lowercase SHA-256`);
        }
        return entry.sourceSha256;
      })(),
    };
    const key = `${normalized.evidenceId}:${normalized.revision}`;
    const prior = byIdentity.get(key);
    if (prior) {
      if (canonicalWarrantyReviewJson(prior) !== canonicalWarrantyReviewJson(normalized)) conflict = true;
      continue;
    }
    byIdentity.set(key, normalized);
  }

  const lineage = new Map<string, NormalizedWarrantyEvidence[]>();
  for (const entry of byIdentity.values()) {
    const rows = lineage.get(entry.evidenceId) ?? [];
    rows.push(entry);
    lineage.set(entry.evidenceId, rows);
  }
  const latest: NormalizedWarrantyEvidence[] = [];
  for (const rows of lineage.values()) {
    rows.sort((a, b) => a.revision - b.revision);
    for (let i = 1; i < rows.length; i += 1) {
      if (new Date(rows[i].capturedAt).getTime() < new Date(rows[i - 1].capturedAt).getTime()) conflict = true;
      if (rows[i].kind !== rows[0].kind) conflict = true;
    }
    latest.push(rows[rows.length - 1]);
  }
  latest.sort((a, b) => a.evidenceId.localeCompare(b.evidenceId));
  const history = Array.from(byIdentity.values()).sort(
    (a, b) => a.evidenceId.localeCompare(b.evidenceId) || a.revision - b.revision
  );
  return { evidence: latest, history, conflict };
}

function normalizeRequest(requestInput: WarrantyRequestInput, order: ReturnType<typeof normalizeOrder>) {
  assertKeys(
    requestInput,
    "request",
    ["requestedAt", "firstObservedAt", "symptom", "selections"],
    ["details", "evidence"]
  );
  const requestedAt = canonicalUtc(requestInput.requestedAt, "request.requestedAt");
  const firstObservedAt = canonicalUtc(requestInput.firstObservedAt, "request.firstObservedAt");
  const symptom = normalizeSymptom(requestInput.symptom);
  const details = boundedText(requestInput.details, "request.details", 500, false);
  if (symptom === "OTHER" && !details) {
    throw new WarrantyReviewValidationError("request.details is required for OTHER");
  }
  if (!Array.isArray(requestInput.selections) || requestInput.selections.length === 0) {
    throw new WarrantyReviewValidationError("request.selections must not be empty");
  }

  const seen = new Set<number>();
  const lines: NormalizedWarrantyLine[] = requestInput.selections.map((selection, selectionIndex) => {
    assertKeys(selection, `request.selections[${selectionIndex}]`, ["lineIndex", "quantity"]);
    const lineIndex = selection.lineIndex;
    if (typeof lineIndex !== "number" || !Number.isSafeInteger(lineIndex) || lineIndex < 0) {
      throw new WarrantyReviewValidationError(`request.selections[${selectionIndex}].lineIndex is invalid`);
    }
    if (seen.has(lineIndex)) {
      throw new WarrantyReviewValidationError(`request.selections contains duplicate lineIndex ${lineIndex}`);
    }
    seen.add(lineIndex);
    const orderedLine = order.items[lineIndex];
    if (!orderedLine) {
      throw new WarrantyReviewValidationError(`request.selections references unknown lineIndex ${lineIndex}`);
    }
    const quantityClaimed = strictPositiveInt(
      selection.quantity,
      `request.selections[${selectionIndex}].quantity`,
      orderedLine.quantity
    );
    return {
      lineIndex,
      ...(orderedLine.id === undefined ? {} : { id: orderedLine.id }),
      name: orderedLine.name,
      quantityPurchased: orderedLine.quantity,
      quantityClaimed,
    };
  });
  lines.sort((a, b) => a.lineIndex - b.lineIndex);
  const { evidence, history: evidenceHistory, conflict: evidenceConflict } = normalizeEvidence(requestInput.evidence);
  return { requestedAt, firstObservedAt, symptom, details, lines, evidence, evidenceHistory, evidenceConflict };
}

function normalizeVerification(verificationInput: WarrantyVerificationInput) {
  assertKeys(verificationInput, "verification", ["checkedAt", "verified"], ["onChainStatus"]);
  const checkedAt = canonicalUtc(verificationInput.checkedAt, "verification.checkedAt");
  if (typeof verificationInput.verified !== "boolean") {
    throw new WarrantyReviewValidationError("verification.verified must be boolean");
  }
  const onChainStatus = boundedText(verificationInput.onChainStatus, "verification.onChainStatus", 64, false);
  return { checkedAt, verified: verificationInput.verified, onChainStatus };
}

export async function compileWarrantyReview(input: CompileWarrantyReviewInput): Promise<WarrantyReviewPacket> {
  assertKeys(input, "input", ["order", "request", "verification", "evaluatedAt"]);
  const evaluatedAt = canonicalUtc(input.evaluatedAt, "evaluatedAt");
  const order = normalizeOrder(input.order);
  const request = normalizeRequest(input.request, order);
  const verification = normalizeVerification(input.verification);

  const evaluatedMs = new Date(evaluatedAt).getTime();
  const requestedMs = new Date(request.requestedAt).getTime();
  const observedMs = new Date(request.firstObservedAt).getTime();
  const checkedMs = new Date(verification.checkedAt).getTime();
  const createdMs = new Date(order.createdAt).getTime();

  if (observedMs < createdMs) throw new WarrantyReviewValidationError("request.firstObservedAt predates the order");
  if (observedMs > requestedMs) throw new WarrantyReviewValidationError("request.firstObservedAt follows request.requestedAt");
  if (requestedMs > evaluatedMs) throw new WarrantyReviewValidationError("request.requestedAt is in the future");
  if (checkedMs > evaluatedMs) throw new WarrantyReviewValidationError("verification.checkedAt is in the future");
  for (const evidence of request.evidence) {
    const capturedMs = new Date(evidence.capturedAt).getTime();
    if (capturedMs > evaluatedMs) throw new WarrantyReviewValidationError("evidence.capturedAt is in the future");
  }

  const normalizedOrder = {
    orderId: order.orderId,
    paymentMethod: order.paymentMethod,
    status: order.status,
    createdAt: order.createdAt,
    lines: order.items.map((line) => ({
      lineIndex: line.lineIndex,
      ...(line.id === undefined ? {} : { id: line.id }),
      name: line.name,
      quantityPurchased: line.quantity,
    })),
  };
  const normalizedEvidence = request.evidence;
  const evidenceHistoryDigest = await warrantySha256Hex(
    canonicalWarrantyReviewJson(request.evidenceHistory)
  );
  const normalizedRequestCore = {
    requestedAt: request.requestedAt,
    firstObservedAt: request.firstObservedAt,
    symptom: request.symptom,
    ...(request.details ? { details: request.details } : {}),
    lines: request.lines,
    evidence: normalizedEvidence,
    evidenceHistoryDigest,
  };
  const normalizedVerification = {
    checkedAt: verification.checkedAt,
    verified: verification.verified,
    ...(verification.onChainStatus ? { onChainStatus: verification.onChainStatus } : {}),
  };

  const [orderSnapshotDigest, requestDigest, verificationDigest] = await Promise.all([
    warrantySha256Hex(canonicalWarrantyReviewJson(normalizedOrder)),
    warrantySha256Hex(canonicalWarrantyReviewJson(normalizedRequestCore)),
    warrantySha256Hex(canonicalWarrantyReviewJson(normalizedVerification)),
  ]);
  const evidenceDigest = evidenceHistoryDigest;
  const claimId = `wc_${requestDigest.slice(0, 24)}`;

  const blockers: string[] = [];
  if (order.status !== "Shipped" && order.status !== "Completed") {
    blockers.push(`ORDER_STATUS_${order.status.toUpperCase()}_NOT_POSTSHIP`);
  }
  if (request.evidenceConflict) blockers.push("EVIDENCE_REVISION_CONFLICT");
  if (order.paymentMethod === "stellar") {
    if (!verification.verified) blockers.push("CURRENT_CHAIN_ORDER_NOT_VERIFIED");
    if (verification.onChainStatus !== "Shipped") blockers.push("CURRENT_CHAIN_STATUS_NOT_SHIPPED");
    if (checkedMs < requestedMs) blockers.push("CHAIN_CHECK_PREDATES_REQUEST");
    if (evaluatedMs - checkedMs > WARRANTY_VERIFICATION_MAX_AGE_MS) blockers.push("CURRENT_CHAIN_CHECK_STALE");
  } else {
    blockers.push("CARD_ORDER_REQUIRES_MERCHANT_SHIPMENT_EVIDENCE");
  }

  const decision: WarrantyReviewReceipt["decision"] = blockers.length === 0
    ? "READY_FOR_MERCHANT_WARRANTY_REVIEW"
    : "HOLD";
  const receiptCore = {
    schemaVersion: WARRANTY_REVIEW_SCHEMA,
    claimId,
    orderId: order.orderId,
    decision,
    blockers,
    evaluatedAt,
    requestedAt: request.requestedAt,
    firstObservedAt: request.firstObservedAt,
    verificationCheckedAt: verification.checkedAt,
    orderSnapshotDigest,
    requestDigest,
    evidenceDigest,
    verificationDigest,
    warrantyExistsDetermined: false as const,
    warrantyCoverageDetermined: false as const,
    productDefectDetermined: false as const,
    faultOrLiabilityDetermined: false as const,
    refundAuthorized: false as const,
    exchangeAuthorized: false as const,
    repairAuthorized: false as const,
    replacementAuthorized: false as const,
    paymentAuthorized: false as const,
    inventoryMutationAuthorized: false as const,
    merchantContactAuthorized: false as const,
  };
  const packetDigest = await warrantySha256Hex(canonicalWarrantyReviewJson(receiptCore));
  const receipt: WarrantyReviewReceipt = { ...receiptCore, packetDigest };

  return {
    schemaVersion: WARRANTY_REVIEW_SCHEMA,
    order: normalizedOrder,
    request: {
      claimId,
      ...normalizedRequestCore,
    },
    verification: normalizedVerification,
    receipt,
  };
}

export async function verifyWarrantyReviewPacket(
  packet: WarrantyReviewPacket,
  source: CompileWarrantyReviewInput
): Promise<boolean> {
  try {
    const rebuilt = await compileWarrantyReview(source);
    return canonicalWarrantyReviewJson(rebuilt) === canonicalWarrantyReviewJson(packet);
  } catch {
    return false;
  }
}
