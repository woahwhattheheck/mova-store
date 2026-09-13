export class CheckoutQuoteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckoutQuoteError";
  }
}

export type CatalogPriceRow = {
  id: string;
  price: number | string;
};

const PRODUCT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_CART_ITEMS = 100;

export function normalizeProductIds(input: unknown): string[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new CheckoutQuoteError("cart must contain at least one product");
  }
  if (input.length > MAX_CART_ITEMS) {
    throw new CheckoutQuoteError("cart exceeds the maximum supported item count");
  }

  return input.map((value) => {
    if (typeof value !== "string") {
      throw new CheckoutQuoteError("every cart item must contain a product id");
    }
    const id = value.trim();
    if (!PRODUCT_ID_RE.test(id)) {
      throw new CheckoutQuoteError("cart contains an invalid product id");
    }
    return id;
  });
}

function priceToCents(value: number | string): number {
  const text = typeof value === "number" ? String(value) : value.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) {
    throw new CheckoutQuoteError("catalog contains an invalid product price");
  }

  const amount = Number(text);
  const cents = Math.round(amount * 100);
  if (!Number.isFinite(amount) || !Number.isSafeInteger(cents) || cents <= 0) {
    throw new CheckoutQuoteError("catalog contains an invalid product price");
  }
  return cents;
}

export function buildCatalogQuote(productIds: string[], rows: CatalogPriceRow[]) {
  if (productIds.length === 0) {
    throw new CheckoutQuoteError("cart must contain at least one product");
  }

  const rowsById = new Map<string, CatalogPriceRow>();
  for (const row of rows) {
    if (!row || typeof row.id !== "string" || rowsById.has(row.id)) {
      throw new CheckoutQuoteError("catalog response is ambiguous");
    }
    rowsById.set(row.id, row);
  }

  let amountCents = 0;
  for (const productId of productIds) {
    const row = rowsById.get(productId);
    if (!row) {
      throw new CheckoutQuoteError("cart contains a product that is no longer available");
    }
    amountCents += priceToCents(row.price);
    if (!Number.isSafeInteger(amountCents)) {
      throw new CheckoutQuoteError("quoted cart total is too large");
    }
  }

  return {
    amountCents,
    itemCount: productIds.length,
  };
}
