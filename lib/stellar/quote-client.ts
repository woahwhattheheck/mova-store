import { rpc, TransactionBuilder } from "@stellar/stellar-sdk";

import type { QuoteRequestItem } from "../checkout-quote";
import {
  NETWORK_PASSPHRASE,
  RPC_URL,
  defaultToken,
} from "./config";
import { waitForTransaction } from "./events";
import { ensureNetwork, signWithFreighter, WalletError } from "./freighter";

export interface PreparedQuotePayload {
  orderId: string;
  orderIdHex: string;
  buyer: string;
  tokenContractId: string;
  tokenSymbol: string;
  amountRaw: bigint;
  authValidUntilLedger: number;
  transactionXdr: string;
}

export interface RegisteredQuote extends PreparedQuotePayload {
  registrationHash: string;
}

interface QuoteApiEnvelope {
  quote?: Record<string, unknown>;
  error?: unknown;
  code?: unknown;
}

const HEX_32_RE = /^[0-9a-f]{64}$/i;
const DECIMAL_UINT_RE = /^[1-9]\d*$/;

/**
 * Treat the same-origin quote endpoint as a typed boundary, not as trusted JS.
 * The browser never derives or substitutes an amount if any returned identity
 * field is malformed or disagrees with the requested buyer/default token.
 */
export function parsePreparedQuoteResponse(
  payload: unknown,
  expectedBuyer: string
): PreparedQuotePayload {
  if (!payload || typeof payload !== "object") {
    throw new WalletError("Merchant quote response was malformed.", "QUOTE_RESPONSE_INVALID");
  }

  const envelope = payload as QuoteApiEnvelope;
  const quote = envelope.quote;
  if (!quote || typeof quote !== "object") {
    throw new WalletError("Merchant quote response was missing a quote.", "QUOTE_RESPONSE_INVALID");
  }

  const orderId = typeof quote.orderId === "string" ? quote.orderId : "";
  const orderIdHex = typeof quote.orderIdHex === "string" ? quote.orderIdHex : "";
  const buyer = typeof quote.buyer === "string" ? quote.buyer : "";
  const tokenContractId =
    typeof quote.tokenContractId === "string" ? quote.tokenContractId : "";
  const tokenSymbol = typeof quote.tokenSymbol === "string" ? quote.tokenSymbol : "";
  const amountText = typeof quote.amountRaw === "string" ? quote.amountRaw : "";
  const transactionXdr =
    typeof quote.transactionXdr === "string" ? quote.transactionXdr : "";
  const authValidUntilLedger = quote.authValidUntilLedger;

  if (!orderId || orderId.length > 128 || !HEX_32_RE.test(orderIdHex)) {
    throw new WalletError("Merchant quote identity was invalid.", "QUOTE_RESPONSE_INVALID");
  }
  if (buyer !== expectedBuyer) {
    throw new WalletError("Merchant quote was bound to a different buyer.", "QUOTE_BUYER_MISMATCH");
  }

  const token = defaultToken();
  if (tokenContractId !== token.contractId || tokenSymbol !== token.symbol) {
    throw new WalletError("Merchant quote token did not match checkout.", "QUOTE_TOKEN_MISMATCH");
  }
  if (!DECIMAL_UINT_RE.test(amountText)) {
    throw new WalletError("Merchant quote amount was invalid.", "QUOTE_AMOUNT_INVALID");
  }
  const amountRaw = BigInt(amountText);
  if (amountRaw <= BigInt(0)) {
    throw new WalletError("Merchant quote amount was invalid.", "QUOTE_AMOUNT_INVALID");
  }
  if (
    typeof authValidUntilLedger !== "number" ||
    !Number.isSafeInteger(authValidUntilLedger) ||
    authValidUntilLedger <= 0
  ) {
    throw new WalletError(
      "Merchant quote authorization window was invalid.",
      "QUOTE_RESPONSE_INVALID"
    );
  }
  if (!transactionXdr) {
    throw new WalletError(
      "Merchant quote transaction was missing.",
      "QUOTE_RESPONSE_INVALID"
    );
  }

  // Parse before opening Freighter so corrupt/non-network XDR fails closed.
  try {
    TransactionBuilder.fromXDR(transactionXdr, NETWORK_PASSPHRASE);
  } catch {
    throw new WalletError(
      "Merchant quote transaction was invalid for this network.",
      "QUOTE_RESPONSE_INVALID"
    );
  }

  return {
    orderId,
    orderIdHex: orderIdHex.toLowerCase(),
    buyer,
    tokenContractId,
    tokenSymbol,
    amountRaw,
    authValidUntilLedger,
    transactionXdr,
  };
}

/**
 * Ask the merchant server for an authoritative quote, then have the buyer wallet
 * sign and submit the already merchant-authorized quote-registration XDR. The
 * buyer is the transaction source and pays the network fee; this helper never
 * re-computes or accepts a browser price/total.
 */
export async function registerMerchantQuoteFromWallet(options: {
  publicKey: string;
  items: QuoteRequestItem[];
  onStatus?: (status: string) => void;
}): Promise<RegisteredQuote> {
  const { publicKey, items, onStatus = () => undefined } = options;

  await ensureNetwork();
  onStatus("Requesting merchant-authorized quote…");

  const response = await fetch("/api/checkout/quote", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify({ buyer: publicKey, items }),
  });

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // Handled below as an invalid/unavailable merchant quote response.
  }

  if (!response.ok) {
    const body = payload && typeof payload === "object" ? (payload as QuoteApiEnvelope) : null;
    const message =
      typeof body?.error === "string"
        ? body.error
        : "Merchant quote service rejected this checkout.";
    const code = typeof body?.code === "string" ? body.code : "QUOTE_REQUEST_FAILED";
    throw new WalletError(message, code);
  }

  const quote = parsePreparedQuoteResponse(payload, publicKey);
  onStatus("Authorizing merchant quote registration…");
  const signedXdr = await signWithFreighter(quote.transactionXdr, publicKey);
  const signed = TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE);

  const server = new rpc.Server(RPC_URL);
  onStatus("Registering merchant quote on Stellar…");
  const sent = await server.sendTransaction(signed);
  if (sent.status === "ERROR") {
    throw new WalletError("Merchant quote registration was rejected.", "QUOTE_SUBMISSION_FAILED");
  }
  if (sent.status === "TRY_AGAIN_LATER") {
    throw new WalletError(
      "Stellar is temporarily busy. Request a fresh merchant quote and retry.",
      "QUOTE_RETRY_REQUIRED"
    );
  }

  onStatus("Confirming merchant quote…");
  await waitForTransaction(sent.hash);

  return {
    ...quote,
    registrationHash: sent.hash,
  };
}
