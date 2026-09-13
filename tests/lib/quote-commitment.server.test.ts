import { describe, expect, it } from "vitest";

import {
  committedOrderId,
  verifyCommittedOrderId,
} from "../../lib/checkout/quote-commitment.server";
import { deriveMerchantQuote } from "../../lib/checkout/merchant-quote";

const buyer = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const token = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";

function committedQuote() {
  const provisional = deriveMerchantQuote({
    lines: [{ productId: 1, quantity: 2 }],
    products: [{ id: 1, price: "12.50" }],
    buyer,
    tokenContractId: token,
    orderId: "MQ-pending-commitment",
    quoteNonce: "nonce-commitment",
    nowSeconds: 1_000,
  });
  const { orderId: _ignored, ...fields } = provisional;
  return { ...provisional, orderId: committedOrderId(fields) };
}

describe("merchant quote order-id commitment", () => {
  it("verifies the exact canonical quote", () => {
    const quote = committedQuote();
    expect(quote.orderId).toMatch(/^MQ-[0-9a-f]{64}$/);
    expect(verifyCommittedOrderId(quote)).toBe(true);
  });

  it("rejects same-price fulfillment line substitution", () => {
    const quote = committedQuote();
    const tampered = {
      ...quote,
      lines: [{ ...quote.lines[0], productId: 999 }],
    };
    expect(verifyCommittedOrderId(tampered)).toBe(false);
  });

  it("rejects quantity, buyer, token, amount, expiry and nonce tampering", () => {
    const quote = committedQuote();
    const variants = [
      { ...quote, lines: [{ ...quote.lines[0], quantity: 3 }] },
      { ...quote, buyer: "GOTHER" },
      { ...quote, tokenContractId: "COTHER" },
      { ...quote, amountRaw: "249999999" },
      { ...quote, expiresAt: quote.expiresAt + 1 },
      { ...quote, quoteNonce: "different-nonce" },
    ];

    for (const variant of variants) {
      expect(verifyCommittedOrderId(variant)).toBe(false);
    }
  });
});
