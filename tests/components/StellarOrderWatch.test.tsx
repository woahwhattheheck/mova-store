import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import React from "react";
import StellarOrderWatch from "../../components/StellarOrderWatch";

vi.mock("../../lib/stellar/scval", () => ({
  hashOrderId: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3, 4])),
  bytesToHex: vi.fn().mockReturnValue("01020304"),
}));

let mockIndexerInstance: any = null;

vi.mock("../../lib/stellar/indexer", () => ({
  PaymentEventIndexer: vi.fn().mockImplementation(function () {
    mockIndexerInstance = { start: vi.fn(), stop: vi.fn() };
    return mockIndexerInstance;
  }),
}));

const paymentExpectation = {
  expectedAmountRaw: "10000000",
  expectedTokenContractId: "USDC",
  expectedBuyer: "GBUYER",
};

describe("StellarOrderWatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIndexerInstance = null;
  });

  it("clears the error banner when onStatus receives lastError=undefined while running", async () => {
    const { unmount } = render(
      <StellarOrderWatch orderId="test-order-123" enabled={true} {...paymentExpectation} />
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(mockIndexerInstance).not.toBeNull();
    expect(mockIndexerInstance.start).toHaveBeenCalled();
    const capturedCallbacks = mockIndexerInstance.start.mock.calls[0][0];

    act(() => capturedCallbacks.onStatus({ running: true, lastError: "Transient network timeout" }));
    expect(screen.getByText("Transient network timeout")).toBeInTheDocument();

    act(() => capturedCallbacks.onStatus({ running: true, lastError: undefined }));
    expect(screen.queryByText("Transient network timeout")).not.toBeInTheDocument();
    unmount();
  });

  it("clears error banner when exact buyer-bound matching payment event is received", async () => {
    render(<StellarOrderWatch orderId="test-order-123" enabled={true} {...paymentExpectation} />);

    await act(async () => {
      await Promise.resolve();
    });

    const capturedCallbacks = mockIndexerInstance.start.mock.calls[0][0];
    act(() => capturedCallbacks.onError(new Error("RPC hiccup")));
    expect(screen.getByText("RPC hiccup")).toBeInTheDocument();

    act(() => {
      capturedCallbacks.onEvent({
        symbol: "pay",
        ledger: 100,
        txHash: "tx123",
        fields: {
          topic4: "01020304",
          topic2: paymentExpectation.expectedBuyer,
          amount: paymentExpectation.expectedAmountRaw,
          topic1: paymentExpectation.expectedTokenContractId,
        },
      });
    });

    expect(screen.queryByText("RPC hiccup")).not.toBeInTheDocument();
    expect(screen.getByText("Payment detected on-chain ✓")).toBeInTheDocument();
  });

  it("does not accept another buyer's otherwise exact payment", async () => {
    const onEvent = vi.fn();
    render(
      <StellarOrderWatch
        orderId="test-order-123"
        enabled={true}
        onEvent={onEvent}
        {...paymentExpectation}
      />
    );

    await act(async () => {
      await Promise.resolve();
    });

    const capturedCallbacks = mockIndexerInstance.start.mock.calls[0][0];
    act(() => {
      capturedCallbacks.onEvent({
        symbol: "pay",
        ledger: 100,
        txHash: "tx123",
        fields: {
          topic4: "01020304",
          topic2: "GOTHER",
          amount: paymentExpectation.expectedAmountRaw,
          topic1: paymentExpectation.expectedTokenContractId,
        },
      });
    });

    expect(onEvent).not.toHaveBeenCalled();
    expect(screen.getByText(/buyer did not match this wallet/i)).toBeInTheDocument();
  });
});
