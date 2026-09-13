import { useEffect, useRef, useState } from "react";

import { PaymentEventIndexer } from "../lib/stellar/indexer";
import { bytesToHex, hashOrderId } from "../lib/stellar/scval";

/**
 * Live on-chain order monitor.
 *
 * Starts a `getEvents`-based indexer for the checkout contract and watches for
 * the exact `pay` event matching order id, token and raw amount. An order-id
 * collision or partial/wrong-token payment is never sufficient to complete a
 * checkout; the watcher keeps listening for the exact receipt.
 */
const StellarOrderWatch = ({
  orderId,
  expectedAmountRaw,
  expectedTokenContractId,
  enabled = true,
  onEvent = null,
}) => {
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState("");
  const [matched, setMatched] = useState(null);
  const indexerRef = useRef(null);

  useEffect(() => {
    if (!enabled || !orderId) return undefined;

    let expectedAmount;
    try {
      expectedAmount = BigInt(String(expectedAmountRaw));
    } catch {
      setError("Payment monitor cannot verify the expected amount.");
      return undefined;
    }

    if (expectedAmount <= 0n || !expectedTokenContractId) {
      setError("Payment monitor is missing an exact token or amount expectation.");
      return undefined;
    }

    let cancelled = false;
    let indexer = null;

    const start = async () => {
      const bytes = await hashOrderId(orderId);
      if (cancelled) return;
      const expectedOrder = bytesToHex(bytes).toLowerCase();

      indexer = new PaymentEventIndexer();
      indexerRef.current = indexer;

      indexer.start({
        onStatus: (s) => {
          setConnected(s.running);
          if (s.lastError) {
            setError(s.lastError);
          } else if (s.running) {
            setError("");
          }
        },
        onError: (err) => setError(err.message),
        onEvent: (event) => {
          if (event.symbol !== "pay") return;

          const orderHex = (event.fields.topic4 || "").toLowerCase();
          if (orderHex !== expectedOrder) return;

          if (event.fields.topic1 !== expectedTokenContractId) {
            setError("Ignored a payment for this order because the token did not match USDC.");
            return;
          }

          let actualAmount;
          try {
            actualAmount = BigInt(event.fields.amount || "");
          } catch {
            setError("Ignored a payment for this order because its amount could not be verified.");
            return;
          }

          if (actualAmount !== expectedAmount) {
            setError("Ignored a payment for this order because the amount did not match the cart total.");
            return;
          }

          setError("");
          setMatched(event);
          if (onEvent) onEvent(event);
          indexer.stop();
        },
      });
    };

    void start();

    return () => {
      cancelled = true;
      if (indexer) indexer.stop();
      indexerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, orderId, expectedAmountRaw, expectedTokenContractId]);

  return (
    <div className="w-full text-xs bg-white/70 border border-purple-600/30 rounded-md p-3">
      <div className="flex items-center gap-2 font-semibold text-purple-600">
        <span
          className={`w-2 h-2 rounded-full ${
            matched ? "bg-green-500" : connected ? "bg-purple-600 animate-pulse" : "bg-gray-400"
          }`}
        />
        Stellar order monitor
      </div>

      {matched ? (
        <div className="mt-2 text-green-700 bg-green-50 border border-green-200 rounded p-2">
          <span className="font-semibold">Payment detected on-chain ✓</span>
          <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5">
            <span>Ledger</span>
            <span className="text-right font-mono">{matched.ledger}</span>
            <span>Amount</span>
            <span className="text-right font-mono">{matched.fields.amount ?? "—"}</span>
            <span>Token</span>
            <span className="text-right font-mono truncate">{matched.fields.topic1 ?? "—"}</span>
            <span>Tx</span>
            <span className="text-right font-mono truncate">{matched.txHash}</span>
          </div>
        </div>
      ) : (
        <div className="mt-2 flex items-center gap-2 text-gray-600">
          {connected ? (
            <>
              <span className="w-3 h-3 border-2 border-purple-600 border-t-transparent rounded-full animate-spin" />
              Listening for the exact USDC payment for order {orderId}…
            </>
          ) : (
            "Starting…"
          )}
        </div>
      )}

      {error && <div className="mt-2 text-amber-700">{error}</div>}
    </div>
  );
};

export default StellarOrderWatch;
