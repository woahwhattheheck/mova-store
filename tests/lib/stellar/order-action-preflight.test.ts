import { describe, expect, it } from "vitest";

import {
  OrderDetails,
  OrderStatus,
  validateOrderActionPreflight,
} from "../../../lib/stellar/orders";

const paidOrder = (overrides: Partial<OrderDetails> = {}): OrderDetails => ({
  orderId: "SS-ORDER-42",
  orderIdHash: "ab".repeat(32),
  buyer: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
  amount: BigInt(125_0000000),
  amountDisplay: "125.00",
  token: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
  tokenSymbol: "USDC",
  timestamp: 1_789_316_000,
  status: "Paid",
  ledger: 123,
  txHash: "deadbeef",
  ...overrides,
});

describe("merchant order action preflight", () => {
  it.each(["dispatch", "refund"] as const)(
    "allows %s only for a complete currently-paid escrow order",
    (action) => {
      const order = paidOrder();
      const result = validateOrderActionPreflight(order.orderId, action, order);

      expect(result.allowed).toBe(true);
      expect(result.action).toBe(action);
      expect(result.order).toBe(order);
      expect(result.error).toBeUndefined();
    }
  );

  it.each(["Pending", "Shipped", "Refunded", "Unknown"] as OrderStatus[])(
    "rejects stale indexed actions when the contract status is %s",
    (status) => {
      const order = paidOrder({ status });
      const result = validateOrderActionPreflight(order.orderId, "refund", order);

      expect(result.allowed).toBe(false);
      expect(result.error).toMatch(new RegExp(`status is ${status}`, "i"));
    }
  );

  it("fails closed when the current contract order cannot be read", () => {
    const result = validateOrderActionPreflight("SS-ORDER-42", "dispatch", null);

    expect(result.allowed).toBe(false);
    expect(result.error).toMatch(/current on-chain state could not be read/i);
  });

  it("rejects a contract read for a different order id", () => {
    const result = validateOrderActionPreflight(
      "SS-ORDER-42",
      "dispatch",
      paidOrder({ orderId: "SS-ORDER-OTHER" })
    );

    expect(result.allowed).toBe(false);
    expect(result.error).toMatch(/different order id/i);
  });

  it.each([
    ["zero escrow", { amount: BigInt(0) }],
    ["missing buyer", { buyer: "" }],
    ["missing token", { token: "" }],
  ] as const)("rejects incomplete on-chain escrow details: %s", (_label, overrides) => {
    const result = validateOrderActionPreflight(
      "SS-ORDER-42",
      "refund",
      paidOrder(overrides)
    );

    expect(result.allowed).toBe(false);
    expect(result.error).toMatch(/escrow details are incomplete/i);
  });
});
