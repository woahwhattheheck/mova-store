import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  MERCHANT_ORDER_INDEX_SCHEMA,
  MAX_MERCHANT_INDEX_PAGE,
  merchantSeedEquals,
  normalizeMerchantOrderId,
  normalizeMerchantOrderSeed,
  reconcileMerchantOrder,
  type ChainOrderObservation,
  type MerchantOrderRow,
  type MerchantOrderSeed,
  type ReconcileDecision,
} from "../merchant-order-index";

const TABLE = "merchant_order_index";

function serviceClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error("Durable merchant order index is not configured");
  }
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

function rowToSeed(row: any): MerchantOrderSeed {
  return normalizeMerchantOrderSeed({
    schemaVersion: row.schema_version,
    orderId: row.order_id,
    cartDigestSha256: row.cart_digest_sha256,
    buyer: row.buyer,
    tokenContractId: row.token_contract_id,
    tokenSymbol: row.token_symbol,
    amountRaw: String(row.amount_raw),
    authValidUntilLedger: Number(row.auth_valid_until_ledger),
  });
}

function rowToPublic(row: any): MerchantOrderRow {
  const seed = rowToSeed(row);
  const conflictReasons = Array.isArray(row.conflict_reasons)
    ? row.conflict_reasons.filter((value: unknown) => typeof value === "string")
    : [];
  return {
    ...seed,
    quoteCreatedAt: String(row.quote_created_at),
    chainStatus: row.chain_status,
    chainBuyer: row.chain_buyer || undefined,
    chainTokenContractId: row.chain_token_contract_id || undefined,
    chainAmountRaw: row.chain_amount_raw == null ? undefined : String(row.chain_amount_raw),
    chainTimestamp: row.chain_timestamp == null ? undefined : Number(row.chain_timestamp),
    identityConflict: row.identity_conflict === true,
    conflictReasons,
    lastReconciledAt: row.last_reconciled_at || undefined,
    lastReconcileError: row.last_reconcile_error || undefined,
  };
}

const SELECT = [
  "schema_version",
  "order_id",
  "cart_digest_sha256",
  "buyer",
  "token_contract_id",
  "token_symbol",
  "amount_raw",
  "auth_valid_until_ledger",
  "quote_created_at",
  "chain_status",
  "chain_buyer",
  "chain_token_contract_id",
  "chain_amount_raw",
  "chain_timestamp",
  "identity_conflict",
  "conflict_reasons",
  "last_reconciled_at",
  "last_reconcile_error",
].join(",");

export async function persistMerchantQuoteIndex(seedInput: MerchantOrderSeed): Promise<MerchantOrderRow> {
  const seed = normalizeMerchantOrderSeed(seedInput);
  const client = serviceClient();
  const row = {
    schema_version: MERCHANT_ORDER_INDEX_SCHEMA,
    order_id: seed.orderId,
    cart_digest_sha256: seed.cartDigestSha256,
    buyer: seed.buyer,
    token_contract_id: seed.tokenContractId,
    token_symbol: seed.tokenSymbol,
    amount_raw: seed.amountRaw,
    auth_valid_until_ledger: seed.authValidUntilLedger,
  };
  const { data, error } = await client.from(TABLE).insert(row).select(SELECT).single();
  if (!error && data) return rowToPublic(data);

  if ((error as any)?.code === "23505") {
    const existing = await loadMerchantOrder(seed.orderId, client);
    if (existing && merchantSeedEquals(seed, existing)) return existing;
    throw new Error("Conflicting durable merchant order identity already exists");
  }
  throw new Error(error?.message || "Failed to persist durable merchant order identity");
}

export async function loadMerchantOrder(orderId: string, client = serviceClient()): Promise<MerchantOrderRow | null> {
  const normalized = normalizeMerchantOrderId(orderId);
  const { data, error } = await client.from(TABLE).select(SELECT).eq("order_id", normalized).maybeSingle();
  if (error) throw new Error(error.message);
  return data ? rowToPublic(data) : null;
}

export async function listMerchantOrders(limit = 100): Promise<MerchantOrderRow[]> {
  const bounded = Math.max(1, Math.min(MAX_MERCHANT_INDEX_PAGE, Math.trunc(limit)));
  const { data, error } = await serviceClient()
    .from(TABLE)
    .select(SELECT)
    .order("quote_created_at", { ascending: false })
    .limit(bounded);
  if (error) throw new Error(error.message);
  return (data || []).map(rowToPublic);
}

export async function storeReconcileDecision(
  orderId: string,
  decision: ReconcileDecision,
  reconciledAt: string,
  reconcileError?: string
): Promise<void> {
  const client = serviceClient();
  const patch = {
    chain_status: decision.chainStatus,
    chain_buyer: decision.chainBuyer || null,
    chain_token_contract_id: decision.chainTokenContractId || null,
    chain_amount_raw: decision.chainAmountRaw || null,
    chain_timestamp: decision.chainTimestamp ?? null,
    identity_conflict: decision.identityConflict,
    conflict_reasons: decision.conflictReasons,
    last_reconciled_at: reconciledAt,
    last_reconcile_error: reconcileError || null,
    updated_at: reconciledAt,
  };
  const { error } = await client.from(TABLE).update(patch).eq("order_id", orderId);
  if (error) throw new Error(error.message);
}

export async function reconcileStoredMerchantOrder(
  row: MerchantOrderRow,
  read: (orderId: string) => Promise<ChainOrderObservation | null>,
  reconciledAt = new Date().toISOString()
): Promise<MerchantOrderRow> {
  try {
    const chain = await read(row.orderId);
    const decision: ReconcileDecision = chain
      ? reconcileMerchantOrder(row, chain, row.chainStatus)
      : {
          chainStatus: row.chainStatus,
          chainBuyer: row.chainBuyer,
          chainTokenContractId: row.chainTokenContractId,
          chainAmountRaw: row.chainAmountRaw,
          chainTimestamp: row.chainTimestamp,
          identityConflict: row.identityConflict,
          conflictReasons: row.conflictReasons,
        };
    await storeReconcileDecision(row.orderId, decision, reconciledAt);
    return { ...row, ...decision, lastReconciledAt: reconciledAt, lastReconcileError: undefined };
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : "Unknown reconciliation error";
    const decision: ReconcileDecision = {
      chainStatus: row.identityConflict ? "Conflict" : row.chainStatus,
      chainBuyer: row.chainBuyer,
      chainTokenContractId: row.chainTokenContractId,
      chainAmountRaw: row.chainAmountRaw,
      chainTimestamp: row.chainTimestamp,
      identityConflict: row.identityConflict,
      conflictReasons: row.conflictReasons,
    };
    await storeReconcileDecision(row.orderId, decision, reconciledAt, message);
    return { ...row, lastReconciledAt: reconciledAt, lastReconcileError: message };
  }
}
