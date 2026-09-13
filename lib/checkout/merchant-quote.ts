export const QUOTE_TOKEN_DECIMALS = 7;
export const DEFAULT_QUOTE_TTL_SECONDS = 10 * 60;
export const MAX_QUOTE_TTL_SECONDS = 30 * 60;
export const MAX_CART_LINES = 50;
export const MAX_LINE_QUANTITY = 100;
export const QUOTE_COMMITMENT_VERSION = 1;

export type ProductId = string | number;

export interface QuoteCartLine {
  productId: ProductId;
  quantity: number;
}

export interface CanonicalProduct {
  id: ProductId;
  price: string | number;
  name?: string | null;
}

export interface QuotedLine {
  productId: ProductId;
  quantity: number;
  unitAmountRaw: string;
  lineAmountRaw: string;
}

export interface MerchantQuote {
  orderId: string;
  quoteNonce: string;
  buyer: string;
  tokenContractId: string;
  amountRaw: string;
  amountUsd: string;
  issuedAt: number;
  expiresAt: number;
  lines: QuotedLine[];
}

function productKey(id: ProductId): string {
  if (typeof id === "number") {
    if (!Number.isSafeInteger(id) || id < 0) {
      throw new Error("productId must be a non-negative safe integer or non-empty string");
    }
    return String(id);
  }

  const normalized = id.trim();
  if (!normalized) throw new Error("productId must not be empty");
  return normalized;
}

export function normalizeCartLines(input: unknown): QuoteCartLine[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error("cart must contain at least one line");
  }
  if (input.length > MAX_CART_LINES) {
    throw new Error(`cart exceeds ${MAX_CART_LINES} distinct lines`);
  }

  const seen = new Set<string>();
  return input.map((raw, index) => {
    if (!raw || typeof raw !== "object") {
      throw new Error(`cart line ${index + 1} must be an object`);
    }

    const candidate = raw as { productId?: unknown; id?: unknown; quantity?: unknown };
    const productId = (candidate.productId ?? candidate.id) as ProductId;
    if (typeof productId !== "string" && typeof productId !== "number") {
      throw new Error(`cart line ${index + 1} has an invalid productId`);
    }

    const key = productKey(productId);
    if (seen.has(key)) {
      throw new Error(`duplicate productId is not allowed: ${key}`);
    }
    seen.add(key);

    const quantity = candidate.quantity;
    if (
      typeof quantity !== "number" ||
      !Number.isSafeInteger(quantity) ||
      quantity < 1 ||
      quantity > MAX_LINE_QUANTITY
    ) {
      throw new Error(
        `quantity for product ${key} must be an integer from 1 to ${MAX_LINE_QUANTITY}`
      );
    }

    return { productId, quantity };
  });
}

/**
 * Convert an exact decimal catalog price into raw 7-decimal token units.
 * No floating-point multiplication or rounding is used. Catalog prices with
 * more precision than the payment token supports fail closed.
 */
export function decimalToRawUnits(
  value: string | number,
  decimals = QUOTE_TOKEN_DECIMALS
): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new Error("invalid token decimal precision");
  }

  const text = typeof value === "number" ? String(value) : value.trim();
  if (!/^\d+(?:\.\d+)?$/.test(text)) {
    throw new Error(`invalid canonical price: ${text || "<empty>"}`);
  }

  const [whole, fraction = ""] = text.split(".");
  if (fraction.length > decimals) {
    throw new Error(`canonical price exceeds ${decimals} decimal places`);
  }

  const scale = BigInt(10) ** BigInt(decimals);
  const fractionRaw = BigInt((fraction + "0".repeat(decimals)).slice(0, decimals) || "0");
  const raw = BigInt(whole) * scale + fractionRaw;
  if (raw <= BigInt(0)) throw new Error("canonical product price must be positive");
  return raw;
}

