import { beforeEach, describe, expect, it, vi } from "vitest";

import { createPaidBuyerOrderSnapshot } from "../../lib/buyer-orders";
import { saveCheckoutPaidOrder } from "../../lib/checkout-paid-order";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  from: vi.fn(),
  insert: vi.fn(),
  select: vi.fn(),
  eq: vi.fn(),
  maybeSingle: vi.fn(),
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
  orderId: "SS-DURABLE-1",
  total: 125,
  tokenSymbol: "USDC",
  tokenAmount: 125,
  txHash: "abc123",
  ledger: 42,
  createdAt: "2026-09-13T16:00:00.000Z",
  items: [{ id: "product-1", name: "Jacket", price: 125, quantity: 1 }],
  fulfillment,
};

type RemoteInput = Omit<typeof baseInput, "txHash" | "ledger"> & {
  txHash?: string;
  ledger?: number;
};

function signedInSession() {
  return {
    data: {
      session: {
        user: { id: "user-123", email: "ada@example.com" },
      },
    },
    error: null,
  };
}

function exactRemoteRow(input: RemoteInput = baseInput) {
  return {
    order_id: input.orderId,
    user_id: "user-123",
    user_email: "ada@example.com",
    total: input.total,
    payment_method: "stellar",
    token_symbol: input.tokenSymbol,
    token_amount: input.tokenAmount,
    tx_hash: input.txHash ?? null,
    items: {
      schemaVersion: 1,
      lines: input.items,
      fulfillment: input.fulfillment,
      ledger: input.ledger,
    },
  };
}

