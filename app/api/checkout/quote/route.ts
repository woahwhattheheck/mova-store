import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { StrKey } from "@stellar/stellar-sdk";
import { NextResponse } from "next/server";

import { committedOrderId } from "@/lib/checkout/quote-commitment.server";
import {
  deriveMerchantQuote,
  normalizeCartLines,
  type CanonicalProduct,
} from "@/lib/checkout/merchant-quote";
import { defaultToken } from "@/lib/stellar/config";
import { issueMerchantAuthorizedOrder } from "@/lib/stellar/merchant-order";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("request body must be valid JSON", 400);
  }

  if (!body || typeof body !== "object") {
    return errorResponse("request body must be an object", 400);
  }

  const candidate = body as {
    buyer?: unknown;
    tokenContractId?: unknown;
    lines?: unknown;
  };

  if (typeof candidate.buyer !== "string" || !StrKey.isValidEd25519PublicKey(candidate.buyer)) {
    return errorResponse("buyer must be a valid Stellar public key", 400);
  }

  // Catalog prices are USD. Until an oracle-backed conversion is introduced,
  // merchant-authoritative quotes intentionally support only the configured
  // USDC payment token; accepting XLM here would create a new client-priced FX
  // trust boundary.
  const quotedToken = defaultToken();
  const requestedToken =
    typeof candidate.tokenContractId === "string"
      ? candidate.tokenContractId.trim()
      : quotedToken.contractId;
  if (!requestedToken || requestedToken !== quotedToken.contractId) {
    return errorResponse("merchant quotes currently support only configured USDC", 400);
  }

  let lines;
  try {
    lines = normalizeCartLines(candidate.lines);
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : "invalid cart", 400);
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  if (!supabaseUrl || !supabaseAnonKey) {
    return errorResponse("catalog service is not configured", 503);
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });

  // Only product identity + canonical price cross the pricing boundary. Client
  // item names, prices and localStorage totals are deliberately ignored.
  const productIds = lines.map((line) => line.productId);
  const { data, error } = await supabase
    .from("products")
    .select("id,name,price")
    .in("id", productIds);

  if (error) {
    return errorResponse("could not read canonical product catalog", 503);
  }

  let quote;
  try {
    const provisional = deriveMerchantQuote({
      lines,
      products: (data ?? []) as CanonicalProduct[],
      buyer: candidate.buyer,
      tokenContractId: quotedToken.contractId,
      orderId: "MQ-pending-commitment",
      quoteNonce: randomUUID(),
      nowSeconds: Math.floor(Date.now() / 1000),
    });

    const { orderId: _provisionalOrderId, ...commitmentFields } = provisional;
    quote = { ...provisional, orderId: committedOrderId(commitmentFields) };
  } catch (error) {
    return errorResponse(
      error instanceof Error ? error.message : "could not derive merchant quote",
      400
    );
  }

  try {
    const submission = await issueMerchantAuthorizedOrder(quote);
    return NextResponse.json(
      {
        ...quote,
        quoteTxHash: submission.hash,
        quoteLedger: submission.ledger,
      },
      {
        status: 201,
        headers: {
          "Cache-Control": "no-store",
        },
      }
    );
  } catch {
    // Deliberately avoid exposing signing-key, RPC or simulation detail to the
    // browser. Operational logs can diagnose the server-side cause.
    return errorResponse("merchant could not authorize this quote", 503);
  }
}
