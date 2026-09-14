export const MERCHANT_ORDER_INDEX_SCHEMA = "merchant-order-index/v1";
export const MAX_MERCHANT_ORDER_ID_LENGTH = 128;
export const MAX_MERCHANT_INDEX_PAGE = 250;

export type MerchantIndexedStatus =
  | "Quoted"
  | "Pending"
  | "Paid"
  | "Shipped"
  | "Refunded"
  | "Unknown"
  | "Conflict";

export interface MerchantOrderSeed {
  schemaVersion: typeof MERCHANT_ORDER_INDEX_SCHEMA;
  orderId: string;
  cartDigestSha256: string;
  buyer: string;
  tokenContractId: string;
  tokenSymbol: string;
  amountRaw: string;
  authValidUntilLedger: number;
}

export interface MerchantOrderRow extends MerchantOrderSeed {
  quoteCreatedAt: string;
  chainStatus: MerchantIndexedStatus;
  chainBuyer?: string;
  chainTokenContractId?: string;
  chainAmountRaw?: string;
  chainTimestamp?: number;
  identityConflict: boolean;
  conflictReasons: string[];
  lastReconciledAt?: string;
  lastReconcileError?: string;
}

export interface ChainOrderObservation {
  buyer: string;
  tokenContractId: string;
  amountRaw: string;
  status: "Pending" | "Paid" | "Shipped" | "Refunded" | "Unknown";
  timestamp: number;
}

export interface ReconcileDecision {
  chainStatus: MerchantIndexedStatus;
  chainBuyer?: string;
  chainTokenContractId?: string;
  chainAmountRaw?: string;
  chainTimestamp?: number;
  identityConflict: boolean;
  conflictReasons: string[];
}

