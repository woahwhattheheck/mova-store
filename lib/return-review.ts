export const RETURN_REVIEW_SCHEMA = "mova.return-review/v1" as const;
export const RETURN_VERIFICATION_MAX_AGE_MS = 5 * 60 * 1000;

export type ReturnReason =
  | "DEFECTIVE"
  | "WRONG_ITEM"
  | "SIZE_FIT"
  | "CHANGED_MIND"
  | "OTHER";

export type ReturnOrderStatus =
  | "Pending"
  | "Paid"
  | "Shipped"
  | "Refunded"
  | "Completed";

export interface ReturnOrderLine {
  id?: string | number;
  name: string;
  price: number;
  quantity?: number;
}

export interface ReturnOrderSnapshot {
  orderId: string;
  paymentMethod: "stellar" | "card";
  status: ReturnOrderStatus;
  createdAt: string;
  items: ReturnOrderLine[];
}

export interface ReturnLineSelection {
  lineIndex: number;
  quantity: number;
}

export interface ReturnRequestInput {
  requestedAt: string;
  reason: ReturnReason;
  details?: string;
  selections: ReturnLineSelection[];
}

export interface ReturnVerificationInput {
  checkedAt: string;
  verified: boolean;
  onChainStatus?: string;
}

export interface CompileReturnReviewInput {
  order: ReturnOrderSnapshot;
  request: ReturnRequestInput;
  verification: ReturnVerificationInput;
  evaluatedAt: string;
}

export interface NormalizedReturnLine {
  lineIndex: number;
  id?: string | number;
  name: string;
  quantityPurchased: number;
  quantityRequested: number;
}

export interface ReturnReviewReceipt {
  schemaVersion: typeof RETURN_REVIEW_SCHEMA;
  requestId: string;
  orderId: string;
  decision: "HOLD" | "READY_FOR_MERCHANT_RETURN_REVIEW";
  blockers: string[];
  evaluatedAt: string;
  requestedAt: string;
  verificationCheckedAt: string;
  orderSnapshotDigest: string;
  requestDigest: string;
  verificationDigest: string;
  packetDigest: string;
  refundAuthorized: false;
  exchangeAuthorized: false;
  dispatchAuthorized: false;
  replacementAuthorized: false;
  paymentAuthorized: false;
  inventoryMutationAuthorized: false;
}

export interface ReturnReviewPacket {
  schemaVersion: typeof RETURN_REVIEW_SCHEMA;
  order: {
    orderId: string;
    paymentMethod: "stellar" | "card";
    status: ReturnOrderStatus;
    createdAt: string;
  };
  request: {
    requestId: string;
    requestedAt: string;
    reason: ReturnReason;
    details?: string;
    lines: NormalizedReturnLine[];
  };
  verification: {
    checkedAt: string;
    verified: boolean;
    onChainStatus?: string;
  };
  receipt: ReturnReviewReceipt;
}

export class ReturnReviewValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReturnReviewValidationError";
  }
}

function assertPlainObject(value: unknown, field: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ReturnReviewValidationError(`${field} must be an object`);
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new ReturnReviewValidationError(`${field} must be a plain object`);
  }
}

function boundedText(value: unknown, field: string, max: number, required = true): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string") {
    throw new ReturnReviewValidationError(`${field} must be text`);
  }
  const normalized = value.trim();
  if ((required && normalized.length === 0) || normalized.length > max) {
    throw new ReturnReviewValidationError(`${field} is invalid`);
  }
  return normalized || undefined;
}

function strictPositiveInt(value: unknown, field: string, max = 999): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > max) {
    throw new ReturnReviewValidationError(`${field} must be a positive integer <= ${max}`);
  }
  return value;
}

function strictNonNegativeMoney(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new ReturnReviewValidationError(`${field} must be a finite non-negative number`);
  }
  return value;
}

function canonicalUtc(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new ReturnReviewValidationError(`${field} must be a canonical UTC timestamp`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new ReturnReviewValidationError(`${field} must be a canonical UTC timestamp`);
  }
  return value;
}

function normalizeOrderId(value: unknown): string {
  const orderId = boundedText(value, "order.orderId", 128)!;
  if (/\p{C}/u.test(orderId)) {
    throw new ReturnReviewValidationError("order.orderId contains control characters");
  }
  return orderId;
}

function normalizeReason(value: unknown): ReturnReason {
  const reasons: ReturnReason[] = ["DEFECTIVE", "WRONG_ITEM", "SIZE_FIT", "CHANGED_MIND", "OTHER"];
  if (typeof value !== "string" || !reasons.includes(value as ReturnReason)) {
    throw new ReturnReviewValidationError("request.reason is unsupported");
  }
  return value as ReturnReason;
}

