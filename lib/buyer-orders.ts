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

export interface OrderFulfillment {
  firstName: string;
  lastName: string;
  email: string;
  address: string;
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
  /**
   * Buyer-presented delivery/contact context captured only after a payment
   * authority has already confirmed the order. It is fulfillment context, not
   * pricing authority: merchant-authoritative quote validation remains a
   * separate checkout boundary.
   */
  fulfillment?: OrderFulfillment;
}

export interface PaidOrderSnapshotInput {
  orderId: string;
  total: number;
  items: unknown;
  fulfillment: OrderFulfillment;
  tokenSymbol?: string;
  tokenAmount?: number;
  txHash?: string;
  ledger?: number;
  createdAt?: string;
}

export interface SaveBuyerOrderOptions {
  /** Fail unless the order reaches at least one persistence target. */
  requirePersistence?: boolean;
}

interface StoredOrderEnvelope {
  schemaVersion: 1;
  lines: OrderItem[];
  fulfillment: OrderFulfillment;
}

const STORAGE_KEY = "mova_buyer_orders";
const MAX_ORDER_ID_LENGTH = 128;
const MAX_ITEM_NAME_LENGTH = 512;
const MAX_IMAGE_VALUE_LENGTH = 4096;
const MAX_FULFILLMENT_VALUE_LENGTH = 4096;

function normalizeRequiredText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string") {
    throw new Error(`${field} is required`);
  }
  const text = value.trim();
  if (!text || text.length > maxLength) {
    throw new Error(`${field} is invalid`);
  }
  return text;
}

function normalizeFulfillment(input: OrderFulfillment): OrderFulfillment {
  return {
    firstName: normalizeRequiredText(
      input?.firstName,
      "Fulfillment first name",
      MAX_FULFILLMENT_VALUE_LENGTH
    ),
    lastName: normalizeRequiredText(
      input?.lastName,
      "Fulfillment last name",
      MAX_FULFILLMENT_VALUE_LENGTH
    ),
    email: normalizeRequiredText(
      input?.email,
      "Fulfillment email",
      MAX_FULFILLMENT_VALUE_LENGTH
    ),
    address: normalizeRequiredText(
      input?.address,
      "Fulfillment address",
      MAX_FULFILLMENT_VALUE_LENGTH
    ),
  };
}

function normalizeSnapshotItems(input: unknown): OrderItem[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error("Paid order snapshot must contain at least one line item");
  }

  return input.map((raw, index) => {
    if (!raw || typeof raw !== "object") {
      throw new Error(`Paid order line ${index + 1} is invalid`);
    }
    const row = raw as Record<string, unknown>;
    const name = normalizeRequiredText(
      row.name,
      `Paid order line ${index + 1} name`,
      MAX_ITEM_NAME_LENGTH
    );
    const price = typeof row.price === "number" ? row.price : Number(row.price);
    if (!Number.isFinite(price) || price < 0) {
      throw new Error(`Paid order line ${index + 1} price is invalid`);
    }

    const quantityValue = row.quantity ?? 1;
    const quantity =
      typeof quantityValue === "number" ? quantityValue : Number(quantityValue);
    if (!Number.isSafeInteger(quantity) || quantity < 1) {
      throw new Error(`Paid order line ${index + 1} quantity is invalid`);
    }

    const item: OrderItem = { name, price, quantity };
    if (typeof row.id === "string" || typeof row.id === "number") {
      item.id = row.id;
    }
    if (typeof row.img === "string") {
      const img = row.img.trim();
      if (img.length > MAX_IMAGE_VALUE_LENGTH) {
        throw new Error(`Paid order line ${index + 1} image value is invalid`);
      }
      if (img) item.img = img;
    }
    return item;
  });
}

function cloneOrderItems(items: OrderItem[]): OrderItem[] {
  return items.map((item) => ({ ...item }));
}

