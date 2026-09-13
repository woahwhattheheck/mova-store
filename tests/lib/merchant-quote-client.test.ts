import { afterEach, describe, expect, it, vi } from "vitest";

import { requestMerchantQuote } from "../../lib/stellar/merchant-quote-client";

const BUYER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const TOKEN = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

function validQuote(overrides: Record<string, unknown> = {}) {
  return {
    orderId: "MQ-test-order",
    orderIdHex: "ab".repeat(32),
    buyer: BUYER,
    tokenContractId: TOKEN,
    amountRaw: "290000000",
    amountUsd: "29",
    expiresAt: Math.floor(Date.now() / 1000) + 600,
    lines: [
      {
        id: "sku-1",
        quantity: 1,
        unitAmountRaw: "290000000",
        lineAmountRaw: "290000000",
      },
    ],
    quoteTxHash: "0123456789abcdef",
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 201): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("requestMerchantQuote", () => {
  it("never forwards browser price, subtotal, total, or name fields", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({
        buyer: BUYER,
        items: [{ id: "sku-1", quantity: 2 }],
      });
      return jsonResponse({ quote: validQuote() });
    });
    vi.stubGlobal("fetch", fetchMock);

    const quote = await requestMerchantQuote(
      [
        {
          id: "sku-1",
          quantity: 2,
          name: "tampered",
          price: 0.01,
          subtotal: 0.02,
          total: 0.02,
        },
      ],
      BUYER
    );

    expect(quote.amountRaw).toBe("290000000");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects a quote bound to another buyer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ quote: validQuote({ buyer: "GOTHER" }) }))
    );

    await expect(requestMerchantQuote([{ id: "sku-1" }], BUYER)).rejects.toThrow(
      "invalid or stale merchant quote"
    );
  });

  it("rejects expired and non-positive quote responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          quote: validQuote({
            expiresAt: Math.floor(Date.now() / 1000) - 1,
          }),
        })
      )
    );
    await expect(requestMerchantQuote([{ id: "sku-1" }], BUYER)).rejects.toThrow(
      "invalid or stale merchant quote"
    );

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ quote: validQuote({ amountRaw: "0" }) }))
    );
    await expect(requestMerchantQuote([{ id: "sku-1" }], BUYER)).rejects.toThrow(
      "invalid or stale merchant quote"
    );
  });

  it("surfaces quote-service errors without inventing a fallback amount", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "Catalog lookup failed" }, 503))
    );

    await expect(requestMerchantQuote([{ id: "sku-1", price: 0.01 }], BUYER)).rejects.toThrow(
      "Catalog lookup failed"
    );
  });
});
