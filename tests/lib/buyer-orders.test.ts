import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  saveBuyerOrder,
  getCachedBuyerOrders,
  fetchBuyerOrders,
  verifyOrderOnChain,
  BuyerOrder,
} from "../../lib/buyer-orders";
import * as stellarOrders from "../../lib/stellar/orders";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  from: vi.fn(),
  insert: vi.fn(),
  eq: vi.fn(),
}));

vi.mock("../../lib/supabase", () => ({
  supabase: {
    auth: {
      getSession: mocks.getSession,
    },
    from: mocks.from,
  },
}));

describe("Buyer Orders Management", () => {
  const sampleOrder: BuyerOrder = {
    id: "ord-1",
    orderId: "SS-101",
    userEmail: "buyer@example.com",
    userId: "user-123",
    total: 89.99,
    status: "Paid",
    paymentMethod: "stellar",
    tokenSymbol: "XLM",
    tokenAmount: 750,
    txHash: "mock-stellar-tx-hash",
    createdAt: "2026-09-05T08:00:00.000Z",
    items: [{ name: "Running Shoes", price: 89.99, quantity: 1 }],
  };

  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();

    mocks.getSession.mockResolvedValue({
      data: {
        session: {
          user: {
            id: "user-123",
            email: "buyer@example.com",
          },
        },
      },
      error: null,
    });
    mocks.insert.mockResolvedValue({ data: null, error: null });
    mocks.eq.mockResolvedValue({
      data: [
        {
          id: "db-1",
          order_id: "SS-DB-1",
          user_id: "user-123",
          user_email: "buyer@example.com",
          total: 120,
          status: "Paid",
          payment_method: "stellar",
          token_symbol: "USDC",
          tx_hash: "abcd1234efgh5678",
          created_at: "2026-09-05T08:00:00.000Z",
          items: [{ name: "Nike Air Max", price: 120, quantity: 1 }],
        },
      ],
      error: null,
    });
    mocks.from.mockImplementation(() => {
      const query = {
        insert: mocks.insert,
        select: vi.fn(() => query),
        order: vi.fn(() => query),
        eq: mocks.eq,
      };
      return query;
    });
  });

  it("saves an order and caches it in localStorage", async () => {
    const saved = await saveBuyerOrder(sampleOrder);
    expect(saved.orderId).toBe("SS-101");

    const cached = getCachedBuyerOrders();
    expect(cached.length).toBe(1);
    expect(cached[0].orderId).toBe("SS-101");
    expect(cached[0].tokenSymbol).toBe("XLM");
    expect(cached[0].userId).toBe("user-123");
  });

  it("updates an existing order when same orderId is saved again", async () => {
    await saveBuyerOrder(sampleOrder);
    const updated: BuyerOrder = { ...sampleOrder, status: "Shipped" };
    await saveBuyerOrder(updated);

    const cached = getCachedBuyerOrders();
    expect(cached.length).toBe(1);
    expect(cached[0].status).toBe("Shipped");
  });

  it("uses session ownership for remote persistence and lets Postgres generate the row UUID", async () => {
    await saveBuyerOrder({
      ...sampleOrder,
      id: "not-a-uuid",
      userId: "victim-user-id",
      userEmail: "victim@example.com",
    });

    expect(mocks.insert).toHaveBeenCalledTimes(1);
    const [rows] = mocks.insert.mock.calls[0];
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toHaveProperty("id");
    expect(rows[0].user_id).toBe("user-123");
    expect(rows[0].user_email).toBe("buyer@example.com");
  });

  it("keeps guest orders device-local and strips unverified owner claims", async () => {
    mocks.getSession.mockResolvedValueOnce({
      data: { session: null },
      error: null,
    });

    const saved = await saveBuyerOrder({
      ...sampleOrder,
      userId: "victim-user-id",
      userEmail: "victim@example.com",
    });

    expect(mocks.insert).not.toHaveBeenCalled();
    expect(saved.userId).toBeUndefined();
    expect(saved.userEmail).toBeUndefined();
    expect(getCachedBuyerOrders()[0].userId).toBeUndefined();
  });

  it("fetches orders from Supabase when available", async () => {
    const orders = await fetchBuyerOrders("user-123");
    expect(orders.length).toBe(1);
    expect(orders[0].orderId).toBe("SS-DB-1");
    expect(orders[0].total).toBe(120);
  });

  it("falls back to only the signed-in user's explicitly owned cache rows", async () => {
    mocks.eq.mockResolvedValueOnce({ data: [], error: null });
    localStorage.setItem(
      "mova_buyer_orders",
      JSON.stringify([
        { ...sampleOrder, id: "guest", orderId: "SS-GUEST", userId: undefined, userEmail: undefined },
        { ...sampleOrder, id: "alice", orderId: "SS-ALICE", userId: "alice-id", userEmail: "alice@example.com" },
        { ...sampleOrder, id: "bob", orderId: "SS-BOB", userId: "bob-id", userEmail: "bob@example.com" },
      ])
    );

    const orders = await fetchBuyerOrders("alice-id");
    expect(orders.map((order) => order.orderId)).toEqual(["SS-ALICE"]);
  });

  it("shows logged-out guests only device-local guest rows", async () => {
    localStorage.setItem(
      "mova_buyer_orders",
      JSON.stringify([
        { ...sampleOrder, id: "guest", orderId: "SS-GUEST", userId: undefined, userEmail: undefined },
        { ...sampleOrder, id: "alice", orderId: "SS-ALICE", userId: "alice-id", userEmail: "alice@example.com" },
      ])
    );

    const orders = await fetchBuyerOrders(undefined);
    expect(orders.map((order) => order.orderId)).toEqual(["SS-GUEST"]);
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("treats Supabase query errors as cache fallback instead of successful empty data", async () => {
    mocks.eq.mockResolvedValueOnce({
      data: null,
      error: { message: "offline" },
    });
    localStorage.setItem(
      "mova_buyer_orders",
      JSON.stringify([{ ...sampleOrder, userId: "user-123" }])
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const orders = await fetchBuyerOrders("user-123");

    expect(orders).toHaveLength(1);
    expect(orders[0].orderId).toBe("SS-101");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("verifies order on-chain via readOrder", async () => {
    vi.spyOn(stellarOrders, "readOrder").mockResolvedValueOnce({
      orderId: "SS-101",
      orderIdHash: "010203",
      buyer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
      amount: BigInt(899900000),
      amountDisplay: "89.99",
      token: "C...",
      tokenSymbol: "USDC",
      timestamp: 1725523200,
      status: "Paid",
    });

    const verification = await verifyOrderOnChain("SS-101");
    expect(verification.verified).toBe(true);
    expect(verification.onChainStatus).toBe("Paid");
  });

  it("returns verified false when on-chain order is not found or Unknown", async () => {
    vi.spyOn(stellarOrders, "readOrder").mockResolvedValueOnce(null);
    const verification = await verifyOrderOnChain("UNKNOWN-1");
    expect(verification.verified).toBe(false);
  });
});
