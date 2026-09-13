/**
 * Buyer Order Management
 *
 * Provides utilities for storing, querying, and verifying past buyer orders
 * via Supabase and local storage, with on-chain Stellar verification.
 */

import { supabase } from "./supabase";
import { readOrder } from "./stellar/orders";

export interface OrderItem {
  id?: string | number;
  name: string;
  price: number;
  quantity?: number;
  img?: string;
}

export interface BuyerOrder {
  id: string;
  orderId: string;
  userId?: string;
  userEmail?: string;
  createdAt: string;
  total: number;
  status: "Pending" | "Paid" | "Shipped" | "Refunded" | "Completed";
  paymentMethod: "stellar" | "card";
  tokenSymbol?: string;
  tokenAmount?: number;
  txHash?: string;
  ledger?: number;
  items: OrderItem[];
}

const STORAGE_KEY = "mova_buyer_orders";

/**
 * Saves an order to the local cache and, when signed in, persists it to Supabase.
 * The active Supabase session is authoritative for ownership. Guest orders remain
 * device-local and never attempt a remote insert.
 */
export async function saveBuyerOrder(order: BuyerOrder): Promise<BuyerOrder> {
  let sessionUser: { id: string; email?: string | null } | null = null;

  try {
    const { data, error } = await supabase.auth.getSession();
    if (error) {
      throw new Error(error.message);
    }
    sessionUser = data?.session?.user || null;
  } catch (err) {
    // Session lookup failures must not lose the local order. Treat the write as
    // guest-local rather than trusting caller-supplied identity fields.
    console.warn("Could not resolve Supabase session; keeping order device-local:", err);
  }

  const cachedOrder: BuyerOrder = sessionUser
    ? {
        ...order,
        userId: sessionUser.id,
        userEmail: sessionUser.email || undefined,
      }
    : {
        ...order,
        userId: undefined,
        userEmail: undefined,
      };

  // 1. Cache locally using only session-derived ownership.
  try {
    const cached = getCachedBuyerOrders();
    const existingIndex = cached.findIndex((o) => o.orderId === cachedOrder.orderId);
    if (existingIndex >= 0) {
      cached[existingIndex] = cachedOrder;
    } else {
      cached.unshift(cachedOrder);
    }
    if (typeof window !== "undefined") {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(cached));
    }
  } catch (err) {
    console.warn("Failed to cache order to localStorage:", err);
  }

  // 2. Signed-in orders may persist remotely. Guest checkout is device-local.
  if (sessionUser) {
    try {
      const { error } = await supabase.from("orders").insert([
        {
          // Let Postgres generate the row UUID. order.id is an app/cache ID and
          // is not guaranteed to be a valid UUID.
          order_id: order.orderId,
          user_id: sessionUser.id,
          user_email: sessionUser.email || null,
          total: order.total,
          status: order.status,
          payment_method: order.paymentMethod,
          token_symbol: order.tokenSymbol || null,
          token_amount: order.tokenAmount || null,
          tx_hash: order.txHash || null,
          items: order.items,
          created_at: order.createdAt,
        },
      ]);

      if (error) {
        throw new Error(error.message);
      }
    } catch (err) {
      // Supabase may be unavailable in dev/offline; the local cache above keeps
      // the order accessible without weakening the database ownership boundary.
      console.warn("Could not insert order into Supabase, kept in local cache:", err);
    }
  }

  return cachedOrder;
}

/**
 * Retrieves all cached orders from localStorage.
 */
export function getCachedBuyerOrders(): BuyerOrder[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Fetches past orders for an authenticated user, or device-local guest orders
 * when no user identity is supplied.
 */
export async function fetchBuyerOrders(userEmailOrId?: string): Promise<BuyerOrder[]> {
  let orders: BuyerOrder[] = [];

  // Try querying Supabase first for signed-in users. RLS remains the authority;
  // the explicit filter only narrows the caller's own rows.
  try {
    if (supabase && userEmailOrId) {
      const isEmail = userEmailOrId.includes("@");
      const query = supabase
        .from("orders")
        .select("*")
        .order("created_at", { ascending: false });

      const res = isEmail
        ? await query.eq("user_email", userEmailOrId)
        : await query.eq("user_id", userEmailOrId);

      if (res.error) {
        throw new Error(res.error.message);
      }

      if (res.data && Array.isArray(res.data) && res.data.length > 0) {
        orders = res.data.map((row: any) => ({
          id: row.id || row.order_id,
          orderId: row.order_id || row.id,
          userId: row.user_id,
          userEmail: row.user_email,
          createdAt: row.created_at || new Date().toISOString(),
          total: Number(row.total) || 0,
          status: row.status || "Paid",
          paymentMethod: row.payment_method || "stellar",
          tokenSymbol: row.token_symbol || "USDC",
          tokenAmount: row.token_amount ? Number(row.token_amount) : undefined,
          txHash: row.tx_hash,
          ledger: row.ledger,
          items: Array.isArray(row.items) ? row.items : [],
        }));
      }
    }
  } catch (err) {
    console.warn("Supabase query failed, falling back to cached orders:", err);
  }

  // Fallback to localStorage without crossing identity boundaries. Signed-in
  // users only see explicitly matching cached ownership; guests only see rows
  // with no signed-in owner attached.
  if (orders.length === 0) {
    const cached = getCachedBuyerOrders();
    if (userEmailOrId) {
      const normalized = userEmailOrId.toLowerCase();
      orders = cached.filter(
        (o) =>
          (Boolean(o.userId) && o.userId === userEmailOrId) ||
          (Boolean(o.userEmail) && o.userEmail?.toLowerCase() === normalized)
      );
    } else {
      orders = cached.filter((o) => !o.userId && !o.userEmail);
    }
  }

  return orders;
}

/**
 * Cross-references an order with the Soroban smart contract to verify on-chain status.
 */
export async function verifyOrderOnChain(orderId: string): Promise<{
  verified: boolean;
  onChainStatus?: string;
  buyer?: string;
  amountDisplay?: string;
  tokenSymbol?: string;
}> {
  try {
    const onChain = await readOrder(orderId);
    if (!onChain) {
      return { verified: false };
    }
    return {
      verified: onChain.status !== "Unknown",
      onChainStatus: onChain.status,
      buyer: onChain.buyer,
      amountDisplay: onChain.amountDisplay,
      tokenSymbol: onChain.tokenSymbol,
    };
  } catch {
    return { verified: false };
  }
}
