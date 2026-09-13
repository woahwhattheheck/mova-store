import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createPaidBuyerOrderSnapshot,
  getCachedBuyerOrders,
  savePaidBuyerOrderOnce,
} from "../../lib/buyer-orders";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  from: vi.fn(),
  insert: vi.fn(),
}));

vi.mock("../../lib/supabase", () => ({
  supabase: {
    auth: {
      getSession: mocks.getSession,
    },
    from: mocks.from,
  },
}));

const fulfillment = {
  firstName: "Ada",
  lastName: "Lovelace",
  email: "ada@example.com",
  address: "123 Main Street",
};

const baseInput = {
  orderId: "SS-PAID-1",
  total: 125,
  tokenSymbol: "USDC",
  tokenAmount: 125,
  txHash: "abc123",
  ledger: 42,
  createdAt: "2026-09-13T16:00:00.000Z",
  items: [{ id: "product-1", name: "Jacket", price: 125, quantity: 1 }],
  fulfillment,
};

describe("paid order fulfillment snapshots", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    mocks.getSession.mockResolvedValue({ data: { session: null }, error: null });
    mocks.insert.mockResolvedValue({ data: null, error: null });
    mocks.from.mockImplementation(() => ({ insert: mocks.insert }));
  });

  it("builds a detached paid snapshot and normalizes line quantities", () => {
    const source = [{ id: "product-1", name: " Jacket ", price: "125", quantity: undefined }];
    const snapshot = createPaidBuyerOrderSnapshot({ ...baseInput, items: source });

    expect(snapshot.items).toEqual([
      { id: "product-1", name: "Jacket", price: 125, quantity: 1 },
    ]);
    expect(snapshot.fulfillment).toEqual(fulfillment);

    source[0].name = "Mutated later";
    expect(snapshot.items[0].name).toBe("Jacket");
  });

  it.each([
    { label: "empty cart", items: [] },
    { label: "non-object line", items: [null] },
    { label: "blank item name", items: [{ name: " ", price: 5 }] },
    { label: "negative item price", items: [{ name: "Bad", price: -1 }] },
    { label: "zero quantity", items: [{ name: "Bad", price: 1, quantity: 0 }] },
  ])("rejects malformed fulfillment evidence: $label", ({ items }) => {
    expect(() => createPaidBuyerOrderSnapshot({ ...baseInput, items })).toThrow();
  });

  it("persists a guest snapshot once and rejects a conflicting terminal reuse", async () => {
    const first = await savePaidBuyerOrderOnce(baseInput);
    const replay = await savePaidBuyerOrderOnce({ ...baseInput, txHash: "different-proof-same-commerce" });

    expect(first.orderId).toBe("SS-PAID-1");
    expect(replay.orderId).toBe("SS-PAID-1");
    expect(getCachedBuyerOrders()).toHaveLength(1);
    expect(mocks.from).not.toHaveBeenCalled();

    await expect(
      savePaidBuyerOrderOnce({ ...baseInput, total: 1, tokenAmount: 1 })
    ).rejects.toThrow(/conflicting commerce evidence/i);
    expect(getCachedBuyerOrders()).toHaveLength(1);
  });

  it("stores signed-in fulfillment context inside a versioned JSON envelope", async () => {
    mocks.getSession.mockResolvedValueOnce({
      data: {
        session: {
          user: { id: "user-123", email: "ada@example.com" },
        },
      },
      error: null,
    });

    await savePaidBuyerOrderOnce(baseInput);

    expect(mocks.insert).toHaveBeenCalledTimes(1);
    const [rows] = mocks.insert.mock.calls[0];
    expect(rows).toHaveLength(1);
    expect(rows[0].order_id).toBe("SS-PAID-1");
    expect(rows[0].user_id).toBe("user-123");
    expect(rows[0].items).toEqual({
      schemaVersion: 1,
      lines: [{ id: "product-1", name: "Jacket", price: 125, quantity: 1 }],
      fulfillment,
    });
  });
});
