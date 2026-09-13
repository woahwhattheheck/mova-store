import { describe, expect, it } from "vitest";

import {
  assertFreshQuote,
  decimalToRawUnits,
  deriveMerchantQuote,
  normalizeCartLines,
} from "../../lib/checkout/merchant-quote";

const buyer = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const token = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";

function quote(overrides: Partial<Parameters<typeof deriveMerchantQuote>[0]> = {}) {
  return deriveMerchantQuote({
    lines: [{ productId: 1, quantity: 2 }],
    products: [{ id: 1, name: "Canonical item", price: "12.50" }],
    buyer,
    tokenContractId: token,
    orderId: "MQ-test",
    nowSeconds: 1_000,
    ...overrides,
  });
}

describe("merchant-authoritative quote derivation", () => {
  it("prices only from canonical catalog rows and returns exact raw units", () => {
    const result = quote();

    expect(result.amountRaw).toBe("250000000");
    expect(result.amountUsd).toBe("25");
    expect(result.issuedAt).toBe(1_000);
    expect(result.expiresAt).toBe(1_600);
    expect(result.lines).toEqual([
      {
        productId: 1,
        quantity: 2,
        unitAmountRaw: "125000000",
        lineAmountRaw: "250000000",
      },
    ]);
  });

  it("ignores hostile browser/localStorage price and total fields", () => {
    const hostile = [
      {
        productId: 1,
        quantity: 2,
        price: 0.01,
        totalPrice: 0.02,
        unitAmountRaw: "1",
      },
    ] as unknown;

    const lines = normalizeCartLines(hostile);
    const result = quote({ lines });

    expect(lines).toEqual([{ productId: 1, quantity: 2 }]);
    expect(result.amountRaw).toBe("250000000");
  });

  it("rejects duplicate product ids instead of allowing ambiguous quantities", () => {
    expect(() =>
      normalizeCartLines([
        { productId: 1, quantity: 1 },
        { productId: "1", quantity: 1 },
      ])
    ).toThrow(/duplicate productId/);
  });

  it.each([0, -1, 1.5, 101, Number.NaN])(
    "rejects hostile quantity %s",
    (quantity) => {
      expect(() => normalizeCartLines([{ productId: 1, quantity }])).toThrow(/quantity/);
    }
  );

  it("rejects unknown products even if the browser supplies a price", () => {
    expect(() =>
      deriveMerchantQuote({
        lines: [{ productId: "missing", quantity: 1 }],
        products: [{ id: 1, price: "12.50" }],
        buyer,
        tokenContractId: token,
        orderId: "MQ-unknown",
        nowSeconds: 1_000,
      })
    ).toThrow(/unknown productId/);
  });

  it("fails closed on catalog precision the settlement token cannot represent", () => {
    expect(() => decimalToRawUnits("1.00000001", 7)).toThrow(/exceeds 7 decimal places/);
  });

  it("rejects zero and malformed canonical catalog prices", () => {
    expect(() => decimalToRawUnits("0", 7)).toThrow(/positive/);
    expect(() => decimalToRawUnits("1e2", 7)).toThrow(/invalid canonical price/);
  });

  it("treats expiry as terminal at the exact expiry second", () => {
    const result = quote({ nowSeconds: 1_000, ttlSeconds: 60 });
    expect(() => assertFreshQuote(result, 1_059)).not.toThrow();
    expect(() => assertFreshQuote(result, 1_060)).toThrow(/expired/);
    expect(() => assertFreshQuote(result, 5_000)).toThrow(/expired/);
  });
});
