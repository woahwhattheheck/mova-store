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
  bytesToHex,
  hashOrderId,
  i128ToScVal,
} from "./scval";
import { assertPaymentReady } from "./account";
import { buildInvocationTransaction, budgetFee, prepareAndReport } from "./simulate";

export { fundTestnetAccount } from "./account";

export interface MerchantAuthorizedPaymentQuote {
  orderId: string;
  orderIdHex: string;
  buyer: string;
  tokenContractId: string;
  amountRaw: bigint;
}

export interface PayOptions {
  /** Registered merchant quote returned by the same-origin quote flow. */
  quote: MerchantAuthorizedPaymentQuote;
  /** Buyer's Freighter public key; must exactly match quote.buyer. */
  publicKey: string;
  /** Called with human-readable progress updates. */
  onStatus?: (status: string) => void;
}

export interface PayResult {
  hash: string;
  status: string;
  receipt: PaymentReceipt;
  orderId: string;
  buyer: string;
  amountUsd: number;
  amountRaw: bigint;
  /** Pre-flight simulation details (see lib/stellar/simulate.ts). */
  simulation: {
    minResourceFeeStroops: string;
    recommendedInclusionFeeStroops: string;
    instructions: number;
  };
}

export interface ExpectedPaymentReceipt {
  contractId: string;
  tokenContractId: string;
  buyer: string;
  orderIdHex: string;
  amountRaw: bigint;
}

function status(s: string): void {
  console.log(`[stellar] ${s}`);
}

/**
 * Convert a USD amount to raw token units (7 decimals).
 * Kept for display/test callers; live checkout payment authority uses the raw
 * amount from a registered merchant quote instead.
 */
export function usdToRawUnits(amountUsd: number): bigint {
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    throw new WalletError("Invalid amount to pay.", "INVALID_AMOUNT");
  }
  const raw = Math.round(amountUsd * 10 ** USDC_DECIMALS);
  return BigInt(raw);
}

/**
 * Round-trip an order id string through its 32-byte hash (hex) so callers can
 * cross-check on-chain order ids with their own order numbers.
 */
export async function orderIdHash(orderId: string): Promise<string> {
  return bytesToHex(await hashOrderId(orderId));
}

/**
 * Successful transaction status alone is not payment authority. Require the
 * checkout contract to emit the exact buyer/token/order/amount receipt intended
 * by the merchant-authorized quote.
 */
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
    receipt.buyer === expected.buyer &&
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
 * Main flow: validate registered merchant quote -> readiness checks -> simulate
 * -> sign -> submit -> decode + verify the exact payment receipt.
 *
 * Browser price/total fields are intentionally absent from this API. The raw
 * amount and order identity come only from the quote that was registered by the
 * merchant-authorized create_quote flow; the contract independently enforces
 * that same pending tuple before transferring tokens.
 */
export async function payWithStellar(options: PayOptions): Promise<PayResult> {
  const { quote, publicKey, onStatus = status } = options;
  const token = defaultToken();

  if (!CHECKOUT_CONTRACT_ID) {
    throw new WalletError(
      "Checkout contract is not configured. Set NEXT_PUBLIC_CHECKOUT_CONTRACT_ID in .env.local.",
      "CONTRACT_NOT_CONFIGURED"
    );
  }
  if (!quote || quote.buyer !== publicKey) {
    throw new WalletError(
      "Merchant quote was not authorized for this buyer.",
      "QUOTE_BUYER_MISMATCH"
    );
  }
  if (quote.tokenContractId !== token.contractId) {
    throw new WalletError(
      "Merchant quote token did not match checkout.",
      "QUOTE_TOKEN_MISMATCH"
    );
  }
  if (typeof quote.amountRaw !== "bigint" || quote.amountRaw <= BigInt(0)) {
    throw new WalletError("Merchant quote amount was invalid.", "QUOTE_AMOUNT_INVALID");
  }
  if (!quote.orderId || !/^[0-9a-f]{64}$/i.test(quote.orderIdHex)) {
    throw new WalletError("Merchant quote order identity was invalid.", "QUOTE_ORDER_MISMATCH");
  }

  const amountRaw = quote.amountRaw;
  const orderBytes = await hashOrderId(quote.orderId);
  const orderIdHex = bytesToHex(orderBytes);
  if (orderIdHex.toLowerCase() !== quote.orderIdHex.toLowerCase()) {
    throw new WalletError(
      "Merchant quote order hash did not match its order identity.",
      "QUOTE_ORDER_MISMATCH"
    );
  }

  // 1. Network guard.
  onStatus("Checking Freighter network…");
  await ensureNetwork();

  const server = new rpc.Server(RPC_URL);

  // 2. Account readiness: funded, trustline present, balance sufficient.
  onStatus("Checking account readiness…");
  const readiness = await assertPaymentReady(server, publicKey, {
    token,
    requiredRaw: amountRaw,
    strict: true,
  });

  // 3. Build the invocation from the exact registered quote tuple.
  onStatus("Building quoted payment transaction…");
  const args = [
    addressToScVal(token.contractId),
    addressToScVal(publicKey),
    bytes32ToScVal(orderBytes),
    i128ToScVal(amountRaw),
  ];
  const tx = buildInvocationTransaction(
    readiness.account!,
    CHECKOUT_CONTRACT_ID,
    "pay",
    args
  );

  // 4. Pre-flight simulation (also proves the pending quote exists) + prepare.
  onStatus("Simulating quoted transaction…");
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

  // 5. Sign with Freighter.
  onStatus("Waiting for Freighter signature…");
  const signedXdr = await signWithFreighter(prepared.toXDR(), publicKey);
  const signedTx = TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE);

  // 6. Submit.
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

  // 7. Wait for final state, then bind success to the exact payment event.
  const txResult = await waitForTransaction(sendResponse.hash);
  const receipt = assertExactPaymentReceipt(decodePaymentEvent(txResult), {
    contractId: CHECKOUT_CONTRACT_ID,
    tokenContractId: token.contractId,
    buyer: publicKey,
    orderIdHex,
    amountRaw,
  });

  return {
    hash: sendResponse.hash,
    status: txResult.status,
    receipt,
    orderId: quote.orderId,
    buyer: publicKey,
    amountUsd: Number(amountRaw) / 10 ** USDC_DECIMALS,
    amountRaw,
    simulation: {
      minResourceFeeStroops: report.minResourceFee?.toString() ?? "0",
      recommendedInclusionFeeStroops: fee,
      instructions: report.instructions ?? 0,
    },
  };
}
