export const FULFILLMENT_RECEIPT_SCHEMA = "mova.fulfillment-tracking/v1" as const;
export const FULFILLMENT_FUTURE_TOLERANCE_MS = 10 * 60 * 1000;

export interface FulfillmentTrackingInput {
  orderId: string;
  carrierCode: string;
  carrierName: string;
  trackingNumber: string;
  shippedAt: string;
  expectedDeliveryAt?: string;
  trackingUrl?: string;
}

export interface FulfillmentTrackingRecord {
  schemaVersion: typeof FULFILLMENT_RECEIPT_SCHEMA;
  orderId: string;
  carrierCode: string;
  carrierName: string;
  trackingNumber: string;
  shippedAt: string;
  expectedDeliveryAt?: string;
  trackingUrl?: string;
}

export interface FulfillmentTrackingReceipt {
  schemaVersion: typeof FULFILLMENT_RECEIPT_SCHEMA;
  orderId: string;
  recordDigest: string;
  preparedAt: string;
  merchantAttestationOnly: true;
  carrierDeliveryVerified: false;
  dispatchAuthorized: false;
  refundAuthorized: false;
  paymentAuthorized: false;
  inventoryMutationAuthorized: false;
}

export interface FulfillmentTrackingPacket {
  record: FulfillmentTrackingRecord;
  receipt: FulfillmentTrackingReceipt;
}

export class FulfillmentTrackingValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FulfillmentTrackingValidationError";
  }
}

function assertPlainObject(value: unknown, field: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new FulfillmentTrackingValidationError(`${field} must be an object`);
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new FulfillmentTrackingValidationError(`${field} must be a plain object`);
  }
}

function boundedText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") {
    throw new FulfillmentTrackingValidationError(`${field} must be text`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > max || /\p{C}/u.test(normalized)) {
    throw new FulfillmentTrackingValidationError(`${field} is invalid`);
  }
  return normalized;
}

function canonicalUtc(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new FulfillmentTrackingValidationError(`${field} must be a canonical UTC timestamp`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new FulfillmentTrackingValidationError(`${field} must be a canonical UTC timestamp`);
  }
  return value;
}

function optionalCanonicalUtc(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return canonicalUtc(value, field);
}

function normalizeCarrierCode(value: unknown): string {
  const code = boundedText(value, "carrierCode", 24).toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._-]{0,23}$/.test(code)) {
    throw new FulfillmentTrackingValidationError("carrierCode has unsupported characters");
  }
  return code;
}

function normalizeTrackingNumber(value: unknown): string {
  const trackingNumber = boundedText(value, "trackingNumber", 96);
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._/-]{0,95}$/.test(trackingNumber)) {
    throw new FulfillmentTrackingValidationError("trackingNumber has unsupported characters");
  }
  return trackingNumber;
}

function normalizeTrackingUrl(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const text = boundedText(value, "trackingUrl", 2048);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new FulfillmentTrackingValidationError("trackingUrl must be a valid HTTPS URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new FulfillmentTrackingValidationError(
      "trackingUrl must use HTTPS without credentials or a fragment"
    );
  }
  return url.toString();
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

export function canonicalFulfillmentJson(value: unknown): string {
  return JSON.stringify(stableProjection(value));
}

export async function fulfillmentSha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function compileFulfillmentTracking(
  input: FulfillmentTrackingInput,
  preparedAt: string
): Promise<FulfillmentTrackingPacket> {
  assertPlainObject(input, "input");
  const canonicalPreparedAt = canonicalUtc(preparedAt, "preparedAt");
  const orderId = boundedText(input.orderId, "orderId", 128);
  const carrierCode = normalizeCarrierCode(input.carrierCode);
  const carrierName = boundedText(input.carrierName, "carrierName", 96);
  const trackingNumber = normalizeTrackingNumber(input.trackingNumber);
  const shippedAt = canonicalUtc(input.shippedAt, "shippedAt");
  const expectedDeliveryAt = optionalCanonicalUtc(input.expectedDeliveryAt, "expectedDeliveryAt");
  const trackingUrl = normalizeTrackingUrl(input.trackingUrl);

  const preparedMs = new Date(canonicalPreparedAt).getTime();
  const shippedMs = new Date(shippedAt).getTime();
  if (shippedMs > preparedMs + FULFILLMENT_FUTURE_TOLERANCE_MS) {
    throw new FulfillmentTrackingValidationError("shippedAt is implausibly far in the future");
  }
  if (expectedDeliveryAt && new Date(expectedDeliveryAt).getTime() < shippedMs) {
    throw new FulfillmentTrackingValidationError("expectedDeliveryAt predates shippedAt");
  }

  const record: FulfillmentTrackingRecord = {
    schemaVersion: FULFILLMENT_RECEIPT_SCHEMA,
    orderId,
    carrierCode,
    carrierName,
    trackingNumber,
    shippedAt,
    ...(expectedDeliveryAt ? { expectedDeliveryAt } : {}),
    ...(trackingUrl ? { trackingUrl } : {}),
  };

  const recordDigest = await fulfillmentSha256Hex(canonicalFulfillmentJson(record));
  const receipt: FulfillmentTrackingReceipt = {
    schemaVersion: FULFILLMENT_RECEIPT_SCHEMA,
    orderId,
    recordDigest,
    preparedAt: canonicalPreparedAt,
    merchantAttestationOnly: true,
    carrierDeliveryVerified: false,
    dispatchAuthorized: false,
    refundAuthorized: false,
    paymentAuthorized: false,
    inventoryMutationAuthorized: false,
  };

  return { record, receipt };
}

export async function verifyFulfillmentTrackingPacket(
  packet: FulfillmentTrackingPacket
): Promise<boolean> {
  try {
    assertPlainObject(packet, "packet");
    assertPlainObject(packet.record, "packet.record");
    assertPlainObject(packet.receipt, "packet.receipt");
    if (packet.record.schemaVersion !== FULFILLMENT_RECEIPT_SCHEMA) return false;
    if (packet.receipt.schemaVersion !== FULFILLMENT_RECEIPT_SCHEMA) return false;
    if (packet.record.orderId !== packet.receipt.orderId) return false;
    if (
      packet.receipt.merchantAttestationOnly !== true ||
      packet.receipt.carrierDeliveryVerified !== false ||
      packet.receipt.dispatchAuthorized !== false ||
      packet.receipt.refundAuthorized !== false ||
      packet.receipt.paymentAuthorized !== false ||
      packet.receipt.inventoryMutationAuthorized !== false
    ) {
      return false;
    }

    const rebuilt = await compileFulfillmentTracking(
      {
        orderId: packet.record.orderId,
        carrierCode: packet.record.carrierCode,
        carrierName: packet.record.carrierName,
        trackingNumber: packet.record.trackingNumber,
        shippedAt: packet.record.shippedAt,
        expectedDeliveryAt: packet.record.expectedDeliveryAt,
        trackingUrl: packet.record.trackingUrl,
      },
      packet.receipt.preparedAt
    );
    return canonicalFulfillmentJson(rebuilt) === canonicalFulfillmentJson(packet);
  } catch {
    return false;
  }
}
