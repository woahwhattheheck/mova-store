import { describe, expect, it } from "vitest";
import {
  MERCHANT_ORDER_INDEX_SCHEMA,
  merchantRowToDisplayAmount,
  merchantSeedEquals,
  normalizeMerchantOrderSeed,
  reconcileMerchantOrder,
  type MerchantOrderSeed,
} from "../../lib/merchant-order-index";

const seed = (): MerchantOrderSeed => ({
  schemaVersion: MERCHANT_ORDER_INDEX_SCHEMA,
  orderId: `MQ1:${"a".repeat(64)}:00000000-0000-4000-8000-000000000000`,
  cartDigestSha256: "a".repeat(64),
  buyer: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
  tokenContractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
  tokenSymbol: "USDC",
  amountRaw: "123400000",
  authValidUntilLedger: 123456,
});

describe("merchant order durable index", () => {
  it("normalizes exact immutable quote identity", () => {
    const value = seed();
    value.cartDigestSha256 = value.cartDigestSha256.toUpperCase();
    expect(normalizeMerchantOrderSeed(value).cartDigestSha256).toBe("a".repeat(64));
  });

  it("treats exact seed replay as idempotent", () => {
    expect(merchantSeedEquals(seed(), { ...seed() })).toBe(true);
  });

  it("rejects conflicting quote seed", () => {
    expect(merchantSeedEquals(seed(), { ...seed(), amountRaw: "123400001" })).toBe(false);
  });

  it("keeps an unsubmitted quote visible without chain history", () => {
    expect(reconcileMerchantOrder(seed(), null)).toEqual({
      chainStatus: "Quoted",
      identityConflict: false,
      conflictReasons: [],
    });
  });

  it("promotes an exact direct contract read", () => {
    const result = reconcileMerchantOrder(seed(), {
      buyer: seed().buyer,
      tokenContractId: seed().tokenContractId,
      amountRaw: seed().amountRaw,
      status: "Paid",
      timestamp: 1789380000,
    });
    expect(result.chainStatus).toBe("Paid");
    expect(result.identityConflict).toBe(false);
  });

  it("fails closed on immutable identity disagreement", () => {
    const result = reconcileMerchantOrder(seed(), {
      buyer: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB7OLQ",
      tokenContractId: seed().tokenContractId,
      amountRaw: "1",
      status: "Paid",
      timestamp: 1789380000,
    });
    expect(result.chainStatus).toBe("Conflict");
    expect(result.conflictReasons).toEqual(["BUYER_MISMATCH", "AMOUNT_MISMATCH"]);
  });

  it("preserves a previously observed status on a null direct read", () => {
    expect(reconcileMerchantOrder(seed(), null, "Paid").chainStatus).toBe("Paid");
  });

  it("rejects an order id whose embedded cart digest disagrees", () => {
    expect(() => normalizeMerchantOrderSeed({ ...seed(), cartDigestSha256: "b".repeat(64) })).toThrow();
  });

  it("rejects quote amounts above Soroban signed-i128", () => {
    expect(() => normalizeMerchantOrderSeed({ ...seed(), amountRaw: (1n << 127n).toString() })).toThrow();
  });

  it("formats bigint amounts without Number precision loss", () => {
    expect(merchantRowToDisplayAmount({ amountRaw: "123456789" })).toBe("12.34");
  });

  it("rejects malformed amount input", () => {
    expect(() => normalizeMerchantOrderSeed({ ...seed(), amountRaw: "1e7" })).toThrow();
  });
});
