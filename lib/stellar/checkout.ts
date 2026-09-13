import { rpc, TransactionBuilder } from "@stellar/stellar-sdk";

import {
  CHECKOUT_CONTRACT_ID,
  NETWORK_PASSPHRASE,
  RPC_URL,
  defaultToken,
  USDC_DECIMALS,
} from "./config";
import { ensureNetwork, signWithFreighter, WalletError } from "./freighter";
import { decodePaymentEvent, PaymentReceipt, waitForTransaction } from "./events";
import {
  addressToScVal,
  bytes32ToScVal,
  bytes64ToScVal,
  bytesToHex,
  hashOrderId,
  i128ToScVal,
  u64ToScVal,
} from "./scval";
import { assertPaymentReady } from "./account";
import { buildInvocationTransaction, budgetFee, prepareAndReport } from "./simulate";

export { fundTestnetAccount } from "./account";

export interface SignedCheckoutQuote {
  amountCents: number;
  amountRaw: string;
  itemCount: number;
  orderId: string;
  buyerPublicKey: string;
  tokenContractId: string;
  contractId: string;
  expiresAt: number;
  signatureHex: string;
}

export interface PayOptions {
  /** Exact merchant-signed quote returned by /api/checkout/quote. */
  quote: SignedCheckoutQuote;
  /** Human-readable order id; must match the signed quote. */
  orderId: string;
  /** Buyer's Freighter public key; must match the signed quote. */
  publicKey: string;
  /** Called with human-readable progress updates. */
  onStatus?: (status: string) => void;
}

export interface PayResult {
  hash: string;
  status: string;
  receipt: PaymentReceipt;
  amountUsd: number;
  amountRaw: bigint;
  quote: SignedCheckoutQuote;
  simulation: {
    minResourceFeeStroops: string;
    recommendedInclusionFeeStroops: string;
    instructions: number;
  };
}

export interface ExpectedPaymentReceipt {
  contractId: string;
  tokenContractId: string;
  orderIdHex: string;
  amountRaw: bigint;
}

function status(s: string): void {
  console.log(`[stellar] ${s}`);
}

/** Legacy display helper only. Payment construction no longer accepts USD. */
export function usdToRawUnits(amountUsd: number): bigint {
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    throw new WalletError("Invalid amount to pay.", "INVALID_AMOUNT");
  }
  const raw = Math.round(amountUsd * 10 ** USDC_DECIMALS);
  return BigInt(raw);
}

export async function orderIdHash(orderId: string): Promise<string> {
  return bytesToHex(await hashOrderId(orderId));
}

function quoteError(message: string): WalletError {
  return new WalletError(message, "INVALID_MERCHANT_QUOTE");
}

function validateSignedQuote(
  value: unknown,
  productIds: string[],
  orderId: string,
  buyerPublicKey: string
): SignedCheckoutQuote {
  if (!value || typeof value !== "object") {
    throw quoteError("Merchant quote response was malformed.");
  }
  const quote = value as Partial<SignedCheckoutQuote>;
  const token = defaultToken();

  if (
    quote.orderId !== orderId ||
    quote.buyerPublicKey !== buyerPublicKey ||
    quote.contractId !== CHECKOUT_CONTRACT_ID ||
    quote.tokenContractId !== token.contractId
  ) {
    throw quoteError("Merchant quote was not bound to this checkout session.");
  }
  if (!Number.isSafeInteger(quote.amountCents) || Number(quote.amountCents) <= 0) {
    throw quoteError("Merchant quote contained an invalid amount.");
  }
  if (!Number.isSafeInteger(quote.itemCount) || quote.itemCount !== productIds.length) {
    throw quoteError("Merchant quote did not cover the complete cart.");
  }
  if (!Number.isSafeInteger(quote.expiresAt) || Number(quote.expiresAt) <= Math.floor(Date.now() / 1000)) {
    throw quoteError("Merchant quote has expired.");
  }
  if (typeof quote.signatureHex !== "string" || !/^[0-9a-f]{128}$/i.test(quote.signatureHex)) {
    throw quoteError("Merchant quote signature was malformed.");
  }

  let amountRaw: bigint;
  try {
    amountRaw = BigInt(String(quote.amountRaw));
  } catch {
    throw quoteError("Merchant quote contained an invalid raw amount.");
  }
  const expectedRaw = BigInt(Number(quote.amountCents)) * 10n ** BigInt(token.decimals - 2);
  if (amountRaw <= 0n || amountRaw !== expectedRaw) {
    throw quoteError("Merchant quote amount was internally inconsistent.");
  }

  return quote as SignedCheckoutQuote;
}

