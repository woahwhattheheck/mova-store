import { describe, expect, it, vi } from "vitest";

import {
  cartItemsToQuoteLines,
  requestMerchantQuote,
} from "../../lib/checkout/client-quote";

const buyer = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const token = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";

function response(body: unknown, status = 201): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function validQuote() {
  return {
    orderId: "MQ-123",
    buyer,
    tokenContractId: token,
    amountRaw: "250000000",
    amountUsd: "25",
    issuedAt: 1_000,
    expiresAt: 1_600,
    lines: [
      {
        productId: 1,
        quantity: 2,
        unitAmountRaw: "125000000",
        lineAmountRaw: "250000000",
      },
    ],
  };
}

describe("browser merchant-quote boundary", () => {
  it("collapses repeated cart items and drops hostile local price fields", () => {
    expect(
      cartItemsToQuoteLines([
        { id: 1, price: 999999, totalPrice: 999999 },
        { id: 1, price: 0.01, totalPrice: 0.01 },
        { id: 2, price: -50 },
      ])
    ).toEqual([
      { productId: 1, quantity: 2 },
      { productId: 2, quantity: 1 },
    ]);
  });

  it("sends only buyer, token and product-id/quantity lines to the quote API", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const sent = JSON.parse(String(init?.body));
      expect(sent).toEqual({
        buyer,
        tokenContractId: token,
        lines: [{ productId: 1, quantity: 2 }],
      });
      expect(JSON.stringify(sent)).not.toContain("price");
      expect(JSON.stringify(sent)).not.toContain("totalPrice");
      return response(validQuote());
    }) as unknown as typeof fetch;

    const quote = await requestMerchantQuote({
      cartItems: [
        { id: 1, price: 0.01 },
        { id: 1, price: 0.01 },
      ],
      buyer,
      tokenContractId: token,
      fetchImpl,
      nowSeconds: 1_100,
    });

    expect(quote.amountRaw).toBe("250000000");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects a quote for a different buyer", async () => {
    const fetchImpl = vi.fn(async () =>
      response({ ...validQuote(), buyer: "GDIFFERENT" })
    ) as unknown as typeof fetch;

    await expect(
      requestMerchantQuote({
        cartItems: [{ id: 1 }],
        buyer,
        tokenContractId: token,
        fetchImpl,
        nowSeconds: 1_100,
      })
    ).rejects.toThrow(/buyer/);
  });

  it("rejects a quote for a different token", async () => {
    const fetchImpl = vi.fn(async () =>
      response({ ...validQuote(), tokenContractId: "CWRONG" })
    ) as unknown as typeof fetch;

    await expect(
      requestMerchantQuote({
        cartItems: [{ id: 1 }],
        buyer,
        tokenContractId: token,
        fetchImpl,
        nowSeconds: 1_100,
      })
    ).rejects.toThrow(/token/);
  });

  it("rejects stale quote responses before payment construction", async () => {
    const fetchImpl = vi.fn(async () => response(validQuote())) as unknown as typeof fetch;

    await expect(
      requestMerchantQuote({
        cartItems: [{ id: 1 }],
        buyer,
        tokenContractId: token,
        fetchImpl,
        nowSeconds: 1_600,
      })
    ).rejects.toThrow(/expired/);
  });

  it("surfaces server-side quote rejection without using a browser fallback total", async () => {
    const fetchImpl = vi.fn(async () => response({ error: "unknown productId: 999" }, 400)) as unknown as typeof fetch;

    await expect(
      requestMerchantQuote({
        cartItems: [{ id: 999, price: 0.01 }],
        buyer,
        tokenContractId: token,
        fetchImpl,
        nowSeconds: 1_100,
      })
    ).rejects.toThrow(/unknown productId/);
  });
});
