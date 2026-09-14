import {
  createPaidBuyerOrderSnapshot,
  getCachedBuyerOrders,
  savePaidBuyerOrderOnce,
  type BuyerOrder,
  type OrderFulfillment,
  type OrderItem,
  type PaidOrderSnapshotInput,
} from "./buyer-orders";
import { supabase } from "./supabase";

type SessionUser = { id: string; email?: string | null };

type PersistedOrderRow = {
  order_id?: unknown;
  user_id?: unknown;
  user_email?: unknown;
  total?: unknown;
  payment_method?: unknown;
  token_symbol?: unknown;
  token_amount?: unknown;
  items?: unknown;
};

function canonicalItem(item: OrderItem) {
  return {
    id: item.id ?? null,
    name: item.name,
    price: Number(item.price),
    quantity: item.quantity ?? 1,
    img: item.img ?? null,
  };
}

function canonicalFulfillment(value?: OrderFulfillment) {
  if (!value) return null;
  return {
    firstName: value.firstName,
    lastName: value.lastName,
    email: value.email,
    address: value.address,
  };
}

function paidCommerceFingerprint(order: Pick<
  BuyerOrder,
  "orderId" | "total" | "paymentMethod" | "tokenSymbol" | "tokenAmount" | "items" | "fulfillment"
>): string {
  return JSON.stringify({
    orderId: order.orderId,
    total: Number(order.total),
    paymentMethod: order.paymentMethod,
    tokenSymbol: order.tokenSymbol ?? null,
    tokenAmount: order.tokenAmount == null ? null : Number(order.tokenAmount),
    items: order.items.map(canonicalItem),
    fulfillment: canonicalFulfillment(order.fulfillment),
  });
}

function parseRemoteItems(value: unknown): { items: OrderItem[]; fulfillment?: OrderFulfillment } {
  if (Array.isArray(value)) {
    return { items: value as OrderItem[] };
  }
  if (!value || typeof value !== "object") {
    return { items: [] };
  }

  const envelope = value as {
    schemaVersion?: unknown;
    lines?: unknown;
    fulfillment?: unknown;
  };
  if (envelope.schemaVersion !== 1 || !Array.isArray(envelope.lines)) {
    return { items: [] };
  }

  const fulfillment =
    envelope.fulfillment && typeof envelope.fulfillment === "object"
      ? (envelope.fulfillment as OrderFulfillment)
      : undefined;
  return { items: envelope.lines as OrderItem[], fulfillment };
}

function remoteCommerceOrder(row: PersistedOrderRow): BuyerOrder | null {
  if (typeof row.order_id !== "string" || typeof row.payment_method !== "string") {
    return null;
  }
  const total = Number(row.total);
  const tokenAmount = row.token_amount == null ? undefined : Number(row.token_amount);
  if (!Number.isFinite(total) || (tokenAmount !== undefined && !Number.isFinite(tokenAmount))) {
    return null;
  }

  const stored = parseRemoteItems(row.items);
  return {
    id: `remote-${row.order_id}`,
    orderId: row.order_id,
    userId: typeof row.user_id === "string" ? row.user_id : undefined,
    userEmail: typeof row.user_email === "string" ? row.user_email : undefined,
    createdAt: "",
    total,
    status: "Paid",
    paymentMethod: row.payment_method === "card" ? "card" : "stellar",
    tokenSymbol: typeof row.token_symbol === "string" ? row.token_symbol : undefined,
    tokenAmount,
    items: stored.items,
    fulfillment: stored.fulfillment,
  };
}

function storedEnvelope(order: BuyerOrder) {
  return {
    schemaVersion: 1,
    lines: order.items.map((item) => ({ ...item })),
    fulfillment: order.fulfillment ? { ...order.fulfillment } : undefined,
  };
}

async function resolveSessionUser(): Promise<SessionUser | null> {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw new Error(error.message || "Could not resolve order ownership");
  const user = data?.session?.user;
  return user ? { id: user.id, email: user.email ?? null } : null;
}

async function readOwnedRemoteOrder(orderId: string, userId: string): Promise<BuyerOrder | null> {
  const { data, error } = await supabase
    .from("orders")
    .select("*")
    .eq("order_id", orderId)
    .maybeSingle();
  if (error) throw new Error(error.message || "Could not verify persisted paid order");
  if (!data) return null;
  if (data.user_id !== userId) {
    throw new Error("Persisted paid order ownership does not match the active session");
  }
  return remoteCommerceOrder(data as PersistedOrderRow);
}

/**
 * Checkout-specific paid-order persistence boundary.
 *
 * Guest purchases keep the existing explicit device-local semantics. For an
 * authenticated buyer, merchant fulfillment durability is server-side: a local
 * cache can help recovery but can never authorize paid-cart teardown.
 *
 * The orders table has a unique order_id. If an insert reports an error, we
 * resolve that unique row through owner-RLS and accept it only when its commerce
 * fingerprint exactly matches the confirmed snapshot. This makes retries safe
 * both for ordinary duplicate callbacks and for ambiguous "write committed,
 * response lost" failures without allowing a conflicting order-id reuse.
 */
export async function saveCheckoutPaidOrder(
  input: PaidOrderSnapshotInput
): Promise<BuyerOrder> {
  const candidate = createPaidBuyerOrderSnapshot(input);
  const localExisting = getCachedBuyerOrders().find(
    (order) => order.orderId === candidate.orderId
  );
  if (
    localExisting &&
    ["Paid", "Shipped", "Refunded", "Completed"].includes(localExisting.status) &&
    paidCommerceFingerprint(localExisting) !== paidCommerceFingerprint(candidate)
  ) {
    throw new Error("Paid order id already has conflicting commerce evidence");
  }

  const sessionUser = await resolveSessionUser();
  if (!sessionUser) {
    return savePaidBuyerOrderOnce(input);
  }

  const signedCandidate: BuyerOrder = {
    ...candidate,
    userId: sessionUser.id,
    userEmail: sessionUser.email || undefined,
  };

  const row = {
    order_id: signedCandidate.orderId,
    user_id: sessionUser.id,
    user_email: sessionUser.email || null,
    total: signedCandidate.total,
    status: signedCandidate.status,
    payment_method: signedCandidate.paymentMethod,
    token_symbol: signedCandidate.tokenSymbol || null,
    token_amount: signedCandidate.tokenAmount || null,
    tx_hash: signedCandidate.txHash || null,
    items: storedEnvelope(signedCandidate),
    created_at: signedCandidate.createdAt,
  };

  const { error: insertError } = await supabase.from("orders").insert([row]);
  if (!insertError) {
    return signedCandidate;
  }

  let remoteExisting: BuyerOrder | null = null;
  try {
    remoteExisting = await readOwnedRemoteOrder(signedCandidate.orderId, sessionUser.id);
  } catch (readError) {
    console.warn("Could not resolve paid-order insert failure against Supabase:", readError);
    throw new Error("Could not persist paid order details to merchant fulfillment");
  }

  if (!remoteExisting) {
    throw new Error("Could not persist paid order details to merchant fulfillment");
  }
  if (paidCommerceFingerprint(remoteExisting) !== paidCommerceFingerprint(signedCandidate)) {
    throw new Error("Paid order id already has conflicting merchant commerce evidence");
  }

  return signedCandidate;
}
