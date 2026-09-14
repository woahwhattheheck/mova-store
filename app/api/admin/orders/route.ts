import { NextResponse } from "next/server";
import { AdminAuthError, requireSignedAdmin } from "../../../../lib/server/admin-auth";
import {
  listMerchantOrders,
  reconcileStoredMerchantOrder,
} from "../../../../lib/server/merchant-order-index-store";
import { readOrder } from "../../../../lib/stellar/orders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store, max-age=0" } });
}

function parseLimit(url: string): number {
  const raw = new URL(url).searchParams.get("limit");
  if (!raw) return 100;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : 100;
}

async function reconcileWithBoundedConcurrency(rows: Awaited<ReturnType<typeof listMerchantOrders>>) {
  const output = new Array(rows.length);
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const index = cursor++;
      if (index >= rows.length) return;
      output[index] = await reconcileStoredMerchantOrder(rows[index], async (orderId) => {
        const chain = await readOrder(orderId);
        return chain
          ? {
              buyer: chain.buyer,
              tokenContractId: chain.token,
              amountRaw: chain.amount.toString(),
              status: chain.status,
              timestamp: chain.timestamp,
            }
          : null;
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(5, rows.length) }, () => worker()));
  return output;
}

export async function GET(request: Request) {
  try {
    await requireSignedAdmin(request);
    const rows = await listMerchantOrders(parseLimit(request.url));
    const orders = await reconcileWithBoundedConcurrency(rows);
    return json({
      source: "durable-quote-index+direct-contract-read",
      retentionIndependent: true,
      count: orders.length,
      orders,
    });
  } catch (error) {
    if (error instanceof AdminAuthError) return json({ error: error.message }, error.status);
    console.error("Durable merchant order index read failed", error);
    return json({ error: "Durable merchant order index is temporarily unavailable." }, 503);
  }
}
