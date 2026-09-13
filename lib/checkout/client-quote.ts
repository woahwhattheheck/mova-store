import {
  assertFreshQuote,
  type MerchantQuote,
  type ProductId,
  type QuoteCartLine,
} from "./merchant-quote";

export interface BrowserCartItem {
  id?: unknown;
  productId?: unknown;
  price?: unknown;
  totalPrice?: unknown;
  [key: string]: unknown;
}

function idKey(id: ProductId): string {
  return typeof id === "number" ? String(id) : id.trim();
}

/**
 * Collapse the browser cart into the only fields the quote server accepts.
 * Local `price`, `totalPrice`, names and other presentation fields never cross
 * the merchant-pricing boundary.
 */
export function cartItemsToQuoteLines(input: unknown): QuoteCartLine[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error("cart must contain at least one item");
  }

  const counts = new Map<string, QuoteCartLine>();
  for (const [index, raw] of input.entries()) {
    if (!raw || typeof raw !== "object") {
      throw new Error(`cart item ${index + 1} must be an object`);
    }

    const item = raw as BrowserCartItem;
    const id = (item.productId ?? item.id) as ProductId;
    if (typeof id !== "string" && typeof id !== "number") {
      throw new Error(`cart item ${index + 1} is missing a product id`);
    }
    if (typeof id === "number" && (!Number.isSafeInteger(id) || id < 0)) {
      throw new Error(`cart item ${index + 1} has an invalid product id`);
    }
    if (typeof id === "string" && !id.trim()) {
      throw new Error(`cart item ${index + 1} has an empty product id`);
    }

    const key = idKey(id);
    const current = counts.get(key);
    if (current) {
      current.quantity += 1;
    } else {
      counts.set(key, { productId: id, quantity: 1 });
    }
  }

  return [...counts.values()];
}

function parseQuoteResponse(
  value: unknown,
  expected: { buyer: string; tokenContractId: string }
): MerchantQuote {
  if (!value || typeof value !== "object") throw new Error("quote response is malformed");
  const quote = value as Partial<MerchantQuote>;

  if (typeof quote.orderId !== "string" || !/^MQ-[0-9a-f]{64}$/.test(quote.orderId)) {
    throw new Error("quote response has an invalid committed order id");
  }
  if (typeof quote.quoteNonce !== "string" || !quote.quoteNonce.trim()) {
    throw new Error("quote response is missing its commitment nonce");
  }
  if (quote.buyer !== expected.buyer) throw new Error("quote buyer does not match wallet");
  if (quote.tokenContractId !== expected.tokenContractId) {
    throw new Error("quote token does not match checkout token");
  }
  if (typeof quote.amountRaw !== "string" || !/^[1-9]\d*$/.test(quote.amountRaw)) {
    throw new Error("quote raw amount is invalid");
  }
  if (typeof quote.amountUsd !== "string" || !/^\d+(?:\.\d+)?$/.test(quote.amountUsd)) {
    throw new Error("quote display amount is invalid");
  }
  if (
    typeof quote.issuedAt !== "number" ||
    typeof quote.expiresAt !== "number" ||
    !Number.isSafeInteger(quote.issuedAt) ||
    !Number.isSafeInteger(quote.expiresAt)
  ) {
    throw new Error("quote timestamps are invalid");
  }
  if (!Array.isArray(quote.lines) || quote.lines.length === 0) {
    throw new Error("quote lines are missing");
  }

  return quote as MerchantQuote;
}

export async function requestMerchantQuote(input: {
  cartItems: unknown;
  buyer: string;
  tokenContractId: string;
  fetchImpl?: typeof fetch;
  nowSeconds?: number;
}): Promise<MerchantQuote> {
  const lines = cartItemsToQuoteLines(input.cartItems);
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl("/api/checkout/quote", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify({
      buyer: input.buyer,
      tokenContractId: input.tokenContractId,
      lines,
    }),
  });

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("merchant quote service returned invalid JSON");
  }

  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && typeof (payload as { error?: unknown }).error === "string"
        ? (payload as { error: string }).error
        : `merchant quote failed with HTTP ${response.status}`;
    throw new Error(message);
  }

  const quote = parseQuoteResponse(payload, {
    buyer: input.buyer,
    tokenContractId: input.tokenContractId,
  });
  assertFreshQuote(quote, input.nowSeconds ?? Math.floor(Date.now() / 1000));
  return quote;
}
