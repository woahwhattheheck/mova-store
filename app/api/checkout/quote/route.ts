import { NextResponse } from "next/server";

import { PRODUCTS_TABLE } from "@/lib/collections";
import {
  buildCatalogQuote,
  CheckoutQuoteError,
  normalizeProductIds,
  type CatalogPriceRow,
} from "@/lib/checkout-quote";
import { supabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
};

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "checkout quote request must be valid JSON" },
      { status: 400, headers: NO_STORE_HEADERS }
    );
  }

  let productIds: string[];
  try {
    const candidate = body && typeof body === "object" && "productIds" in body
      ? (body as { productIds?: unknown }).productIds
      : undefined;
    productIds = normalizeProductIds(candidate);
  } catch (error) {
    const message = error instanceof CheckoutQuoteError ? error.message : "invalid checkout quote request";
    return NextResponse.json({ error: message }, { status: 400, headers: NO_STORE_HEADERS });
  }

  const uniqueIds = [...new Set(productIds)];
  const { data, error } = await supabase
    .from(PRODUCTS_TABLE)
    .select("id,price")
    .in("id", uniqueIds);

  if (error) {
    return NextResponse.json(
      { error: "catalog is temporarily unavailable" },
      { status: 503, headers: NO_STORE_HEADERS }
    );
  }

  try {
    const quote = buildCatalogQuote(productIds, (data || []) as CatalogPriceRow[]);
    return NextResponse.json(quote, { status: 200, headers: NO_STORE_HEADERS });
  } catch (quoteError) {
    const message = quoteError instanceof CheckoutQuoteError
      ? quoteError.message
      : "catalog could not quote this cart";
    return NextResponse.json({ error: message }, { status: 409, headers: NO_STORE_HEADERS });
  }
}
