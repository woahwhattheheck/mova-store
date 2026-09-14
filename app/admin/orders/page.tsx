"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AiOutlineLoading3Quarters } from "react-icons/ai";
import { MdCancel, MdCheckCircle, MdLocalShipping, MdPayment, MdPending, MdRefresh, MdWarning } from "react-icons/md";
import { SiStellar } from "react-icons/si";

import AdminGuard from "../../../components/AdminGuard";
import FulfillmentDispatchControl from "../../../components/FulfillmentDispatchControl";
import StellarWalletButton from "../../../components/StellarWalletButton";
import { merchantRowToDisplayAmount, type MerchantOrderRow } from "../../../lib/merchant-order-index";
import { supabase } from "../../../lib/supabase";
import { NETWORK, CHECKOUT_CONTRACT_ID } from "../../../lib/stellar/config";
import { refundOrder } from "../../../lib/stellar/orders";

function truncate(value: string) {
  if (!value || value.length < 16) return value;
  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}

function StatusBadge({ row }: { row: MerchantOrderRow }) {
  const styles: Record<string, string> = {
    Quoted: "bg-gray-100 text-gray-800",
    Pending: "bg-yellow-100 text-yellow-800",
    Paid: "bg-blue-100 text-blue-800",
    Shipped: "bg-green-100 text-green-800",
    Refunded: "bg-purple-100 text-purple-800",
    Unknown: "bg-gray-100 text-gray-800",
    Conflict: "bg-red-100 text-red-800",
  };
  return (
    <div>
      <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${styles[row.chainStatus] || styles.Unknown}`}>
        {row.chainStatus}
      </span>
      {row.identityConflict && (
        <div className="mt-1 text-xs text-red-700">{row.conflictReasons.join(", ")}</div>
      )}
    </div>
  );
}

function OrderRow({ row, processing, onRefund }: { row: MerchantOrderRow; processing: boolean; onRefund: (id: string) => void }) {
  const canTrack = row.chainStatus === "Paid" || row.chainStatus === "Shipped";
  const canRefund = row.chainStatus === "Paid" && !row.identityConflict;
  const created = row.chainTimestamp
    ? new Date(row.chainTimestamp * 1000).toLocaleString()
    : new Date(row.quoteCreatedAt).toLocaleString();
  return (
    <tr className="border-b hover:bg-gray-50">
      <td className="px-4 py-4 font-mono text-xs text-gray-600" title={row.orderId}>{truncate(row.orderId)}</td>
      <td className="px-4 py-4 font-mono text-xs text-gray-600" title={row.buyer}>{truncate(row.buyer)}</td>
      <td className="px-4 py-4 font-semibold">{merchantRowToDisplayAmount(row)} {row.tokenSymbol}</td>
      <td className="px-4 py-4"><StatusBadge row={row} /></td>
      <td className="px-4 py-4 text-sm text-gray-500">{created}</td>
      <td className="px-4 py-4 text-xs text-gray-500">
        {row.lastReconcileError ? <span className="text-amber-700">RPC retry needed</span> : "Direct contract read"}
      </td>
      <td className="px-4 py-4 align-top">
        <div className="flex items-start gap-2">
          {canTrack && !row.identityConflict && (
            <FulfillmentDispatchControl
              orderId={row.orderId}
              orderStatus={row.chainStatus as "Paid" | "Shipped"}
              disabled={processing}
            />
          )}
          {canRefund && (
            <button onClick={() => onRefund(row.orderId)} disabled={processing}
              className="flex items-center gap-1 rounded bg-purple-600 px-3 py-1 text-sm text-white hover:bg-purple-700 disabled:opacity-50">
              {processing ? <AiOutlineLoading3Quarters className="animate-spin" /> : <MdCancel />} Refund
            </button>
          )}
          {!canTrack && !canRefund && <span className="text-sm text-gray-400">-</span>}
        </div>
      </td>
    </tr>
  );
}

function OrdersManagementContent() {
  const [orders, setOrders] = useState<MerchantOrderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [processingOrderId, setProcessingOrderId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data, error: sessionError } = await supabase.auth.getSession();
      if (sessionError || !data.session?.access_token) throw new Error("Admin session is unavailable");
      const response = await fetch("/api/admin/orders?limit=250", {
        headers: { Authorization: `Bearer ${data.session.access_token}` },
        cache: "no-store",
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Durable order index request failed");
      if (body.retentionIndependent !== true || body.source !== "durable-quote-index+direct-contract-read") {
        throw new Error("Durable order index returned an unexpected source");
      }
      setOrders(Array.isArray(body.orders) ? body.orders : []);
    } catch (err) {
      setOrders([]);
      setError(err instanceof Error ? err.message : "Durable merchant order index is unavailable");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleRefund = useCallback(async (orderId: string) => {
    setProcessingOrderId(orderId);
    setError(null);
    setSuccess(null);
    try {
      const result = await refundOrder(orderId);
      if (!result.success) throw new Error(result.error || "Failed to refund order");
      setSuccess(`Order ${truncate(orderId)} refunded successfully.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Refund failed");
    } finally {
      setProcessingOrderId(null);
    }
  }, [load]);

  const stats = useMemo(() => ({
    total: orders.length,
    quoted: orders.filter((o) => o.chainStatus === "Quoted").length,
    paid: orders.filter((o) => o.chainStatus === "Paid").length,
    shipped: orders.filter((o) => o.chainStatus === "Shipped").length,
    conflicts: orders.filter((o) => o.identityConflict).length,
  }), [orders]);

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-800">Order Management</h1>
          <p className="mt-1 text-gray-500">Durable merchant order discovery + direct contract reconciliation</p>
        </div>
        <div className="flex items-center gap-4">
          <StellarWalletButton />
          <Link href="/admin" className="rounded bg-gray-200 px-4 py-2 text-gray-700 hover:bg-gray-300">Back to Products</Link>
        </div>
      </div>

      <div className="mb-6 flex items-center gap-3 rounded-lg border border-purple-200 bg-purple-50 p-4">
        <SiStellar className="text-xl text-purple-600" />
        <div>
          <span className="font-medium text-purple-800">Stellar {NETWORK.toUpperCase()}</span>
          <span className="ml-2 text-sm text-purple-600">Contract: {truncate(CHECKOUT_CONTRACT_ID)}</span>
        </div>
        <div className="ml-auto text-sm text-purple-700">Retention-independent queue</div>
      </div>

      {error && <div className="mb-4 flex items-center gap-2 rounded border border-red-200 bg-red-50 px-4 py-3 text-red-700"><MdWarning />{error}</div>}
      {success && <div className="mb-4 flex items-center gap-2 rounded border border-green-200 bg-green-50 px-4 py-3 text-green-700"><MdCheckCircle />{success}</div>}

      <div className="mb-8 grid grid-cols-2 gap-4 md:grid-cols-5">
        <div className="rounded-lg bg-white p-4 shadow"><div className="text-sm text-gray-500">Indexed</div><div className="text-2xl font-bold">{stats.total}</div></div>
        <div className="rounded-lg bg-gray-50 p-4 shadow"><div className="flex items-center gap-1 text-sm text-gray-600"><MdPending />Quoted</div><div className="text-2xl font-bold">{stats.quoted}</div></div>
        <div className="rounded-lg bg-blue-50 p-4 shadow"><div className="flex items-center gap-1 text-sm text-blue-600"><MdPayment />Paid</div><div className="text-2xl font-bold text-blue-800">{stats.paid}</div></div>
        <div className="rounded-lg bg-green-50 p-4 shadow"><div className="flex items-center gap-1 text-sm text-green-600"><MdLocalShipping />Shipped</div><div className="text-2xl font-bold text-green-800">{stats.shipped}</div></div>
        <div className="rounded-lg bg-red-50 p-4 shadow"><div className="flex items-center gap-1 text-sm text-red-600"><MdWarning />Conflicts</div><div className="text-2xl font-bold text-red-800">{stats.conflicts}</div></div>
      </div>

      <div className="overflow-hidden rounded-lg bg-white shadow">
        <div className="flex items-center justify-between border-b px-6 py-4">
          <h2 className="text-xl font-semibold text-gray-800">Durable Orders</h2>
          <button onClick={() => void load()} disabled={loading} className="flex items-center gap-2 px-3 py-1 text-gray-600 hover:text-gray-800 disabled:opacity-50"><MdRefresh /> Refresh</button>
        </div>
        {loading ? (
          <div className="p-12 text-center"><AiOutlineLoading3Quarters className="mx-auto mb-4 animate-spin text-4xl text-gray-400" /><p className="text-gray-500">Reconciling durable order IDs against contract state...</p></div>
        ) : orders.length === 0 && !error ? (
          <div className="p-12 text-center"><SiStellar className="mx-auto mb-4 text-6xl text-gray-300" /><p className="text-gray-500">No durable merchant quotes have been issued yet.</p></div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full">
              <thead className="bg-gray-50"><tr>{["Order ID","Buyer","Amount","Status","Observed","Source","Actions"].map((h) => <th key={h} className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">{h}</th>)}</tr></thead>
              <tbody>{orders.map((row) => <OrderRow key={row.orderId} row={row} processing={processingOrderId === row.orderId} onRefund={handleRefund} />)}</tbody>
            </table>
          </div>
        )}
      </div>

      <div className="mt-8 rounded-lg bg-gray-50 p-6 text-sm text-gray-600">
        <strong>Completeness model:</strong> each merchant-authorized quote is durably indexed before its XDR is returned. This page enumerates those known IDs and reads contract state directly; a fresh browser session does not reconstruct completeness from a short RPC event window. Identity mismatches fail closed as conflicts.
      </div>
    </div>
  );
}

export default function OrdersManagementPage() {
  return <AdminGuard><OrdersManagementContent /></AdminGuard>;
}
