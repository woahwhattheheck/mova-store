import { describe, expect, it } from "vitest";

import {
  normalizeRequestedCart,
  priceCartFromCatalog,
  rawUsdToString,
  usdCatalogPriceToRaw,
} from "../../lib/merchant-quote";

describe("merchant-authoritative quote pricing", () => {
  it("ignores browser-supplied price and total fields", () => {
    const requested = normalizeRequestedCart([
      { id: "sku-1", price: 0.01, total: 0.01, name: "tampered" },
    ]);
    const priced = priceCartFromCatalog(requested, [{ id: "sku-1", price: "29.00" }]);

    expect(priced.amountRaw).toBe(290_000_000n);
    expect(priced.amountUsd).toBe("29");
  });

  it("aggregates duplicate cart entries and explicit quantities", () => {
    const requested = normalizeRequestedCart([
      { id: "sku-1" },
      { id: "sku-1", quantity: 2 },
      { id: "sku-2", quantity: "3" },
    ]);

    expect(requested).toEqual([
      { id: "sku-1", quantity: 3 },
      { id: "sku-2", quantity: 3 },
    ]);

    const priced = priceCartFromCatalog(requested, [
      { id: "sku-1", price: "1.25" },
      { id: "sku-2", price: "2.00" },
    ]);
    expect(priced.amountRaw).toBe(97_500_000n);
  });

  it("rejects unknown products instead of trusting client copies", () => {
    const requested = normalizeRequestedCart([{ id: "deleted-product", price: 1 }]);
    expect(() => priceCartFromCatalog(requested, [])).toThrow("Unknown product");
  });

  it("rejects invalid or abusive quantities", () => {
    expect(() => normalizeRequestedCart([{ id: "a", quantity: 0 }])).toThrow(
      "Invalid quantity"
    );
    expect(() => normalizeRequestedCart([{ id: "a", quantity: -1 }])).toThrow(
      "Invalid quantity"
    );
    expect(() => normalizeRequestedCart([{ id: "a", quantity: 1.5 }])).toThrow(
      "Invalid quantity"
    );
  });

  it("converts canonical decimal prices to raw units without float multiplication", () => {
    expect(usdCatalogPriceToRaw("0.0000001")).toBe(1n);
    expect(usdCatalogPriceToRaw("12.34")).toBe(123_400_000n);
    expect(rawUsdToString(123_400_000n)).toBe("12.34");
    expect(() => usdCatalogPriceToRaw("1.00000001")).toThrow("Invalid canonical catalog price");
  });
});
