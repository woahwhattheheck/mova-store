import { createHash, randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { StrKey } from "@stellar/stellar-sdk";

import { PRODUCTS_TABLE } from "@/lib/collections";
import { normalizeRequestedCart, priceCartFromCatalog } from "@/lib/merchant-quote";
import { defaultToken } from "@/lib/stellar/config";
import { registerMerchantQuote } from "@/lib/stellar/merchant-quote-server";

export const runtime = "nodejs";

const QUOTE_TTL_SECONDS = 600;

type QuoteRequest = {
  buyer?: unknown;
  items?: unknown;
};

function catalogClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  if (!url || !anonKey) {
    throw new Error("Catalog service is not configured.");
  }
  return createClient(url, anonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as QuoteRequest;
    const buyer = String(body.buyer ?? "").trim();
    if (!StrKey.isValidEd25519PublicKey(buyer)) {
      return NextResponse.json({ error: "A valid Stellar buyer address is required." }, { status: 400 });
    }

    // This strips browser-controlled name/price/total fields before any quote
    // calculation and aggregates duplicate product ids deterministically.
    const requested = normalizeRequestedCart(body.items);
    const ids = requested.map((line) => line.id);

    const supabase = catalogClient();
    const { data, error } = await supabase
      .from(PRODUCTS_TABLE)
      .select("id,price")
      .in("id", ids);
    if (error) throw new Error(`Catalog lookup failed: ${error.message}`);

    const priced = priceCartFromCatalog(requested, data ?? []);
    const token = defaultToken();
    const orderId = `MQ-${randomUUID()}`;
    const orderDigest = createHash("sha256").update(orderId, "utf8").digest();
    const orderIdBytes = new Uint8Array(orderDigest);
    const expiresAt = Math.floor(Date.now() / 1000) + QUOTE_TTL_SECONDS;

    const registered = await registerMerchantQuote({
      buyer,
      orderIdBytes,
      tokenContractId: token.contractId,
      amountRaw: priced.amountRaw,
      expiresAt,
    });

    return NextResponse.json(
      {
        quote: {
          orderId,
          orderIdHex: orderDigest.toString("hex"),
          buyer,
          tokenContractId: token.contractId,
          amountRaw: priced.amountRaw.toString(),
          amountUsd: priced.amountUsd,
          expiresAt,
          lines: priced.lines,
          quoteTxHash: registered.hash,
        },
      },
      { status: 201 }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to create merchant quote.";
    const isInputError =
      message.startsWith("Cart ") ||
      message.startsWith("Invalid quantity") ||
      message.startsWith("Unknown product") ||
      message.startsWith("Invalid canonical catalog price") ||
      message.startsWith("Quoted amount");
    return NextResponse.json(
      { error: message },
      { status: isInputError ? 400 : 503 }
    );
  }
}