function normalizeStatus(value: unknown): ReturnOrderStatus {
  const statuses: ReturnOrderStatus[] = ["Pending", "Paid", "Shipped", "Refunded", "Completed"];
  if (typeof value !== "string" || !statuses.includes(value as ReturnOrderStatus)) {
    throw new ReturnReviewValidationError("order.status is unsupported");
  }
  return value as ReturnOrderStatus;
}

function normalizePaymentMethod(value: unknown): "stellar" | "card" {
  if (value !== "stellar" && value !== "card") {
    throw new ReturnReviewValidationError("order.paymentMethod is unsupported");
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

export function canonicalReturnReviewJson(value: unknown): string {
  return JSON.stringify(stableProjection(value));
}

export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizeOrder(orderInput: ReturnOrderSnapshot) {
  assertPlainObject(orderInput, "order");
  const orderId = normalizeOrderId(orderInput.orderId);
  const paymentMethod = normalizePaymentMethod(orderInput.paymentMethod);
  const status = normalizeStatus(orderInput.status);
  const createdAt = canonicalUtc(orderInput.createdAt, "order.createdAt");

  if (!Array.isArray(orderInput.items) || orderInput.items.length === 0 || orderInput.items.length > 100) {
    throw new ReturnReviewValidationError("order.items must contain 1-100 lines");
  }

  const items = orderInput.items.map((item, index) => {
    assertPlainObject(item, `order.items[${index}]`);
    const name = boundedText(item.name, `order.items[${index}].name`, 512)!;
    const price = strictNonNegativeMoney(item.price, `order.items[${index}].price`);
    const quantity = item.quantity === undefined ? 1 : strictPositiveInt(item.quantity, `order.items[${index}].quantity`);

    let id: string | number | undefined;
    if (item.id !== undefined) {
      if (typeof item.id === "string") {
        id = boundedText(item.id, `order.items[${index}].id`, 256)!;
      } else if (typeof item.id === "number" && Number.isSafeInteger(item.id)) {
        id = item.id;
      } else {
        throw new ReturnReviewValidationError(`order.items[${index}].id is invalid`);
      }
    }

    return { lineIndex: index, id, name, price, quantity };
  });

  return { orderId, paymentMethod, status, createdAt, items };
}

function normalizeRequest(requestInput: ReturnRequestInput, order: ReturnType<typeof normalizeOrder>) {
  assertPlainObject(requestInput, "request");
  const requestedAt = canonicalUtc(requestInput.requestedAt, "request.requestedAt");
  const reason = normalizeReason(requestInput.reason);
  const details = boundedText(requestInput.details, "request.details", 500, false);

  if (reason === "OTHER" && !details) {
    throw new ReturnReviewValidationError("request.details is required for OTHER");
  }
  if (!Array.isArray(requestInput.selections) || requestInput.selections.length === 0) {
    throw new ReturnReviewValidationError("request.selections must not be empty");
  }

  const seen = new Set<number>();
  const lines: NormalizedReturnLine[] = requestInput.selections.map((selection, selectionIndex) => {
    assertPlainObject(selection, `request.selections[${selectionIndex}]`);
    const lineIndex = selection.lineIndex;
    if (typeof lineIndex !== "number" || !Number.isSafeInteger(lineIndex) || lineIndex < 0) {
      throw new ReturnReviewValidationError(`request.selections[${selectionIndex}].lineIndex is invalid`);
    }
    if (seen.has(lineIndex)) {
      throw new ReturnReviewValidationError(`request.selections contains duplicate lineIndex ${lineIndex}`);
    }
    seen.add(lineIndex);

    const orderedLine = order.items[lineIndex];
    if (!orderedLine) {
      throw new ReturnReviewValidationError(`request.selections references unknown lineIndex ${lineIndex}`);
    }
    const quantityRequested = strictPositiveInt(
      selection.quantity,
      `request.selections[${selectionIndex}].quantity`,
      orderedLine.quantity
    );

    return {
      lineIndex,
      ...(orderedLine.id === undefined ? {} : { id: orderedLine.id }),
      name: orderedLine.name,
      quantityPurchased: orderedLine.quantity,
      quantityRequested,
    };
  });

  lines.sort((a, b) => a.lineIndex - b.lineIndex);
  const requestId = `${order.orderId}:${requestedAt}`;
  return { requestId, requestedAt, reason, details, lines };
}

function normalizeVerification(verificationInput: ReturnVerificationInput) {
  assertPlainObject(verificationInput, "verification");
  const checkedAt = canonicalUtc(verificationInput.checkedAt, "verification.checkedAt");
  if (typeof verificationInput.verified !== "boolean") {
    throw new ReturnReviewValidationError("verification.verified must be boolean");
  }
  const onChainStatus = boundedText(
    verificationInput.onChainStatus,
    "verification.onChainStatus",
    64,
    false
  );
  return { checkedAt, verified: verificationInput.verified, onChainStatus };
}

export async function compileReturnReview(input: CompileReturnReviewInput): Promise<ReturnReviewPacket> {
  assertPlainObject(input, "input");
  const evaluatedAt = canonicalUtc(input.evaluatedAt, "evaluatedAt");
  const order = normalizeOrder(input.order);
  const request = normalizeRequest(input.request, order);
  const verification = normalizeVerification(input.verification);

  const evaluatedMs = new Date(evaluatedAt).getTime();
  const requestedMs = new Date(request.requestedAt).getTime();
  const checkedMs = new Date(verification.checkedAt).getTime();
  const createdMs = new Date(order.createdAt).getTime();

  if (createdMs > requestedMs) {
    throw new ReturnReviewValidationError("request.requestedAt predates the order");
  }
  if (requestedMs > evaluatedMs) {
    throw new ReturnReviewValidationError("request.requestedAt is in the future");
  }
  if (checkedMs > evaluatedMs) {
    throw new ReturnReviewValidationError("verification.checkedAt is in the future");
  }

  const blockers: string[] = [];
  if (order.status !== "Shipped" && order.status !== "Completed") {
    blockers.push(`ORDER_STATUS_${order.status.toUpperCase()}_NOT_POSTSHIP`);
  }

  if (order.paymentMethod === "stellar") {
    if (!verification.verified) blockers.push("CURRENT_CHAIN_ORDER_NOT_VERIFIED");
    if (verification.onChainStatus !== "Shipped") {
      blockers.push("CURRENT_CHAIN_STATUS_NOT_SHIPPED");
    }
    if (checkedMs < requestedMs) blockers.push("CHAIN_CHECK_PREDATES_REQUEST");
    if (evaluatedMs - checkedMs > RETURN_VERIFICATION_MAX_AGE_MS) {
      blockers.push("CURRENT_CHAIN_CHECK_STALE");
    }
  } else {
    blockers.push("CARD_ORDER_REQUIRES_MERCHANT_PAYMENT_AND_SHIPMENT_EVIDENCE");
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
  const normalizedRequest = {
    requestId: request.requestId,
    requestedAt: request.requestedAt,
    reason: request.reason,
    ...(request.details ? { details: request.details } : {}),
    lines: request.lines,
  };
  const normalizedVerification = {
    checkedAt: verification.checkedAt,
    verified: verification.verified,
    ...(verification.onChainStatus ? { onChainStatus: verification.onChainStatus } : {}),
  };

  const [orderSnapshotDigest, requestDigest, verificationDigest] = await Promise.all([
    sha256Hex(canonicalReturnReviewJson(normalizedOrder)),
    sha256Hex(canonicalReturnReviewJson(normalizedRequest)),
    sha256Hex(canonicalReturnReviewJson(normalizedVerification)),
  ]);

  const decision: ReturnReviewReceipt["decision"] =
    blockers.length === 0 ? "READY_FOR_MERCHANT_RETURN_REVIEW" : "HOLD";
  const receiptCore = {
    schemaVersion: RETURN_REVIEW_SCHEMA,
    requestId: request.requestId,
    orderId: order.orderId,
    decision,
    blockers,
    evaluatedAt,
    requestedAt: request.requestedAt,
    verificationCheckedAt: verification.checkedAt,
    orderSnapshotDigest,
    requestDigest,
    verificationDigest,
    refundAuthorized: false as const,
    exchangeAuthorized: false as const,
    dispatchAuthorized: false as const,
    replacementAuthorized: false as const,
    paymentAuthorized: false as const,
    inventoryMutationAuthorized: false as const,
  };
  const packetDigest = await sha256Hex(canonicalReturnReviewJson(receiptCore));
  const receipt: ReturnReviewReceipt = { ...receiptCore, packetDigest };

  return {
    schemaVersion: RETURN_REVIEW_SCHEMA,
    order: {
      orderId: order.orderId,
      paymentMethod: order.paymentMethod,
      status: order.status,
      createdAt: order.createdAt,
    },
    request: normalizedRequest,
    verification: normalizedVerification,
    receipt,
  };
}

export async function verifyReturnReviewPacket(
  packet: ReturnReviewPacket,
  source: CompileReturnReviewInput
): Promise<boolean> {
  try {
    const rebuilt = await compileReturnReview(source);
    return canonicalReturnReviewJson(rebuilt) === canonicalReturnReviewJson(packet);
  } catch {
    return false;
  }
}
