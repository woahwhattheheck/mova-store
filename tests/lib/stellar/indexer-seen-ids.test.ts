import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { INDEXER_SEEN_ID_LIMIT, PaymentEventIndexer } from "../../../lib/stellar/indexer";

vi.mock("../../../lib/stellar/config", () => ({
  CHECKOUT_CONTRACT_ID: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  EVENT_POLL_INTERVAL_MS: 50,
  EVENT_START_LEDGER_BACKFILL: 100,
  RPC_URL: "https://rpc.example.invalid",
}));

// These tests exercise polling/cache lifetime, not XDR decoding or the RPC SDK.
vi.mock("@stellar/stellar-sdk", () => ({
  rpc: { Server: class {} },
  StrKey: { isValidContract: () => true },
  xdr: { ScVal: { scvSymbol: () => ({ toXDR: () => "" }) } },
}));
vi.mock("../../../lib/stellar/scval", () => ({ scValToString: () => "" }));

function event(id: string) {
  return {
    id,
    ledger: 1000,
    ledgerClosedAt: "2026-10-01T00:00:00Z",
    txHash: id,
    inSuccessfulContractCall: true,
    topic: [{ type: "scvSymbol", sym: "pay" }],
    value: { type: "scvMap", map: [] },
  };
}

function page(ids: string[], cursor = "next") {
  return { latestLedger: 1000, cursor, events: ids.map(event) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("PaymentEventIndexer bounded recent IDs (#523)", () => {
  let indexer: PaymentEventIndexer;
  let server: { getLatestLedger: ReturnType<typeof vi.fn>; getEvents: ReturnType<typeof vi.fn> };
  let seenIds: Set<string>;

  beforeEach(() => {
    vi.useFakeTimers();
    indexer = new PaymentEventIndexer({ pollMs: 50 });
    server = {
      getLatestLedger: vi.fn().mockResolvedValue({ sequence: 1000 }),
      getEvents: vi.fn().mockResolvedValue(page([])),
    };
    const internals = indexer as unknown as { server: unknown; seenIds: Set<string> };
    internals.server = server;
    seenIds = internals.seenIds;
  });

  afterEach(() => {
    indexer.stop();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("bounds a long scan and still suppresses overlapping recent events", async () => {
    let count = 0;
    indexer.start({ onEvent: () => count++ });
    await vi.advanceTimersByTimeAsync(0);
    const total = INDEXER_SEEN_ID_LIMIT * 3;
    for (let first = 0; first < total; first += 1000) {
      const ids = Array.from({ length: 1000 }, (_, offset) => `event-${first + offset}`);
      server.getEvents.mockResolvedValueOnce(page(ids, `page-${first}`));
      await vi.advanceTimersByTimeAsync(50);
      expect(seenIds.size).toBeLessThanOrEqual(INDEXER_SEEN_ID_LIMIT);
    }
    expect(count).toBe(total);
    expect(seenIds.size).toBe(INDEXER_SEEN_ID_LIMIT);
    expect(seenIds.has("event-0")).toBe(false);
    expect(seenIds.has(`event-${total - INDEXER_SEEN_ID_LIMIT}`)).toBe(true);

    server.getEvents.mockResolvedValueOnce(page([`event-${total - 1}`, "new", "new"]));
    await vi.advanceTimersByTimeAsync(50);
    expect(count).toBe(total + 1);
    expect(seenIds.size).toBe(INDEXER_SEEN_ID_LIMIT);
  });

  it("clears IDs on stop without discarding the resume cursor or lifetime count", async () => {
    server.getEvents.mockResolvedValueOnce(page(["first"], "saved-cursor"));
    indexer.start({ onEvent: () => {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(seenIds.size).toBe(1);
    indexer.stop();
    expect(seenIds.size).toBe(0);
    expect(indexer.status.lastCursor).toBe("saved-cursor");
    expect(indexer.status.eventsSeen).toBe(1);
  });

  it("does not refill the cache from a pending response after stop and immediate restart", async () => {
    const pending = deferred<ReturnType<typeof page>>();
    const oldConsumer = vi.fn();
    const newConsumer = vi.fn();
    server.getEvents.mockReturnValueOnce(pending.promise);
    indexer.start({ onEvent: oldConsumer });
    await vi.advanceTimersByTimeAsync(0);
    indexer.stop();
    indexer.start({ onEvent: newConsumer });
    pending.resolve(page(["late"], "late-cursor"));
    await vi.advanceTimersByTimeAsync(0);
    expect(seenIds.size).toBe(0);
    expect(oldConsumer).not.toHaveBeenCalled();
    expect(newConsumer).not.toHaveBeenCalled();
    expect(indexer.status.lastCursor).toBeUndefined();

    server.getEvents.mockResolvedValueOnce(page(["fresh"], "fresh-cursor"));
    await vi.advanceTimersByTimeAsync(50);
    expect(newConsumer).toHaveBeenCalledTimes(1);
    expect(seenIds.has("fresh")).toBe(true);
  });

  it("keeps an interrupted page replayable when a consumer calls stop", async () => {
    server.getEvents.mockResolvedValueOnce(page(["first", "second"], "page-end"));
    const stoppingConsumer = vi.fn(() => indexer.stop());
    indexer.start({ onEvent: stoppingConsumer });
    await vi.advanceTimersByTimeAsync(0);
    expect(stoppingConsumer).toHaveBeenCalledTimes(1);
    expect(seenIds.size).toBe(0);
    expect(indexer.status.lastCursor).toBeUndefined();
    expect(indexer.scanPosition.startLedger).toBe(900);

    server.getEvents.mockResolvedValueOnce(page(["first", "second"], "page-end"));
    const resumed = vi.fn();
    indexer.start({ onEvent: resumed });
    await vi.advanceTimersByTimeAsync(0);
    expect(resumed).toHaveBeenCalledTimes(2);
    expect(indexer.status.lastCursor).toBe("page-end");
  });

  it("ignores a stale RPC rejection after stop and immediate restart", async () => {
    const pending = deferred<ReturnType<typeof page>>();
    const onError = vi.fn();
    server.getEvents.mockReturnValueOnce(pending.promise);
    indexer.start({ onEvent: () => {}, onError });
    await vi.advanceTimersByTimeAsync(0);
    indexer.stop();
    indexer.start({ onEvent: () => {}, onError });
    pending.reject(new Error("old RPC failed"));
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).not.toHaveBeenCalled();
    expect(indexer.status.lastError).toBeUndefined();
    expect(seenIds.size).toBe(0);
  });
});
