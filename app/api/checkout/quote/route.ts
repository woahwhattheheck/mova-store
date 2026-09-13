import { Address } from "@stellar/stellar-sdk";
import { NextResponse } from "next/server";

import { PRODUCTS_TABLE } from "@/lib/collections";
import {
  buildCatalogQuote,
  CheckoutQuoteError,
  normalizeProductIds,
  type CatalogPriceRow,
} from "@/lib/checkout-quote";
import {
  centsToTokenRaw,
  CHECKOUT_QUOTE_TTL_SECONDS,
  signCheckoutQuote,
} from "@/lib/checkout-quote-signing";
import { CHECKOUT_CONTRACT_ID, defaultToken } from "@/lib/stellar/config";
import { supabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
};

function errorResponse(message: string, status: number) {
  return NextResponse.json({ error: message }, { status, headers: NO_STORE_HEADERS });
}

function parseBoundQuoteRequest(body: unknown) {
  if (!body || typeof body !== "object") {
    throw new CheckoutQuoteError("checkout quote request must be an object");
  }
  const input = body as {
    productIds?: unknown;
    orderId?: unknown;
    buyerPublicKey?: unknown;
  };

  const productIds = normalizeProductIds(input.productIds);
  if (typeof input.orderId !== "string" || !input.orderId.trim() || input.orderId.length > 256) {
    throw new CheckoutQuoteError("checkout order id is invalid");
  }
  if (typeof input.buyerPublicKey !== "string" || !input.buyerPublicKey.startsWith("G")) {
    throw new CheckoutQuoteError("checkout buyer public key is invalid");
  }
  try {
    // Parsing rejects malformed StrKey values. Requiring G... prevents a
    // contract address from masquerading as the buyer account.
    new Address(input.buyerPublicKey);
  } catch {
    throw new CheckoutQuoteError("checkout buyer public key is invalid");
  }

  return {
    productIds,
    orderId: input.orderId.trim(),
    buyerPublicKey: input.buyerPublicKey,
  };
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("checkout quote request must be valid JSON", 400);
  }

  let requestData: ReturnType<typeof parseBoundQuoteRequest>;
  try {
    requestData = parseBoundQuoteRequest(body);
  } catch (error) {
    const message = error instanceof CheckoutQuoteError
      ? error.message
      : "invalid checkout quote request";
    return errorResponse(message, 400);
  }

  if (!CHECKOUT_CONTRACT_ID) {
    return errorResponse("checkout contract is not configured", 503);
  }
  try {
    new Address(CHECKOUT_CONTRACT_ID);
  } catch {
    return errorResponse("checkout contract configuration is invalid", 503);
  }

  const token = defaultToken();
  try {
    new Address(token.contractId);
  } catch {
    return errorResponse("checkout token configuration is invalid", 503);
  }

  const uniqueIds = [...new Set(requestData.productIds)];
  const { data, error } = await supabase
    .from(PRODUCTS_TABLE)
    .select("id,price")
    .in("id", uniqueIds);

  if (error) {
    return errorResponse("catalog is temporarily unavailable", 503);
  }

  try {
    const catalog = buildCatalogQuote(
      requestData.productIds,
      (data || []) as CatalogPriceRow[]
    );
    const amountRaw = centsToTokenRaw(catalog.amountCents, token.decimals);
    const expiresAt = Math.floor(Date.now() / 1000) + CHECKOUT_QUOTE_TTL_SECONDS;
    const terms = {
      contractId: CHECKOUT_CONTRACT_ID,
      orderId: requestData.orderId,
      buyerPublicKey: requestData.buyerPublicKey,
      tokenContractId: token.contractId,
      amountRaw,
      expiresAt,
    };
    const { signatureHex } = signCheckoutQuote(terms);

    return NextResponse.json(
      {
        amountCents: catalog.amountCents,
        amountRaw: amountRaw.toString(),
        itemCount: catalog.itemCount,
        orderId: requestData.orderId,
        buyerPublicKey: requestData.buyerPublicKey,
        tokenContractId: token.contractId,
        contractId: CHECKOUT_CONTRACT_ID,
        expiresAt,
        signatureHex,
      },
      { status: 200, headers: NO_STORE_HEADERS }
    );
  } catch (quoteError) {
    const message = quoteError instanceof CheckoutQuoteError
      ? quoteError.message
      : "catalog could not quote this cart";
    const configurationError = message.includes("signing") || message.includes("configured");
    return errorResponse(message, configurationError ? 503 : 409);
  }
}
