export const MAX_QUOTE_LINES = 64;
export const MAX_QUANTITY_PER_LINE = 1_000_000;

export type QuoteValidationCode =
  | "EMPTY_QUOTE"
  | "TOO_MANY_ITEMS"
  | "INVALID_PRODUCT_ID"
  | "INVALID_QUANTITY"
  | "DUPLICATE_PRODUCT"
  | "PRODUCT_NOT_FOUND"
  | "INVALID_CATALOG_PRICE"
  | "AMOUNT_OVERFLOW";

export class QuoteValidationError extends Error {
  constructor(
    public readonly code: QuoteValidationCode,
    message: string
  ) {
    super(message);
    this.name = "QuoteValidationError";
  }
}

export interface QuoteRequestItem {
  productId: string;
  quantity: number;
}

export interface CanonicalCatalogRow {
  id: string;
  price: string | number;
}

export interface CanonicalQuoteLine extends QuoteRequestItem {
  unitAmountRaw: bigint;
  lineAmountRaw: bigint;
}

export interface CanonicalQuote {
  items: QuoteRequestItem[];
  lines: CanonicalQuoteLine[];
  amountRaw: bigint;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PRICE_RE = /^(?:0|[1-9]\d{0,9})(?:\.(\d{1,2}))?$/;
const I128_MAX = (BigInt(1) << BigInt(127)) - BigInt(1);
const RAW_UNITS_PER_CENT = BigInt(100_000);

/**
 * Parse the only browser-controlled quote fields we accept. Any browser price,
 * subtotal, total, currency, or token amount property is deliberately ignored.
 */
export function normalizeQuoteItems(input: unknown): QuoteRequestItem[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new QuoteValidationError("EMPTY_QUOTE", "Quote must contain at least one item.");
  }
  if (input.length > MAX_QUOTE_LINES) {
    throw new QuoteValidationError(
      "TOO_MANY_ITEMS",
      `Quote cannot contain more than ${MAX_QUOTE_LINES} line items.`
    );
  }

  const seen = new Set<string>();
  return input.map((raw, index) => {
    if (!raw || typeof raw !== "object") {
      throw new QuoteValidationError("INVALID_PRODUCT_ID", `Item ${index + 1} is invalid.`);
    }

    const record = raw as Record<string, unknown>;
    const productId = typeof record.productId === "string" ? record.productId.trim().toLowerCase() : "";
    if (!UUID_RE.test(productId)) {
      throw new QuoteValidationError(
        "INVALID_PRODUCT_ID",
        `Item ${index + 1} does not contain a canonical product id.`
      );
    }

    const quantity = record.quantity;
    if (
      typeof quantity !== "number" ||
      !Number.isSafeInteger(quantity) ||
      quantity < 1 ||
      quantity > MAX_QUANTITY_PER_LINE
    ) {
      throw new QuoteValidationError(
        "INVALID_QUANTITY",
        `Item ${index + 1} contains an invalid quantity.`
      );
    }

    if (seen.has(productId)) {
      throw new QuoteValidationError(
        "DUPLICATE_PRODUCT",
        "Duplicate product ids are not allowed in one quote."
      );
    }
    seen.add(productId);

    return { productId, quantity };
  });
}

/** Convert a numeric(12,2) catalog price into exact 7-decimal USDC raw units. */
export function catalogPriceToUsdcRaw(price: string | number): bigint {
  const text = String(price).trim();
  const match = PRICE_RE.exec(text);
  if (!match) {
    throw new QuoteValidationError("INVALID_CATALOG_PRICE", "Catalog contains an invalid price.");
  }

  const [wholeText, fractionText = ""] = text.split(".");
  const cents = BigInt(wholeText) * BigInt(100) + BigInt(fractionText.padEnd(2, "0") || "0");
  const raw = cents * RAW_UNITS_PER_CENT;
  if (raw <= 0 || raw > I128_MAX) {
    throw new QuoteValidationError("INVALID_CATALOG_PRICE", "Catalog price is outside checkout bounds.");
  }
  return raw;
}

/**
 * Resolve browser item identities against rows fetched independently by the
 * server from the canonical catalog. Browser price fields never participate in
 * this calculation.
 */
export function resolveCanonicalQuote(
  requestItems: QuoteRequestItem[],
  catalogRows: CanonicalCatalogRow[]
): CanonicalQuote {
  const rows = new Map(catalogRows.map((row) => [row.id.toLowerCase(), row]));
  let amountRaw = BigInt(0);

  const lines = requestItems.map((item) => {
    const row = rows.get(item.productId);
    if (!row) {
      throw new QuoteValidationError(
        "PRODUCT_NOT_FOUND",
        `Product ${item.productId} is not present in the canonical catalog.`
      );
    }

    const unitAmountRaw = catalogPriceToUsdcRaw(row.price);
    const lineAmountRaw = unitAmountRaw * BigInt(item.quantity);
    amountRaw += lineAmountRaw;
    if (amountRaw > I128_MAX) {
      throw new QuoteValidationError("AMOUNT_OVERFLOW", "Quote total exceeds checkout bounds.");
    }

    return { ...item, unitAmountRaw, lineAmountRaw };
  });

  return { items: requestItems, lines, amountRaw };
}