describe("checkout paid-order durability boundary", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();

    mocks.getSession.mockResolvedValue(signedInSession());
    mocks.insert.mockResolvedValue({ data: null, error: null });
    mocks.maybeSingle.mockResolvedValue({ data: null, error: null });
    mocks.eq.mockReturnValue({ maybeSingle: mocks.maybeSingle });
    mocks.select.mockReturnValue({ eq: mocks.eq });
    mocks.from.mockImplementation(() => ({
      insert: mocks.insert,
      select: mocks.select,
    }));
  });

  it("requires the merchant-side Supabase row for a signed-in paid order", async () => {
    const local = createPaidBuyerOrderSnapshot(baseInput);
    localStorage.setItem("mova_buyer_orders", JSON.stringify([
      { ...local, userId: "user-123", userEmail: "ada@example.com" },
    ]));
    mocks.insert.mockResolvedValueOnce({
      data: null,
      error: { message: "database unavailable" },
    });

    await expect(saveCheckoutPaidOrder(baseInput)).rejects.toThrow(
      /merchant fulfillment/i
    );
    expect(mocks.insert).toHaveBeenCalledTimes(1);
    expect(mocks.maybeSingle).toHaveBeenCalledTimes(1);

    // A matching browser cache is recovery evidence only. It does not convert
    // a failed merchant-side write into checkout success.
    expect(JSON.parse(localStorage.getItem("mova_buyer_orders") || "[]")).toHaveLength(1);
  });

  it("retries remote persistence even when an identical local paid snapshot already exists", async () => {
    const local = createPaidBuyerOrderSnapshot(baseInput);
    localStorage.setItem("mova_buyer_orders", JSON.stringify([
      { ...local, userId: "user-123", userEmail: "ada@example.com" },
    ]));

    mocks.insert
      .mockResolvedValueOnce({ data: null, error: { message: "temporary outage" } })
      .mockResolvedValueOnce({ data: null, error: null });

    await expect(saveCheckoutPaidOrder(baseInput)).rejects.toThrow(/merchant fulfillment/i);
    await expect(saveCheckoutPaidOrder(baseInput)).resolves.toMatchObject({
      orderId: baseInput.orderId,
      userId: "user-123",
      status: "Paid",
    });
    expect(mocks.insert).toHaveBeenCalledTimes(2);
  });

  it("does not let a legacy local cache without receipt metadata block an exact merchant write", async () => {
    const { txHash: _txHash, ledger: _ledger, ...legacy } = createPaidBuyerOrderSnapshot(baseInput);
    localStorage.setItem("mova_buyer_orders", JSON.stringify([
      { ...legacy, userId: "user-123", userEmail: "ada@example.com" },
    ]));

    await expect(saveCheckoutPaidOrder(baseInput)).resolves.toMatchObject({
      orderId: baseInput.orderId,
      txHash: baseInput.txHash,
      ledger: baseInput.ledger,
    });
    expect(mocks.insert).toHaveBeenCalledTimes(1);
  });

  it("persists transaction hash and ledger evidence for duplicate reconciliation", async () => {
    await saveCheckoutPaidOrder(baseInput);

    expect(mocks.insert).toHaveBeenCalledWith([
      expect.objectContaining({
        order_id: baseInput.orderId,
        tx_hash: baseInput.txHash,
        items: expect.objectContaining({
          schemaVersion: 1,
          ledger: baseInput.ledger,
        }),
      }),
    ]);
  });

  it("resolves an ambiguous or duplicate insert only through an exact owner-visible row", async () => {
    mocks.insert.mockResolvedValueOnce({
      data: null,
      error: { message: "duplicate key value violates unique constraint" },
    });
    mocks.maybeSingle.mockResolvedValueOnce({ data: exactRemoteRow(), error: null });

    await expect(saveCheckoutPaidOrder(baseInput)).resolves.toMatchObject({
      orderId: baseInput.orderId,
      userId: "user-123",
    });
    expect(mocks.select).toHaveBeenCalledWith("*");
    expect(mocks.eq).toHaveBeenCalledWith("order_id", baseInput.orderId);
  });

  it("fails closed when the unique remote order id belongs to conflicting commerce", async () => {
    mocks.insert.mockResolvedValueOnce({
      data: null,
      error: { message: "duplicate key value violates unique constraint" },
    });
    mocks.maybeSingle.mockResolvedValueOnce({
      data: { ...exactRemoteRow(), total: 1, token_amount: 1 },
      error: null,
    });

    await expect(saveCheckoutPaidOrder(baseInput)).rejects.toThrow(
      /conflicting merchant commerce evidence/i
    );
  });

  it("fails closed when the remote row belongs to a different Stellar transaction", async () => {
    mocks.insert.mockResolvedValueOnce({
      data: null,
      error: { message: "duplicate key value violates unique constraint" },
    });
    mocks.maybeSingle.mockResolvedValueOnce({
      data: { ...exactRemoteRow(), tx_hash: "different-transaction" },
      error: null,
    });

    await expect(saveCheckoutPaidOrder(baseInput)).rejects.toThrow(
      /conflicting merchant commerce evidence/i
    );
  });

  it("fails closed when the candidate has a transaction hash but the remote row does not", async () => {
    mocks.insert.mockResolvedValueOnce({
      data: null,
      error: { message: "duplicate key value violates unique constraint" },
    });
    mocks.maybeSingle.mockResolvedValueOnce({
      data: { ...exactRemoteRow(), tx_hash: null },
      error: null,
    });

    await expect(saveCheckoutPaidOrder(baseInput)).rejects.toThrow(
      /conflicting merchant commerce evidence/i
    );
  });

  it("fails closed when confirmed ledger evidence is missing from the remote row", async () => {
    const remote = exactRemoteRow();
    mocks.insert.mockResolvedValueOnce({
      data: null,
      error: { message: "duplicate key value violates unique constraint" },
    });
    mocks.maybeSingle.mockResolvedValueOnce({
      data: { ...remote, items: { ...remote.items, ledger: null } },
      error: null,
    });

    await expect(saveCheckoutPaidOrder(baseInput)).rejects.toThrow(
      /conflicting merchant commerce evidence/i
    );
  });

  it("uses matching ledger evidence as the explicit fallback for a hashless confirmation", async () => {
    const hashlessInput: RemoteInput = {
      ...baseInput,
      orderId: "SS-HASHLESS-1",
      txHash: undefined,
      ledger: 77,
    };
    mocks.insert.mockResolvedValueOnce({
      data: null,
      error: { message: "duplicate key value violates unique constraint" },
    });
    mocks.maybeSingle.mockResolvedValueOnce({
      data: exactRemoteRow(hashlessInput),
      error: null,
    });

    await expect(saveCheckoutPaidOrder(hashlessInput)).resolves.toMatchObject({
      orderId: hashlessInput.orderId,
      ledger: 77,
      txHash: undefined,
    });
  });

  it("fails closed when a hashless confirmation resolves to a different ledger", async () => {
    const hashlessInput: RemoteInput = {
      ...baseInput,
      orderId: "SS-HASHLESS-2",
      txHash: undefined,
      ledger: 88,
    };
    const remote = exactRemoteRow(hashlessInput);
    mocks.insert.mockResolvedValueOnce({
      data: null,
      error: { message: "duplicate key value violates unique constraint" },
    });
    mocks.maybeSingle.mockResolvedValueOnce({
      data: { ...remote, items: { ...remote.items, ledger: 89 } },
      error: null,
    });

    await expect(saveCheckoutPaidOrder(hashlessInput)).rejects.toThrow(
      /conflicting merchant commerce evidence/i
    );
  });

  it("fails closed on duplicate resolution when the callback has no payment identity", async () => {
    const identitylessInput: RemoteInput = {
      ...baseInput,
      orderId: "SS-NO-IDENTITY-1",
      txHash: undefined,
      ledger: undefined,
    };
    mocks.insert.mockResolvedValueOnce({
      data: null,
      error: { message: "duplicate key value violates unique constraint" },
    });
    mocks.maybeSingle.mockResolvedValueOnce({
      data: exactRemoteRow(identitylessInput),
      error: null,
    });

    await expect(saveCheckoutPaidOrder(identitylessInput)).rejects.toThrow(
      /conflicting merchant commerce evidence/i
    );
  });

  it("preserves explicit guest device-local semantics", async () => {
    mocks.getSession.mockResolvedValue({ data: { session: null }, error: null });

    const saved = await saveCheckoutPaidOrder({ ...baseInput, orderId: "SS-GUEST-1" });
    expect(saved.orderId).toBe("SS-GUEST-1");
    expect(mocks.from).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem("mova_buyer_orders") || "[]")).toHaveLength(1);
  });
});
