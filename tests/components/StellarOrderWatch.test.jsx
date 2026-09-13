import { render, screen, act } from "@testing-library/react";
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import StellarOrderWatch from "../../components/StellarOrderWatch";
import { bytesToHex, hashOrderId } from "../../lib/stellar/scval";

let lastIndexerCallbacks = null;
const mockStart = vi.fn((callbacks) => {
  lastIndexerCallbacks = callbacks;
});
const mockStop = vi.fn();

vi.mock("../../lib/stellar/indexer", () => {
  return {
    PaymentEventIndexer: vi.fn().mockImplementation(function () {
      return {
        start: mockStart,
        stop: mockStop,
      };
    }),
  };
});

const paymentExpectation = {
  expectedAmountRaw: "500000000",
  expectedTokenContractId: "CA7TOKENADDRESS",
};

describe("StellarOrderWatch Component", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lastIndexerCallbacks = null;
  });

  it("renders starting state on mount when exact payment expectations are provided", async () => {
    render(<StellarOrderWatch orderId="ord-123" {...paymentExpectation} />);

    expect(screen.getByText("Stellar order monitor")).toBeInTheDocument();
    expect(screen.getByText("Starting…")).toBeInTheDocument();
  });

  it("does not start indexer when disabled or orderId is empty", () => {
    const { rerender } = render(<StellarOrderWatch orderId="" {...paymentExpectation} />);
    expect(mockStart).not.toHaveBeenCalled();

    rerender(<StellarOrderWatch orderId="ord-123" enabled={false} {...paymentExpectation} />);
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("fails closed when exact token or amount expectations are unavailable", async () => {
    render(<StellarOrderWatch orderId="ord-123" />);

    expect(
      screen.getByText(/missing an exact token or amount expectation|cannot verify the expected amount/i)
    ).toBeInTheDocument();
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("updates UI on indexer status change and error callback", async () => {
    render(<StellarOrderWatch orderId="order-abc-456" {...paymentExpectation} />);

    await vi.waitFor(() => {
      expect(mockStart).toHaveBeenCalled();
    });

    act(() => {
      lastIndexerCallbacks.onStatus({ running: true });
    });

    expect(
      screen.getByText(/Listening for the exact USDC payment for order order-abc-456…/i)
    ).toBeInTheDocument();

    act(() => {
      lastIndexerCallbacks.onError(new Error("RPC network failure"));
    });

    expect(screen.getByText("RPC network failure")).toBeInTheDocument();
  });

  it("ignores non-pay events and events for other order IDs", async () => {
    const onEvent = vi.fn();
    render(<StellarOrderWatch orderId="my-order-99" onEvent={onEvent} {...paymentExpectation} />);

    await vi.waitFor(() => {
      expect(mockStart).toHaveBeenCalled();
    });

    act(() => {
      lastIndexerCallbacks.onEvent({
        symbol: "create_order",
        fields: { topic4: "some-hex" },
      });
    });

    expect(onEvent).not.toHaveBeenCalled();
    expect(mockStop).not.toHaveBeenCalled();
    expect(screen.queryByText(/Payment detected on-chain/i)).not.toBeInTheDocument();

    act(() => {
      lastIndexerCallbacks.onEvent({
        symbol: "pay",
        fields: {
          topic1: paymentExpectation.expectedTokenContractId,
          topic4: "deadbeef00000000000000000000000000000000000000000000000000000000",
          amount: paymentExpectation.expectedAmountRaw,
        },
      });
    });

    expect(onEvent).not.toHaveBeenCalled();
    expect(mockStop).not.toHaveBeenCalled();
    expect(screen.queryByText(/Payment detected on-chain/i)).not.toBeInTheDocument();
  });

  it("keeps listening through wrong-token and underpayment events, then accepts the exact receipt", async () => {
    const orderId = "order-match-777";
    const onEvent = vi.fn();
    render(<StellarOrderWatch orderId={orderId} onEvent={onEvent} {...paymentExpectation} />);

    await vi.waitFor(() => {
      expect(mockStart).toHaveBeenCalled();
    });

    const expectedHashBytes = await hashOrderId(orderId);
    const expectedHex = bytesToHex(expectedHashBytes).toLowerCase();

    act(() => {
      lastIndexerCallbacks.onEvent({
        symbol: "pay",
        fields: {
          topic1: "CWRONGTOKEN",
          topic4: expectedHex,
          amount: paymentExpectation.expectedAmountRaw,
        },
      });
    });

    expect(onEvent).not.toHaveBeenCalled();
    expect(mockStop).not.toHaveBeenCalled();
    expect(screen.getByText(/token did not match USDC/i)).toBeInTheDocument();

    act(() => {
      lastIndexerCallbacks.onEvent({
        symbol: "pay",
        fields: {
          topic1: paymentExpectation.expectedTokenContractId,
          topic4: expectedHex,
          amount: "499999999",
        },
      });
    });

    expect(onEvent).not.toHaveBeenCalled();
    expect(mockStop).not.toHaveBeenCalled();
    expect(screen.getByText(/amount did not match the cart total/i)).toBeInTheDocument();

    const matchingEvent = {
      id: "ev-1",
      ledger: 1234567,
      ledgerClosedAt: "2026-09-04T12:00:00Z",
      txHash: "0xabc123txhash456789",
      symbol: "pay",
      topics: [],
      fields: {
        topic1: paymentExpectation.expectedTokenContractId,
        topic4: expectedHex,
        amount: paymentExpectation.expectedAmountRaw,
      },
    };

    act(() => {
      lastIndexerCallbacks.onEvent(matchingEvent);
    });

    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith(matchingEvent);
    expect(mockStop).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Payment detected on-chain ✓")).toBeInTheDocument();
    expect(screen.getByText("1234567")).toBeInTheDocument();
    expect(screen.getByText(paymentExpectation.expectedAmountRaw)).toBeInTheDocument();
    expect(screen.getByText(paymentExpectation.expectedTokenContractId)).toBeInTheDocument();
    expect(screen.getByText("0xabc123txhash456789")).toBeInTheDocument();
  });
});