function serializeStoredOrder(order: BuyerOrder): OrderItem[] | StoredOrderEnvelope {
  if (!order.fulfillment) {
    return cloneOrderItems(order.items);
  }
  return {
    schemaVersion: 1,
    lines: cloneOrderItems(order.items),
    fulfillment: { ...order.fulfillment },
  };
}

function parseStoredOrder(value: unknown): {
  items: OrderItem[];
  fulfillment?: OrderFulfillment;
} {
  if (Array.isArray(value)) {
    return {
      items: value.filter((item): item is OrderItem => Boolean(item && typeof item === "object")),
    };
  }

  if (!value || typeof value !== "object") {
    return { items: [] };
  }

  const envelope = value as Partial<StoredOrderEnvelope>;
  if (envelope.schemaVersion !== 1 || !Array.isArray(envelope.lines)) {
    return { items: [] };
  }

  const items = envelope.lines.filter(
    (item): item is OrderItem => Boolean(item && typeof item === "object")
  );
  try {
    const fulfillment = envelope.fulfillment
      ? normalizeFulfillment(envelope.fulfillment)
      : undefined;
    return { items, fulfillment };
  } catch {
    // A malformed optional fulfillment envelope must not make historical order
    // lines unreadable. The line items remain available while bad context is
    // dropped fail-closed.
    return { items };
  }
}

function paidCommerceFingerprint(order: Pick<
  BuyerOrder,
  "orderId" | "total" | "paymentMethod" | "tokenSymbol" | "tokenAmount" | "items" | "fulfillment"
>): string {
  return JSON.stringify({
    orderId: order.orderId,
    total: order.total,
    paymentMethod: order.paymentMethod,
    tokenSymbol: order.tokenSymbol ?? null,
    tokenAmount: order.tokenAmount ?? null,
    items: order.items,
    fulfillment: order.fulfillment ?? null,
  });
}

/**
 * Build a detached fulfillment snapshot for a payment that has already been
 * authoritatively confirmed by the caller. Browser cart names/prices are kept
 * only as buyer-presented fulfillment context; this function does not elevate
 * them into merchant pricing authority.
 */
export function createPaidBuyerOrderSnapshot(input: PaidOrderSnapshotInput): BuyerOrder {
  const orderId = normalizeRequiredText(input.orderId, "Order id", MAX_ORDER_ID_LENGTH);
  if (!Number.isFinite(input.total) || input.total <= 0) {
    throw new Error("Paid order total is invalid");
  }

  const tokenAmount = input.tokenAmount ?? input.total;
  if (!Number.isFinite(tokenAmount) || tokenAmount <= 0) {
    throw new Error("Paid order token amount is invalid");
  }
  if (input.ledger !== undefined && (!Number.isSafeInteger(input.ledger) || input.ledger < 0)) {
    throw new Error("Paid order ledger is invalid");
  }
  if (input.txHash !== undefined && typeof input.txHash !== "string") {
    throw new Error("Paid order transaction hash is invalid");
  }

  return {
    id: `paid-${orderId}`,
    orderId,
    createdAt: input.createdAt ?? new Date().toISOString(),
    total: input.total,
    status: "Paid",
    paymentMethod: "stellar",
    tokenSymbol: input.tokenSymbol ?? "USDC",
    tokenAmount,
    txHash: input.txHash?.trim() || undefined,
    ledger: input.ledger,
    items: normalizeSnapshotItems(input.items),
    fulfillment: normalizeFulfillment(input.fulfillment),
  };
}

/**
 * Persist a paid commerce snapshot once per order id. Repeated callbacks with
 * the same commerce payload are harmless, while a conflicting terminal order
 * id fails closed instead of silently rewriting fulfillment evidence.
 */