export function formatRawUnits(raw: bigint, decimals = QUOTE_TOKEN_DECIMALS): string {
  if (raw < BigInt(0)) throw new Error("amount must not be negative");
  const scale = BigInt(10) ** BigInt(decimals);
  const whole = raw / scale;
  const fraction = (raw % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function deriveMerchantQuote(input: {
  lines: QuoteCartLine[];
  products: CanonicalProduct[];
  buyer: string;
  tokenContractId: string;
  orderId: string;
  quoteNonce: string;
  nowSeconds: number;
  ttlSeconds?: number;
  decimals?: number;
}): MerchantQuote {
  const decimals = input.decimals ?? QUOTE_TOKEN_DECIMALS;
  const ttlSeconds = input.ttlSeconds ?? DEFAULT_QUOTE_TTL_SECONDS;

  if (!input.buyer.trim()) throw new Error("buyer is required");
  if (!input.tokenContractId.trim()) throw new Error("tokenContractId is required");
  if (!input.orderId.trim()) throw new Error("orderId is required");
  if (!input.quoteNonce.trim()) throw new Error("quoteNonce is required");
  if (!Number.isSafeInteger(input.nowSeconds) || input.nowSeconds < 0) {
    throw new Error("nowSeconds must be a non-negative integer");
  }
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > MAX_QUOTE_TTL_SECONDS) {
    throw new Error(`quote TTL must be between 60 and ${MAX_QUOTE_TTL_SECONDS} seconds`);
  }

  const lines = normalizeCartLines(input.lines);
  const catalog = new Map<string, CanonicalProduct>();
  for (const product of input.products) {
    const key = productKey(product.id);
    if (catalog.has(key)) throw new Error(`canonical catalog contains duplicate productId: ${key}`);
    catalog.set(key, product);
  }

  let amountRaw = BigInt(0);
  const quotedLines: QuotedLine[] = lines.map((line) => {
    const key = productKey(line.productId);
    const product = catalog.get(key);
    if (!product) throw new Error(`unknown productId: ${key}`);

    const unitAmountRaw = decimalToRawUnits(product.price, decimals);
    const lineAmountRaw = unitAmountRaw * BigInt(line.quantity);
    amountRaw += lineAmountRaw;

    return {
      productId: product.id,
      quantity: line.quantity,
      unitAmountRaw: unitAmountRaw.toString(),
      lineAmountRaw: lineAmountRaw.toString(),
    };
  });

  // The quote identity commits a canonical order-independent line set.
  quotedLines.sort((a, b) => productKey(a.productId).localeCompare(productKey(b.productId)));

  if (amountRaw <= BigInt(0)) throw new Error("quote amount must be positive");

  return {
    orderId: input.orderId,
    quoteNonce: input.quoteNonce,
    buyer: input.buyer,
    tokenContractId: input.tokenContractId,
    amountRaw: amountRaw.toString(),
    amountUsd: formatRawUnits(amountRaw, decimals),
    issuedAt: input.nowSeconds,
    expiresAt: input.nowSeconds + ttlSeconds,
    lines: quotedLines,
  };
}

/**
 * Canonical preimage for the quote/order commitment. The server hashes this
 * exact string with SHA-256 and uses `MQ-<hex>` as the human order id; that
 * order id is then hashed again into the contract BytesN<32> key. Because the
 * merchant authorizes that on-chain key, the paid order also commits to the
 * canonical line identities and quantities without storing a new large struct
 * in Soroban persistent storage.
 */
export function quoteCommitmentPayload(
  quote: Omit<MerchantQuote, "orderId">
): string {
  return JSON.stringify({
    version: QUOTE_COMMITMENT_VERSION,
    quoteNonce: quote.quoteNonce,
    buyer: quote.buyer,
    tokenContractId: quote.tokenContractId,
    amountRaw: quote.amountRaw,
    issuedAt: quote.issuedAt,
    expiresAt: quote.expiresAt,
    lines: [...quote.lines]
      .sort((a, b) => productKey(a.productId).localeCompare(productKey(b.productId)))
      .map((line) => ({
        productId: productKey(line.productId),
        quantity: line.quantity,
        unitAmountRaw: line.unitAmountRaw,
        lineAmountRaw: line.lineAmountRaw,
      })),
  });
}

export function assertFreshQuote(quote: MerchantQuote, nowSeconds: number): void {
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0) {
    throw new Error("nowSeconds must be a non-negative integer");
  }
  if (nowSeconds >= quote.expiresAt) throw new Error("merchant quote has expired");
}
