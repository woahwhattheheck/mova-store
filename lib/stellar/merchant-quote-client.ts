export interface MerchantQuoteLine {
  id: string;
  quantity: number;
  unitAmountRaw: string;
  lineAmountRaw: string;
}

export interface MerchantQuote {
  orderId: string;
  orderIdHex: string;
  buyer: string;
  tokenContractId: string;
  amountRaw: string;
  amountUsd: string;
  expiresAt: number;
  lines: MerchantQuoteLine[];
  quoteTxHash: string;
}

function validateQuote(value: unknown, expectedBuyer: string): MerchantQuote {
  if (!value || typeof value !== "object") throw new Error("Quote service returned invalid data.");
  const quote = value as Partial<MerchantQuote>;
  if (
    typeof quote.orderId !== "string" ||
    !/^[0-9a-f]{64}$/i.test(String(quote.orderIdHex ?? "")) ||
    quote.buyer !== expectedBuyer ||
    typeof quote.tokenContractId !== "string" ||
    !/^\d+$/.test(String(quote.amountRaw ?? "")) ||
    BigInt(String(quote.amountRaw)) <= 0n ||
    typeof quote.amountUsd !== "string" ||
    !Number.isSafeInteger(quote.expiresAt) ||
    Number(quote.expiresAt) <= Math.floor(Date.now() / 1000) ||
    !Array.isArray(quote.lines) ||
    typeof quote.quoteTxHash !== "string"
  ) {
    throw new Error("Quote service returned an invalid or stale merchant quote.");
  }
  return quote as MerchantQuote;
}

/**
 * Request a canonical merchant quote. Only product identity/quantity is sent;
 * caller-supplied item prices and cart totals are intentionally omitted.
 */
export async function requestMerchantQuote(
  cartItems: unknown[],
  buyer: string
): Promise<MerchantQuote> {
  const items = cartItems.map((item) => {
    const value = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    return {
      id: value.id,
      ...(value.quantity === undefined ? {} : { quantity: value.quantity }),
    };
  });

  const response = await fetch("/api/checkout/quote", {
    method: "POST",
    headers: { "content-type": "application/json" },
    cache: "no-store",
    body: JSON.stringify({ buyer, items }),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    quote?: unknown;
    error?: unknown;
  };
  if (!response.ok) {
    throw new Error(
      typeof payload.error === "string" ? payload.error : "Unable to obtain merchant quote."
    );
  }
  return validateQuote(payload.quote, buyer);
}