const HEX_64 = /^[0-9a-f]{64}$/;
const STELLAR_ADDRESS = /^[A-Z2-7]{56}$/;
const TOKEN_SYMBOL = /^[A-Z0-9][A-Z0-9._-]{0,15}$/;
const UNSIGNED_INTEGER = /^(?:0|[1-9][0-9]*)$/;
const ORDER_ID_RE = /^MQ1:([0-9a-f]{64}):([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

function boundedString(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > max) {
    throw new Error(`${field} must contain 1-${max} characters`);
  }
  return normalized;
}

export function normalizeMerchantOrderId(value: unknown): string {
  const orderId = boundedString(value, "orderId", MAX_MERCHANT_ORDER_ID_LENGTH);
  if (!ORDER_ID_RE.test(orderId)) throw new Error("orderId must use the canonical merchant quote identity format");
  return orderId;
}

export function normalizeMerchantOrderSeed(input: MerchantOrderSeed): MerchantOrderSeed {
  if (!input || typeof input !== "object") throw new Error("Merchant order seed is required");
  if (input.schemaVersion !== MERCHANT_ORDER_INDEX_SCHEMA) {
    throw new Error("Unsupported merchant order index schema");
  }
  const orderId = normalizeMerchantOrderId(input.orderId);
  const cartDigestSha256 = boundedString(input.cartDigestSha256, "cartDigestSha256", 64).toLowerCase();
  if (!HEX_64.test(cartDigestSha256)) throw new Error("cartDigestSha256 must be lowercase SHA-256 hex");
  const embeddedDigest = ORDER_ID_RE.exec(orderId)?.[1]?.toLowerCase();
  if (embeddedDigest !== cartDigestSha256) throw new Error("orderId cart digest does not match cartDigestSha256");
  const buyer = boundedString(input.buyer, "buyer", 56).toUpperCase();
  const tokenContractId = boundedString(input.tokenContractId, "tokenContractId", 56).toUpperCase();
  if (!STELLAR_ADDRESS.test(buyer)) throw new Error("buyer must be a canonical Stellar address");
  if (!STELLAR_ADDRESS.test(tokenContractId)) throw new Error("tokenContractId must be a canonical Stellar contract address");
  const tokenSymbol = boundedString(input.tokenSymbol, "tokenSymbol", 16).toUpperCase();
  if (!TOKEN_SYMBOL.test(tokenSymbol)) throw new Error("tokenSymbol is invalid");
  const amountRaw = boundedString(input.amountRaw, "amountRaw", 40);
  if (!UNSIGNED_INTEGER.test(amountRaw) || BigInt(amountRaw) <= 0n) {
    throw new Error("amountRaw must be a positive unsigned integer string");
  }
  if (!Number.isSafeInteger(input.authValidUntilLedger) || input.authValidUntilLedger < 0) {
    throw new Error("authValidUntilLedger must be a non-negative safe integer");
  }
  return {
    schemaVersion: MERCHANT_ORDER_INDEX_SCHEMA,
    orderId,
    cartDigestSha256,
    buyer,
    tokenContractId,
    tokenSymbol,
    amountRaw,
    authValidUntilLedger: input.authValidUntilLedger,
  };
}

export function merchantSeedEquals(a: MerchantOrderSeed, b: MerchantOrderSeed): boolean {
  const left = normalizeMerchantOrderSeed(a);
  const right = normalizeMerchantOrderSeed(b);
  return (
    left.schemaVersion === right.schemaVersion &&
    left.orderId === right.orderId &&
    left.cartDigestSha256 === right.cartDigestSha256 &&
    left.buyer === right.buyer &&
    left.tokenContractId === right.tokenContractId &&
    left.tokenSymbol === right.tokenSymbol &&
    left.amountRaw === right.amountRaw &&
    left.authValidUntilLedger === right.authValidUntilLedger
  );
}

export function reconcileMerchantOrder(
  seedInput: MerchantOrderSeed,
  chain: ChainOrderObservation | null,
  priorStatus: MerchantIndexedStatus = "Quoted"
): ReconcileDecision {
  const seed = normalizeMerchantOrderSeed(seedInput);
  if (!chain) {
    return {
      chainStatus: priorStatus,
      identityConflict: priorStatus === "Conflict",
      conflictReasons: [],
    };
  }

  const chainBuyer = boundedString(chain.buyer, "chain.buyer", 56).toUpperCase();
  const chainTokenContractId = boundedString(chain.tokenContractId, "chain.tokenContractId", 56).toUpperCase();
  const chainAmountRaw = boundedString(chain.amountRaw, "chain.amountRaw", 40);
  if (!STELLAR_ADDRESS.test(chainBuyer)) throw new Error("chain.buyer is invalid");
  if (!STELLAR_ADDRESS.test(chainTokenContractId)) throw new Error("chain.tokenContractId is invalid");
  if (!UNSIGNED_INTEGER.test(chainAmountRaw)) throw new Error("chain.amountRaw is invalid");
  if (!Number.isSafeInteger(chain.timestamp) || chain.timestamp < 0) {
    throw new Error("chain.timestamp is invalid");
  }
  if (!["Pending", "Paid", "Shipped", "Refunded", "Unknown"].includes(chain.status)) {
    throw new Error("chain.status is invalid");
  }

  const conflictReasons: string[] = [];
  if (seed.buyer !== chainBuyer) conflictReasons.push("BUYER_MISMATCH");
  if (seed.tokenContractId !== chainTokenContractId) conflictReasons.push("TOKEN_MISMATCH");
  if (seed.amountRaw !== chainAmountRaw) conflictReasons.push("AMOUNT_MISMATCH");

  return {
    chainStatus: conflictReasons.length ? "Conflict" : chain.status,
    chainBuyer,
    chainTokenContractId,
    chainAmountRaw,
    chainTimestamp: chain.timestamp,
    identityConflict: conflictReasons.length > 0,
    conflictReasons,
  };
}

export function merchantRowToDisplayAmount(row: Pick<MerchantOrderRow, "amountRaw">, decimals = 7): string {
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new Error("decimals must be an integer between 0 and 18");
  }
  const raw = BigInt(row.amountRaw);
  const scale = 10n ** BigInt(decimals);
  const whole = raw / scale;
  const fraction = (raw % scale).toString().padStart(decimals, "0").slice(0, 2).padEnd(2, "0");
  return `${whole.toString()}.${fraction}`;
}
