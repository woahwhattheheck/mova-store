"use client";

import React, { useEffect, useState } from "react";
import { FaExternalLinkAlt } from "react-icons/fa";
import { MdLocalShipping, MdVerified } from "react-icons/md";

import { fetchBuyerFulfillmentReceipt, StoredFulfillmentReceipt } from "../lib/fulfillment-tracking-store";

export default function FulfillmentTrackingPanel({ orderId }: { orderId: string }) {
  const [receipt, setReceipt] = useState<StoredFulfillmentReceipt | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    fetchBuyerFulfillmentReceipt(orderId)
      .then((result) => {
        if (active) setReceipt(result);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [orderId]);

  if (error) {
    return (
      <div className="border-t border-rose-100 bg-rose-50/60 px-4 py-3 text-xs text-rose-800 sm:px-5">
        A fulfillment receipt exists or was requested, but it could not be integrity-verified for this account.
      </div>
    );
  }
  if (!receipt) return null;

  const { record } = receipt.packet;
  return (
    <div className="border-t border-emerald-100 bg-emerald-50/50 px-4 py-4 sm:px-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold text-emerald-900">
            <MdLocalShipping size={18} /> Fulfillment tracking receipt
          </div>
          <p className="mt-1 text-xs leading-5 text-emerald-900/80">
            Merchant-provided shipment evidence. The receipt verifies record integrity, not carrier delivery.
          </p>
        </div>
        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-800">
          <MdVerified /> Receipt verified
        </span>
      </div>

      <dl className="mt-3 grid gap-x-5 gap-y-2 text-xs sm:grid-cols-2">
        <div>
          <dt className="text-gray-500">Carrier</dt>
          <dd className="font-medium text-gray-900">{record.carrierName} ({record.carrierCode})</dd>
        </div>
        <div>
          <dt className="text-gray-500">Tracking number</dt>
          <dd className="break-all font-mono font-medium text-gray-900">{record.trackingNumber}</dd>
        </div>
        <div>
          <dt className="text-gray-500">Shipped at</dt>
          <dd className="font-medium text-gray-900">{new Date(record.shippedAt).toLocaleString()}</dd>
        </div>
        {record.expectedDeliveryAt && (
          <div>
            <dt className="text-gray-500">Expected delivery</dt>
            <dd className="font-medium text-gray-900">{new Date(record.expectedDeliveryAt).toLocaleString()}</dd>
          </div>
        )}
      </dl>

      <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
        {record.trackingUrl && (
          <a
            href={record.trackingUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 font-semibold text-emerald-800 underline"
          >
            Open carrier tracking <FaExternalLinkAlt size={10} />
          </a>
        )}
        <span className="break-all font-mono text-[10px] text-gray-500">
          SHA-256 {receipt.recordSha256}
        </span>
      </div>
    </div>
  );
}