export async function savePaidBuyerOrderOnce(
  input: PaidOrderSnapshotInput
): Promise<BuyerOrder> {
  const candidate = createPaidBuyerOrderSnapshot(input);
  const existing = getCachedBuyerOrders().find((order) => order.orderId === candidate.orderId);
  if (existing && ["Paid", "Shipped", "Refunded", "Completed"].includes(existing.status)) {
    if (paidCommerceFingerprint(existing) !== paidCommerceFingerprint(candidate)) {
      throw new Error("Paid order id already has conflicting commerce evidence");
    }
    return existing;
  }
  return saveBuyerOrder(candidate, { requirePersistence: true });
}

/**
 * Saves an order to the local cache and, when signed in, persists it to Supabase.
 * The active Supabase session is authoritative for ownership. Guest orders remain
 * device-local and never attempt a remote insert.
 */
export async function saveBuyerOrder(
  order: BuyerOrder,
  options: SaveBuyerOrderOptions = {}
): Promise<BuyerOrder> {
  let sessionUser: { id: string; email?: string | null } | null = null;

  try {
    const { data, error } = await supabase.auth.getSession();
    if (error) {
      throw new Error(error.message);
    }
    sessionUser = data?.session?.user || null;
  } catch (err) {
    // A failed session lookup is not evidence that the buyer is logged out. If we
    // classified it as guest, the row would become visible in logged-out history
    // on this device. Fail before either cache or remote persistence instead.
    console.warn("Could not resolve Supabase session; refusing to classify order ownership:", err);
    throw new Error("Could not resolve order ownership");
  }

  const cachedOrder: BuyerOrder = sessionUser
    ? {
        ...order,
        userId: sessionUser.id,
        userEmail: sessionUser.email || undefined,
        items: cloneOrderItems(order.items),
        fulfillment: order.fulfillment ? { ...order.fulfillment } : undefined,
      }
    : {
        ...order,
        userId: undefined,
        userEmail: undefined,
        items: cloneOrderItems(order.items),
        fulfillment: order.fulfillment ? { ...order.fulfillment } : undefined,
      };

  let localPersistenceSucceeded = false;
  let remotePersistenceSucceeded = false;

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
      localPersistenceSucceeded = true;
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
          items: serializeStoredOrder(cachedOrder),
          created_at: order.createdAt,
        },
      ]);

      if (error) {
        throw new Error(error.message);
      }
      remotePersistenceSucceeded = true;
    } catch (err) {
      // Supabase may be unavailable in dev/offline; the local cache above keeps
      // the order accessible without weakening the database ownership boundary.
      console.warn("Could not insert order into Supabase, kept in local cache:", err);
    }
  }

  if (options.requirePersistence && !localPersistenceSucceeded && !remotePersistenceSucceeded) {
    throw new Error("Could not persist paid order details");
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

function cachedOrdersForIdentity(userEmailOrId?: string): BuyerOrder[] {
  const cached = getCachedBuyerOrders();

  if (!userEmailOrId) {
    return cached.filter((order) => !order.userId && !order.userEmail);
  }

  const normalized = userEmailOrId.toLowerCase();
  return cached.filter(
    (order) =>
      (Boolean(order.userId) && order.userId === userEmailOrId) ||
      (Boolean(order.userEmail) && order.userEmail?.toLowerCase() === normalized)
  );
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
        orders = res.data.map((row: any) => {
          const stored = parseStoredOrder(row.items);
          return {
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
            items: stored.items,
            fulfillment: stored.fulfillment,
          } as BuyerOrder;
        });
      }
    }
  } catch (err) {
    console.warn("Supabase query failed, falling back to cached orders:", err);
  }

  // Always consider identity-matching cached rows. A remote insert can fail after
  // the local cache succeeds; a later nonempty remote history must not hide that
  // local-only purchase. Remote rows win duplicate orderIds because they are the
  // durable database record, while other-account and guest rows remain excluded.
  const cached = cachedOrdersForIdentity(userEmailOrId);
  if (orders.length === 0) {
    return cached;
  }

  const remoteOrderIds = new Set(orders.map((order) => order.orderId));
  const localOnly = cached.filter((order) => !remoteOrderIds.has(order.orderId));
  return [...localOnly, ...orders];
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
