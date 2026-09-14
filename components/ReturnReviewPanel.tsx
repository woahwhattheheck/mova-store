"use client";

import React, { useMemo, useState } from "react";
import { MdAssignmentReturn, MdContentCopy, MdExpandLess, MdExpandMore } from "react-icons/md";

import { BuyerOrder, verifyOrderOnChain } from "../lib/buyer-orders";
import {
  ReturnReason,
  ReturnReviewPacket,
  compileReturnReview,
} from "../lib/return-review";

interface ReturnReviewPanelProps {
  order: BuyerOrder;
}

const REASONS: Array<{ value: ReturnReason; label: string }> = [
  { value: "DEFECTIVE", label: "Defective or damaged" },
  { value: "WRONG_ITEM", label: "Wrong item received" },
  { value: "SIZE_FIT", label: "Size or fit" },
  { value: "CHANGED_MIND", label: "Changed mind" },
  { value: "OTHER", label: "Other" },
];

export default function ReturnReviewPanel({ order }: ReturnReviewPanelProps) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<ReturnReason>("SIZE_FIT");
  const [details, setDetails] = useState("");
  const [quantities, setQuantities] = useState<Record<number, number>>({});
  const [building, setBuilding] = useState(false);
  const [packet, setPacket] = useState<ReturnReviewPacket | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const selectedCount = useMemo(
    () => Object.values(quantities).reduce((sum, quantity) => sum + (quantity > 0 ? quantity : 0), 0),
    [quantities]
  );

  const setLineQuantity = (lineIndex: number, raw: string) => {
    const quantity = raw === "" ? 0 : Number(raw);
    setQuantities((current) => ({ ...current, [lineIndex]: quantity }));
    setPacket(null);
    setError("");
  };

  const buildPacket = async () => {
    setBuilding(true);
    setError("");
    setPacket(null);
    setCopied(false);

    try {
      const selections = order.items
        .map((_, lineIndex) => ({ lineIndex, quantity: quantities[lineIndex] || 0 }))
        .filter((selection) => selection.quantity > 0);

      if (selections.length === 0) {
        throw new Error("Choose at least one item quantity for review.");
      }

      const requestedAt = new Date().toISOString();
      let verification = {
        checkedAt: requestedAt,
        verified: false,
        onChainStatus: undefined as string | undefined,
      };

      if (order.paymentMethod === "stellar") {
        const observed = await verifyOrderOnChain(order.orderId);
        verification = {
          checkedAt: new Date().toISOString(),
          verified: observed.verified,
          onChainStatus: observed.onChainStatus,
        };
      }

      const compiled = await compileReturnReview({
        order: {
          orderId: order.orderId,
          paymentMethod: order.paymentMethod,
          status: order.status,
          createdAt: order.createdAt,
          items: order.items.map((item) => ({
            id: item.id,
            name: item.name,
            price: Number(item.price),
            quantity: item.quantity,
          })),
        },
        request: {
          requestedAt,
          reason,
          details,
          selections,
        },
        verification,
        evaluatedAt: new Date().toISOString(),
      });

      setPacket(compiled);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not build the return review packet.");
    } finally {
      setBuilding(false);
    }
  };

  const copyPacket = async () => {
    if (!packet) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(packet, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Could not copy the review packet from this browser.");
    }
  };

  if (!order.items || order.items.length === 0) {
    return (
      <div className="border-t border-amber-100 bg-amber-50/70 px-4 py-3 text-xs text-amber-900 sm:px-5">
        Return review is unavailable because this order has no recorded line-item snapshot. Contact the merchant with the order ID instead.
      </div>
    );
  }

  return (
    <div className="border-t border-purple-100 bg-white px-4 py-4 sm:px-5">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="flex w-full items-center justify-between gap-3 text-left"
        aria-expanded={open}
      >
        <span className="flex items-center gap-2 text-sm font-semibold text-purple-800">
          <MdAssignmentReturn size={18} />
          Build a return review packet
        </span>
        {open ? <MdExpandLess size={20} /> : <MdExpandMore size={20} />}
      </button>

      {open && (
        <div className="mt-4 space-y-4">
          <p className="text-xs leading-5 text-gray-600">
            This prepares evidence for merchant review only. It does not submit a return, authorize a refund or exchange, reserve replacement inventory, sign a wallet transaction, or contact the merchant.
          </p>

          <fieldset className="space-y-2">
            <legend className="text-xs font-semibold uppercase tracking-wide text-gray-500">
              Items to review
            </legend>
            {order.items.map((item, lineIndex) => {
              const purchased = Number.isSafeInteger(item.quantity) && Number(item.quantity) > 0
                ? Number(item.quantity)
                : 1;
              return (
                <label
                  key={`${item.id ?? item.name}-${lineIndex}`}
                  className="flex items-center justify-between gap-3 rounded-lg border border-purple-100 bg-purple-50/40 px-3 py-2"
                >
                  <span className="min-w-0 text-sm text-gray-800">
                    <span className="font-medium">{item.name}</span>
                    <span className="ml-2 text-xs text-gray-500">ordered {purchased}</span>
                  </span>
                  <input
                    type="number"
                    min={0}
                    max={purchased}
                    step={1}
                    value={quantities[lineIndex] ?? 0}
                    onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                      setLineQuantity(lineIndex, event.target.value)
                    }
                    aria-label={`Return quantity for ${item.name}`}
                    className="w-20 rounded-md border border-purple-200 px-2 py-1 text-right text-sm"
                  />
                </label>
              );
            })}
          </fieldset>

          <label className="block text-xs font-semibold uppercase tracking-wide text-gray-500">
            Reason
            <select
              value={reason}
              onChange={(event: React.ChangeEvent<HTMLSelectElement>) => {
                setReason(event.target.value as ReturnReason);
                setPacket(null);
              }}
              className="mt-1 block w-full rounded-lg border border-purple-200 bg-white px-3 py-2 text-sm font-normal normal-case tracking-normal text-gray-900"
            >
              {REASONS.map((entry) => (
                <option key={entry.value} value={entry.value}>
                  {entry.label}
                </option>
              ))}
            </select>
          </label>

          <label className="block text-xs font-semibold uppercase tracking-wide text-gray-500">
            Notes {reason === "OTHER" ? "(required)" : "(optional)"}
            <textarea
              value={details}
              onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => {
                setDetails(event.target.value);
                setPacket(null);
              }}
              maxLength={500}
              rows={3}
              placeholder="Describe the issue without including passwords, card data, or wallet secrets."
              className="mt-1 block w-full rounded-lg border border-purple-200 px-3 py-2 text-sm font-normal normal-case tracking-normal text-gray-900"
            />
          </label>

          <button
            type="button"
            onClick={buildPacket}
            disabled={building || selectedCount === 0}
            className="w-full rounded-lg bg-purple-700 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-purple-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {building
              ? order.paymentMethod === "stellar"
                ? "Verifying current chain state…"
                : "Building review packet…"
              : `Build review packet${selectedCount ? ` · ${selectedCount} item${selectedCount === 1 ? "" : "s"}` : ""}`}
          </button>

          {error && (
            <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800">
              {error}
            </div>
          )}

          {packet && (
            <div
              className={`rounded-lg border p-3 text-xs ${
                packet.receipt.decision === "READY_FOR_MERCHANT_RETURN_REVIEW"
                  ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                  : "border-amber-200 bg-amber-50 text-amber-900"
              }`}
            >
              <div className="font-semibold">
                {packet.receipt.decision === "READY_FOR_MERCHANT_RETURN_REVIEW"
                  ? "Review packet ready — merchant decision still required"
                  : "Review packet is on hold"}
              </div>

              {packet.receipt.blockers.length > 0 && (
                <ul className="mt-2 list-disc space-y-1 pl-5">
                  {packet.receipt.blockers.map((blocker) => (
                    <li key={blocker}>{blocker}</li>
                  ))}
                </ul>
              )}

              <div className="mt-3 break-all font-mono text-[10px] text-gray-600">
                Receipt SHA-256: {packet.receipt.packetDigest}
              </div>

              <button
                type="button"
                onClick={copyPacket}
                className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-current px-2.5 py-1.5 font-semibold"
              >
                <MdContentCopy size={14} /> {copied ? "Copied" : "Copy review packet"}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
