import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

import {
  QuoteValidationError,
  normalizeQuoteItems,
  resolveCanonicalQuote,
} from "../../../../lib/checkout-quote";
import { defaultToken } from "../../../../lib/stellar/config";
import {
  MerchantQuoteError,
  prepareMerchantQuote,
} from "../../../../lib/stellar/merchant-quote";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store, max-age=0",
    },
  });
}

function quoteError(error: unknown) {
  if (error instanceof QuoteValidationError) {
    const status = error.code === "PRODUCT_NOT_FOUND" ? 409 : 400;
    return json({ error: error.message, code: error.code }, status);
  }

  if (error instanceof MerchantQuoteError) {
    const status =
      error.code === "CATALOG_NOT_SYNCHRONIZED" || error.code === "QUOTE_AMOUNT_MISMATCH"
        ? 409
        : error.code === "BUYER_SIGNER_COLLISION"
          ? 400
          : 503;
    const publicMessage =
      status === 409
        ? "Catalog pricing is being synchronized. Please retry shortly."
        : status === 400
          ? "Buyer account cannot be used for this quote."
          : "Merchant quote service is temporarily unavailable.";
    return json({ error: publicMessage, code: error.code }, status);
  }

  return json({ error: "Merchant quote service is temporarily unavailable." }, 503);
}

/**
 * Resolve a browser cart against canonical Supabase product rows and return a
 * Soroban transaction carrying only the merchant quote signer's bounded auth
 * entry. The buyer wallet remains the transaction source/fee payer and must
 * sign + submit the XDR before the pending quote exists on-chain.
 */
export async function POST(request: Request) {
  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Request body must be valid JSON." }, 400);
    }

    if (!body || typeof body !== "object") {
      return json({ error: "Invalid quote request." }, 400);
    }

    const record = body as Record<string, unknown>;
    const buyer = typeof record.buyer === "string" ? record.buyer.trim() : "";
    if (!buyer) {
      return json({ error: "A Stellar buyer account is required." }, 400);
    }

    // `normalizeQuoteItems` intentionally reads only productId + quantity.
    // Hostile browser `price`, `unitPrice`, `total`, and `amountRaw` fields are
    // ignored and never cross the merchant-authority boundary.
    const items = normalizeQuoteItems(record.items);

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!supabaseUrl || !supabaseAnonKey) {
      return json({ error: "Catalog service is not configured." }, 503);
    }

    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    });

    const ids = items.map((item) => item.productId);
    const { data, error } = await supabase
      .from("products")
      .select("id,price")
      .in("id", ids);
    if (error) {
      return json({ error: "Catalog service is temporarily unavailable." }, 503);
    }

    const quote = resolveCanonicalQuote(items, data ?? []);
    const orderId = crypto.randomUUID();
    const prepared = await prepareMerchantQuote({
      buyer,
      orderId,
      lines: quote.lines,
      amountRaw: quote.amountRaw,
    });
    const token = defaultToken();

    return json({
      quote: {
        orderId,
        orderIdHex: prepared.orderIdHex,
        buyer,
        tokenContractId: token.contractId,
        tokenSymbol: token.symbol,
        amountRaw: prepared.amountRaw.toString(),
        authValidUntilLedger: prepared.authValidUntilLedger,
        transactionXdr: prepared.transactionXdr,
      },
    });
  } catch (error) {
    return quoteError(error);
  }
}
