import { supabase } from "./supabase";
import {
  FulfillmentTrackingInput,
  FulfillmentTrackingPacket,
  FULFILLMENT_RECEIPT_SCHEMA,
  compileFulfillmentTracking,
  verifyFulfillmentTrackingPacket,
} from "./fulfillment-tracking";

const TABLE = "fulfillment_receipts";

export type FulfillmentDispatchState = "PREPARED" | "DISPATCHED";

export interface StoredFulfillmentReceipt {
  orderId: string;
  packet: FulfillmentTrackingPacket;
  recordSha256: string;
  dispatchState: FulfillmentDispatchState;
  dispatchTxHash?: string;
  dispatchLedger?: number;
  dispatchedAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface DispatchReceiptEvidence {
  observedStatus: "Shipped";
  observedAt: string;
  txHash?: string;
  ledger?: number;
}

function boundedOrderId(orderId: string): string {
  if (typeof orderId !== "string" || !orderId.trim() || orderId.trim().length > 128) {
    throw new Error("Invalid fulfillment order ID");
  }
  return orderId.trim();
}

function canonicalUtc(value: string, field: string): string {
  const parsed = new Date(value);
  if (typeof value !== "string" || !Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error(`${field} must be a canonical UTC timestamp`);
  }
  return value;
}

function normalizeLedger(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const ledger = Number(value);
  if (!Number.isSafeInteger(ledger) || ledger < 0) {
    throw new Error("Stored fulfillment ledger is invalid");
  }
  return ledger;
}

async function rowToStored(row: any): Promise<StoredFulfillmentReceipt> {
  if (!row || typeof row !== "object") {
    throw new Error("Stored fulfillment receipt is missing");
  }
  if (row.schema_version !== FULFILLMENT_RECEIPT_SCHEMA) {
    throw new Error("Stored fulfillment receipt uses an unsupported schema");
  }
  const packet = row.packet as FulfillmentTrackingPacket;
  if (!(await verifyFulfillmentTrackingPacket(packet))) {
    throw new Error("Stored fulfillment receipt failed integrity verification");
  }
  if (packet.record.orderId !== row.order_id || packet.receipt.recordDigest !== row.record_sha256) {
    throw new Error("Stored fulfillment receipt identity does not match its row");
  }
  if (row.dispatch_state !== "PREPARED" && row.dispatch_state !== "DISPATCHED") {
    throw new Error("Stored fulfillment dispatch state is invalid");
  }

  return {
    orderId: row.order_id,
    packet,
    recordSha256: row.record_sha256,
    dispatchState: row.dispatch_state,
    dispatchTxHash: row.dispatch_tx_hash || undefined,
    dispatchLedger: normalizeLedger(row.dispatch_ledger),
    dispatchedAt: row.dispatched_at || undefined,
    createdAt: row.created_at || undefined,
    updatedAt: row.updated_at || undefined,
  };
}

async function loadByOrderId(orderId: string): Promise<StoredFulfillmentReceipt | null> {
  const normalized = boundedOrderId(orderId);
  const { data, error } = await supabase
    .from(TABLE)
    .select(
      "order_id,schema_version,packet,record_sha256,dispatch_state,dispatch_tx_hash,dispatch_ledger,dispatched_at,created_at,updated_at"
    )
    .eq("order_id", normalized)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? rowToStored(data) : null;
}

function assertSameRecord(existing: StoredFulfillmentReceipt, packet: FulfillmentTrackingPacket) {
  if (existing.recordSha256 !== packet.receipt.recordDigest) {
    throw new Error(
      "Conflicting fulfillment evidence already exists for this order; refusing to overwrite it"
    );
  }
}

/**
 * Persist immutable merchant-provided tracking evidence before on-chain dispatch.
 * Exact record replays are idempotent; conflicting evidence never overwrites the first record.
 */
export async function prepareFulfillmentReceipt(
  input: FulfillmentTrackingInput,
  preparedAt: string
): Promise<StoredFulfillmentReceipt> {
  const packet = await compileFulfillmentTracking(input, preparedAt);
  const existing = await loadByOrderId(packet.record.orderId);
  if (existing) {
    assertSameRecord(existing, packet);
    return existing;
  }

  const row = {
    order_id: packet.record.orderId,
    schema_version: FULFILLMENT_RECEIPT_SCHEMA,
    packet,
    record_sha256: packet.receipt.recordDigest,
    dispatch_state: "PREPARED" as const,
  };
  const { data, error } = await supabase.from(TABLE).insert([row]).select().single();
  if (error) {
    if ((error as any).code === "23505") {
      const raced = await loadByOrderId(packet.record.orderId);
      if (raced) {
        assertSameRecord(raced, packet);
        return raced;
      }
    }
    throw new Error(error.message);
  }
  return rowToStored(data);
}

/**
 * Promote an immutable PREPARED receipt only after existing dispatch authority
 * has observed the order as Shipped. This function does not dispatch anything.
 */
export async function finalizeFulfillmentReceipt(
  orderId: string,
  recordSha256: string,
  evidence: DispatchReceiptEvidence
): Promise<StoredFulfillmentReceipt> {
  const normalized = boundedOrderId(orderId);
  if (!/^[0-9a-f]{64}$/.test(recordSha256)) {
    throw new Error("Invalid fulfillment receipt digest");
  }
  if (evidence.observedStatus !== "Shipped") {
    throw new Error("Fulfillment receipt cannot finalize without observed Shipped state");
  }
  const observedAt = canonicalUtc(evidence.observedAt, "observedAt");
  if (evidence.ledger !== undefined && (!Number.isSafeInteger(evidence.ledger) || evidence.ledger < 0)) {
    throw new Error("dispatch ledger must be a non-negative integer");
  }
  if (evidence.txHash !== undefined && !/^[0-9a-fA-F]{64}$/.test(evidence.txHash)) {
    throw new Error("dispatch transaction hash is invalid");
  }

  const { data, error } = await supabase
    .from(TABLE)
    .update({
      dispatch_state: "DISPATCHED",
      dispatch_tx_hash: evidence.txHash || null,
      dispatch_ledger: evidence.ledger ?? null,
      dispatched_at: observedAt,
      updated_at: observedAt,
    })
    .eq("order_id", normalized)
    .eq("record_sha256", recordSha256)
    .eq("dispatch_state", "PREPARED")
    .select()
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (data) return rowToStored(data);

  const existing = await loadByOrderId(normalized);
  if (!existing) throw new Error("Prepared fulfillment receipt was not found");
  if (existing.recordSha256 !== recordSha256) {
    throw new Error("Fulfillment receipt digest conflict during finalization");
  }
  if (existing.dispatchState === "DISPATCHED") return existing;
  throw new Error("Fulfillment receipt could not be finalized");
}

/**
 * Buyer read is additionally constrained by database RLS to the authenticated
 * owner of the matching order and to DISPATCHED receipts only.
 */
export async function fetchBuyerFulfillmentReceipt(
  orderId: string
): Promise<StoredFulfillmentReceipt | null> {
  const normalized = boundedOrderId(orderId);
  const { data, error } = await supabase
    .from(TABLE)
    .select(
      "order_id,schema_version,packet,record_sha256,dispatch_state,dispatch_tx_hash,dispatch_ledger,dispatched_at,created_at,updated_at"
    )
    .eq("order_id", normalized)
    .eq("dispatch_state", "DISPATCHED")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  const stored = await rowToStored(data);
  return stored.dispatchState === "DISPATCHED" ? stored : null;
}

/** Admin-only read; database RLS requires public.is_admin(). */
export async function fetchAdminFulfillmentReceipt(
  orderId: string
): Promise<StoredFulfillmentReceipt | null> {
  return loadByOrderId(orderId);
}
