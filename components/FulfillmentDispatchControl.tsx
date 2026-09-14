"use client";

import React, { useEffect, useState } from "react";
import { MdLocalShipping } from "react-icons/md";

import { FulfillmentTrackingInput } from "../lib/fulfillment-tracking";
import { dispatchOrder, readOrder } from "../lib/stellar/orders";
import {
  fetchAdminFulfillmentReceipt,
  finalizeFulfillmentReceipt,
  prepareFulfillmentReceipt,
} from "../lib/fulfillment-tracking-store";

function toLocalInput(iso?: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "";
  const localMs = date.getTime() - date.getTimezoneOffset() * 60_000;
  return new Date(localMs).toISOString().slice(0, 16);
}

function fromLocalInput(value: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Shipment time is invalid");
  return date.toISOString();
}

interface Props {
  orderId: string;
  orderStatus: "Paid" | "Shipped";
  disabled: boolean;
}

export default function FulfillmentDispatchControl({ orderId, orderStatus, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [loadingExisting, setLoadingExisting] = useState(false);
  const [existingState, setExistingState] = useState<"PREPARED" | "DISPATCHED" | null>(null);
  const [carrierCode, setCarrierCode] = useState("");
  const [carrierName, setCarrierName] = useState("");
  const [trackingNumber, setTrackingNumber] = useState("");
  const [trackingUrl, setTrackingUrl] = useState("");
  const [shippedAt, setShippedAt] = useState("");
  const [expectedDeliveryAt, setExpectedDeliveryAt] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoadingExisting(true);
    setError("");
    fetchAdminFulfillmentReceipt(orderId)
      .then((receipt) => {
        if (!active) return;
        if (receipt) {
          const record = receipt.packet.record;
          setExistingState(receipt.dispatchState);
          setCarrierCode(record.carrierCode);
          setCarrierName(record.carrierName);
          setTrackingNumber(record.trackingNumber);
          setTrackingUrl(record.trackingUrl || "");
          setShippedAt(toLocalInput(record.shippedAt));
          setExpectedDeliveryAt(toLocalInput(record.expectedDeliveryAt));
        } else {
          setExistingState(null);
          setShippedAt((current) => current || toLocalInput(new Date().toISOString()));
        }
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : "Could not load fulfillment evidence");
      })
      .finally(() => {
        if (active) setLoadingExisting(false);
      });
    return () => {
      active = false;
    };
  }, [open, orderId]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError("");
    try {
      const shippedAtIso = fromLocalInput(shippedAt);
      if (!shippedAtIso) throw new Error("Shipped-at time is required");
      const input: FulfillmentTrackingInput = {
        orderId,
        carrierCode,
        carrierName,
        trackingNumber,
        shippedAt: shippedAtIso,
        expectedDeliveryAt: fromLocalInput(expectedDeliveryAt),
        trackingUrl: trackingUrl.trim() || undefined,
      };
      setSubmitting(true);
      setSuccess("");

      const prepared = await prepareFulfillmentReceipt(input, new Date().toISOString());
      const current = await readOrder(orderId);
      if (!current) {
        throw new Error("Could not verify the current on-chain order state; no dispatch was attempted");
      }

      if (prepared.dispatchState === "DISPATCHED") {
        if (current.status !== "Shipped") {
          throw new Error("Receipt says dispatched but current on-chain order is not Shipped");
        }
        setExistingState("DISPATCHED");
        setSuccess("Fulfillment receipt is already finalized.");
        return;
      }

      if (current.status === "Shipped") {
        await finalizeFulfillmentReceipt(orderId, prepared.recordSha256, {
          observedStatus: "Shipped",
          observedAt: new Date().toISOString(),
          txHash: current.txHash,
          ledger: current.ledger,
        });
        setExistingState("DISPATCHED");
        setSuccess("Existing Shipped order was bound to the immutable tracking receipt.");
        window.location.reload();
        return;
      }

      if (current.status !== "Paid") {
        throw new Error(`Order is ${current.status}; only Paid or already-Shipped orders can use fulfillment tracking`);
      }

      const dispatched = await dispatchOrder(orderId);
      if (!dispatched.success) {
        throw new Error(dispatched.error || "On-chain dispatch failed; tracking receipt remains PREPARED");
      }

      const observed = await readOrder(orderId);
      if (!observed || observed.status !== "Shipped") {
        setExistingState("PREPARED");
        setError(
          "Dispatch succeeded on-chain, but Shipped state could not yet be re-read. Do not dispatch again; reopen Tracking and retry the identical receipt to finalize it."
        );
        window.location.reload();
        return;
      }

      await finalizeFulfillmentReceipt(orderId, prepared.recordSha256, {
        observedStatus: "Shipped",
        observedAt: new Date().toISOString(),
        txHash: dispatched.txHash,
        ledger: dispatched.ledger,
      });
      setExistingState("DISPATCHED");
      setSuccess("Order dispatched and tracking receipt finalized.");
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not record fulfillment evidence");
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={disabled}
        className="flex items-center gap-1 rounded bg-green-600 px-3 py-1 text-sm text-white hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <MdLocalShipping /> {orderStatus === "Paid" ? "Track & Ship" : "Tracking"}
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="w-72 space-y-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-left">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-emerald-900">
          {orderStatus === "Paid" ? "Record tracking before dispatch" : "Record/finalize tracking"}
        </span>
        <button type="button" onClick={() => setOpen(false)} className="text-xs text-gray-500 underline">
          close
        </button>
      </div>
      {loadingExisting ? (
        <p className="text-xs text-gray-500">Checking existing receipt…</p>
      ) : (
        <>
          {existingState && (
            <p className="rounded bg-white/80 px-2 py-1 text-[11px] text-emerald-900">
              Existing immutable receipt: <strong>{existingState}</strong>. Exact replay is safe; conflicting tracking data is refused.
            </p>
          )}
          <div className="grid grid-cols-2 gap-2">
            <input required maxLength={24} value={carrierCode} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCarrierCode(e.target.value)} placeholder="Carrier code (UPS)" className="rounded border px-2 py-1 text-xs" />
            <input required maxLength={96} value={carrierName} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCarrierName(e.target.value)} placeholder="Carrier name" className="rounded border px-2 py-1 text-xs" />
          </div>
          <input required maxLength={96} value={trackingNumber} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTrackingNumber(e.target.value)} placeholder="Tracking number" className="w-full rounded border px-2 py-1 text-xs" />
          <input type="url" maxLength={2048} value={trackingUrl} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTrackingUrl(e.target.value)} placeholder="https:// carrier tracking URL (optional)" className="w-full rounded border px-2 py-1 text-xs" />
          <label className="block text-[11px] text-gray-600">
            Shipped at
            <input required type="datetime-local" value={shippedAt} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setShippedAt(e.target.value)} className="mt-0.5 w-full rounded border px-2 py-1 text-xs" />
          </label>
          <label className="block text-[11px] text-gray-600">
            Expected delivery (optional)
            <input type="datetime-local" value={expectedDeliveryAt} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setExpectedDeliveryAt(e.target.value)} className="mt-0.5 w-full rounded border px-2 py-1 text-xs" />
          </label>
          <p className="text-[10px] leading-4 text-gray-600">
            This records merchant-provided shipment evidence. It does not verify carrier delivery. For Paid orders, escrow dispatch occurs only after the immutable receipt is prepared.
          </p>
          {error && <p role="alert" className="text-[11px] text-rose-700">{error}</p>}
          {success && <p role="status" className="text-[11px] text-emerald-800">{success}</p>}
          <button type="submit" disabled={disabled || submitting || existingState === "DISPATCHED"} className="w-full rounded bg-emerald-700 px-2 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
            {existingState === "DISPATCHED"
              ? "Receipt already finalized"
              : submitting
                ? "Checking chain / dispatching…"
                : orderStatus === "Paid"
                ? "Prepare receipt and dispatch"
                : "Finalize shipment receipt"}
          </button>
        </>
      )}
    </form>
  );
}