/** Request a short-lived merchant-signed quote for this exact cart and buyer. */
export async function fetchSignedCheckoutQuote(input: {
  productIds: string[];
  orderId: string;
  buyerPublicKey: string;
}): Promise<SignedCheckoutQuote> {
  if (!CHECKOUT_CONTRACT_ID) {
    throw new WalletError(
      "Checkout contract is not configured. Set NEXT_PUBLIC_CHECKOUT_CONTRACT_ID in .env.local.",
      "CONTRACT_NOT_CONFIGURED"
    );
  }
  if (!Array.isArray(input.productIds) || input.productIds.length === 0) {
    throw quoteError("Cart does not contain any products to quote.");
  }

  const response = await fetch("/api/checkout/quote", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify(input),
  });

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw quoteError("Merchant quote service returned an unreadable response.");
  }

  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
        ? payload.error
        : "Merchant quote service rejected this cart.";
    throw quoteError(message);
  }

  return validateSignedQuote(payload, input.productIds, input.orderId, input.buyerPublicKey);
}

/** Successful transaction status alone is not payment authority. */
export function assertExactPaymentReceipt(
  receipt: PaymentReceipt | null,
  expected: ExpectedPaymentReceipt
): PaymentReceipt {
  if (!receipt) {
    throw new WalletError(
      "Transaction succeeded but no checkout payment receipt was found.",
      "PAYMENT_RECEIPT_MISSING"
    );
  }

  let actualAmount: bigint;
  try {
    actualAmount = BigInt(receipt.amount ?? "");
  } catch {
    throw new WalletError(
      "Transaction payment receipt contained an invalid amount.",
      "PAYMENT_RECEIPT_MISMATCH"
    );
  }

  const exactMatch =
    receipt.contractId === expected.contractId &&
    receipt.token === expected.tokenContractId &&
    receipt.orderId?.toLowerCase() === expected.orderIdHex.toLowerCase() &&
    actualAmount === expected.amountRaw;

  if (!exactMatch) {
    throw new WalletError(
      "Transaction succeeded but the checkout payment receipt did not match this order.",
      "PAYMENT_RECEIPT_MISMATCH"
    );
  }

  return receipt;
}

/**
 * Main flow: validate signed merchant terms -> readiness -> simulate -> sign ->
 * submit -> wait -> decode + verify the exact payment receipt.
 */
export async function payWithStellar(options: PayOptions): Promise<PayResult> {
  const { quote, orderId, publicKey, onStatus = status } = options;
  const token = defaultToken();
  const validated = validateSignedQuote(quote, new Array(quote.itemCount).fill("quoted"), orderId, publicKey);
  const amountRaw = BigInt(validated.amountRaw);
  const orderBytes = await hashOrderId(orderId);
  const orderIdHex = bytesToHex(orderBytes);

  onStatus("Checking Freighter network…");
  await ensureNetwork();

  const server = new rpc.Server(RPC_URL);

  onStatus("Checking account readiness…");
  const readiness = await assertPaymentReady(server, publicKey, {
    token,
    requiredRaw: amountRaw,
    strict: true,
  });

  onStatus("Building signed-quote payment transaction…");
  const args = [
    addressToScVal(token.contractId),
    addressToScVal(publicKey),
    bytes32ToScVal(orderBytes),
    i128ToScVal(amountRaw),
    u64ToScVal(validated.expiresAt),
    bytes64ToScVal(validated.signatureHex),
  ];
  const tx = buildInvocationTransaction(
    readiness.account!,
    CHECKOUT_CONTRACT_ID,
    "pay_with_quote",
    args
  );

  onStatus("Simulating transaction…");
  const { tx: prepared, report } = await prepareAndReport(server, tx);
  if (!report.ok || !readiness.account) {
    throw new WalletError(
      `Transaction simulation failed: ${report.error?.message ?? "unknown error"}`,
      "TX_SIMULATION_ERROR"
    );
  }
  const fee = await budgetFee(server, report);
  onStatus(
    `Estimated fee: ${report.minResourceFee?.toString() ?? "?"} stroops resource + ${fee} stroops total`
  );

  onStatus("Waiting for Freighter signature…");
  const signedXdr = await signWithFreighter(prepared.toXDR(), publicKey);
  const signedTx = TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE);

  onStatus("Submitting transaction…");
  const sendResponse = await server.sendTransaction(signedTx);

  if (sendResponse.status === "ERROR") {
    throw new WalletError(
      `Transaction rejected: ${sendResponse.errorResult?.toXDR("base64") ?? "unknown error"}`,
      "TX_SEND_ERROR"
    );
  }
  if (sendResponse.status === "PENDING" || sendResponse.status === "DUPLICATE") {
    onStatus("Confirming transaction…");
  }

  const txResult = await waitForTransaction(sendResponse.hash);
  const receipt = assertExactPaymentReceipt(decodePaymentEvent(txResult), {
    contractId: CHECKOUT_CONTRACT_ID,
    tokenContractId: token.contractId,
    orderIdHex,
    amountRaw,
  });

  return {
    hash: sendResponse.hash,
    status: txResult.status,
    receipt,
    amountUsd: validated.amountCents / 100,
    amountRaw,
    quote: validated,
    simulation: {
      minResourceFeeStroops: report.minResourceFee?.toString() ?? "0",
      recommendedInclusionFeeStroops: fee,
      instructions: report.instructions ?? 0,
    },
  };
}
