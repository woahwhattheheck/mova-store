export const QUOTE_TOKEN_DECIMALS = 7;
export const MAX_QUOTE_LINES = 100;
export const MAX_QUOTE_UNITS = 500;

export interface RequestedCartLine {
  id: string;
  quantity: number;
}

export interface CatalogPriceRow {
  id: string | number;
  price: string | number;
}

export interface CanonicalQuoteLine {
  id: string;
  quantity: number;
  unitAmountRaw: string;
  lineAmountRaw: string;
}

export interface PricedCart {
  amountRaw: bigint;
  amountUsd: string;
  lines: CanonicalQuoteLine[];
}

/**
 * Reduce browser cart data to the only fields the quote service accepts.
 * Browser-supplied price/total/name fields are deliberately ignored.
 *
 * Mova currently stores one cart object per unit; an optional `quantity`
 * field is also accepted so future clients do not need a pricing redesign.
 */
export function normalizeRequestedCart(input: unknown): RequestedCartLine[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error("Cart is empty.");
  }

  const quantities = new Map<string, number>();
  let totalUnits = 0;

  for (const raw of input) {
    if (!raw || typeof raw !== "object") {
      throw new Error("Cart contains an invalid item.");
    }
    const value = raw as Record<string, unknown>;
    const id = String(value.id ?? "").trim();
    if (!id) throw new Error("Cart item is missing a product id.");

    const quantityValue = value.quantity ?? 1;
    const quantity =
      typeof quantityValue === "number"
        ? quantityValue
        : Number.parseInt(String(quantityValue), 10);
    if (!Number.isSafeInteger(quantity) || quantity <= 0 || quantity > MAX_QUOTE_UNITS) {
      throw new Error(`Invalid quantity for product ${id}.`);
    }

    totalUnits += quantity;
    if (totalUnits > MAX_QUOTE_UNITS) {
      throw new Error("Cart contains too many units.");
    }
    quantities.set(id, (quantities.get(id) ?? 0) + quantity);
  }

  if (quantities.size > MAX_QUOTE_LINES) {
    throw new Error("Cart contains too many distinct products.");
  }

  return [...quantities.entries()]
    .map(([id, quantity]) => ({ id, quantity }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Convert a canonical USD catalog price to exact 7-decimal token units. */
export function usdCatalogPriceToRaw(value: string | number): bigint {
  if (typeof value === "number" && (!Number.isFinite(value) || value <= 0)) {
    throw new Error("Catalog price must be positive.");
  }

  const text = String(value).trim();
  const match = /^(\d+)(?:\.(\d{1,7}))?$/.exec(text);
  if (!match) {
    throw new Error(`Invalid canonical catalog price: ${text}`);
  }

  const whole = BigInt(match[1]);
  const fraction = (match[2] ?? "").padEnd(QUOTE_TOKEN_DECIMALS, "0");
  const raw = whole * 10n ** BigInt(QUOTE_TOKEN_DECIMALS) + BigInt(fraction || "0");
  if (raw <= 0n) throw new Error("Catalog price must be positive.");
  return raw;
}

export function rawUsdToString(raw: bigint): string {
  if (raw < 0n) throw new Error("Raw amount cannot be negative.");
  const scale = 10n ** BigInt(QUOTE_TOKEN_DECIMALS);
  const whole = raw / scale;
  const fractional = (raw % scale).toString().padStart(QUOTE_TOKEN_DECIMALS, "0");
  const trimmed = fractional.replace(/0+$/, "");
  return trimmed ? `${whole}.${trimmed}` : whole.toString();
}

/**
 * Price normalized requested lines exclusively from canonical catalog rows.
 * Unknown products and duplicate catalog ids fail closed.
 */
export function priceCartFromCatalog(
  requested: RequestedCartLine[],
  catalogRows: CatalogPriceRow[]
): PricedCart {
  const catalog = new Map<string, bigint>();
  for (const row of catalogRows) {
    const id = String(row.id).trim();
    if (!id) throw new Error("Catalog row is missing an id.");
    if (catalog.has(id)) throw new Error(`Duplicate canonical product id: ${id}`);
    catalog.set(id, usdCatalogPriceToRaw(row.price));
  }

  let amountRaw = 0n;
  const lines: CanonicalQuoteLine[] = [];
  for (const line of requested) {
    const unit = catalog.get(line.id);
    if (unit === undefined) throw new Error(`Unknown product: ${line.id}`);
    const lineAmount = unit * BigInt(line.quantity);
    amountRaw += lineAmount;
    lines.push({
      id: line.id,
      quantity: line.quantity,
      unitAmountRaw: unit.toString(),
      lineAmountRaw: lineAmount.toString(),
    });
  }

  if (amountRaw <= 0n) throw new Error("Quoted amount must be positive.");
  return { amountRaw, amountUsd: rawUsdToString(amountRaw), lines };
}
