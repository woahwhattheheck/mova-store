import { describe, expect, it } from "vitest";

import {
  QuoteValidationError,
  catalogPriceToUsdcRaw,
  normalizeQuoteItems,
  resolveCanonicalQuote,
} from "../../lib/checkout-quote";

const PRODUCT_A = "11111111-1111-4111-8111-111111111111";
const PRODUCT_B = "22222222-2222-4222-8222-222222222222";

function errorCode(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error instanceof QuoteValidationError ? error.code : undefined;
  }
}

describe("merchant-authoritative quote resolution", () => {
  it("ignores hostile browser price and total fields", () => {
    const items = normalizeQuoteItems([
      {
        productId: PRODUCT_A,
        quantity: 2,
        price: 0.01,
        unitPrice: -999,
        total: 0.02,
        amountRaw: "1",
      },
    ]);

    expect(items).toEqual([{ productId: PRODUCT_A, quantity: 2 }]);
    const quote = resolveCanonicalQuote(items, [{ id: PRODUCT_A, price: "12.34" }]);
    expect(quote.amountRaw).toBe(BigInt("246800000"));
    expect(quote.lines[0].unitAmountRaw).toBe(BigInt("123400000"));
  });

  it("uses exact cents-to-USDC conversion without floating point math", () => {
    expect(catalogPriceToUsdcRaw("0.01")).toBe(BigInt("100000"));
    expect(catalogPriceToUsdcRaw("12.34")).toBe(BigInt("123400000"));
    expect(catalogPriceToUsdcRaw(99.9)).toBe(BigInt("999000000"));
  });

  it("rejects duplicate product ids before catalog lookup", () => {
    expect(
      errorCode(() =>
        normalizeQuoteItems([
          { productId: PRODUCT_A, quantity: 1 },
          { productId: PRODUCT_A.toUpperCase(), quantity: 2 },
        ])
      )
    ).toBe("DUPLICATE_PRODUCT");
  });

  it("rejects zero, fractional, negative, and unsafe quantities", () => {
    for (const quantity of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(errorCode(() => normalizeQuoteItems([{ productId: PRODUCT_A, quantity }]))).toBe(
        "INVALID_QUANTITY"
      );
    }
  });

  it("rejects unknown products rather than trusting a browser-provided fallback", () => {
    const items = normalizeQuoteItems([
      { productId: PRODUCT_B, quantity: 1, price: 1 } as unknown as Record<string, unknown>,
    ]);
    expect(errorCode(() => resolveCanonicalQuote(items, [{ id: PRODUCT_A, price: "12.34" }]))).toBe(
      "PRODUCT_NOT_FOUND"
    );
  });

  it("sums distinct canonical products and quantities", () => {
    const items = normalizeQuoteItems([
      { productId: PRODUCT_A, quantity: 2 },
      { productId: PRODUCT_B, quantity: 3 },
    ]);
    const quote = resolveCanonicalQuote(items, [
      { id: PRODUCT_A, price: "1.25" },
      { id: PRODUCT_B, price: "2.00" },
    ]);

    expect(quote.amountRaw).toBe(BigInt("85000000"));
  });

  it("rejects empty quotes and malformed catalog prices", () => {
    expect(errorCode(() => normalizeQuoteItems([]))).toBe("EMPTY_QUOTE");
    expect(errorCode(() => catalogPriceToUsdcRaw("12.345"))).toBe("INVALID_CATALOG_PRICE");
    expect(errorCode(() => catalogPriceToUsdcRaw("0"))).toBe("INVALID_CATALOG_PRICE");
  });
});
