import { rpc, TransactionBuilder } from "@stellar/stellar-sdk";

import {
  CHECKOUT_CONTRACT_ID,
  NETWORK_PASSPHRASE,
  RPC_URL,
  TokenConfig,
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

export interface PayOptions {
  /** Price in dollars (USD), converted to token raw units internally. */
  amountUsd: number;
  /** Human-readable order id (any string), hashed to 32 bytes for the contract. */
  orderId: string;
  /** Buyer's Freighter public key. */
  publicKey: string;
  /** Token to pay with (defaults to the first supported token, USDC). */
  token?: TokenConfig;
  /** Called with human-readable progress updates. */
  onStatus?: (status: string) => void;
}

export interface PayResult {
  hash: string;
  status: string;
  receipt: PaymentReceipt;
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
  orderIdHex: string;
  amountRaw: bigint;
}

function status(s: string): void {
  console.log(`[stellar] ${s}`);
}

/**
 * Convert a USD amount to raw token units (7 decimals).
 * e.g. 12.34 -> 123_400_000
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
 * checkout contract to emit the exact token/order/amount receipt we intended.
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
 * Main flow: connect wallet -> readiness checks -> simulate -> prepare ->
 * sign -> submit -> wait -> decode + verify the exact payment receipt.
 */
export async function payWithStellar(options: PayOptions): Promise<PayResult> {
  const { amountUsd, orderId, publicKey, onStatus = status } = options;
  const token = options.token ?? defaultToken();

  if (!CHECKOUT_CONTRACT_ID) {
    throw new WalletError(
      "Checkout contract is not configured. Set NEXT_PUBLIC_CHECKOUT_CONTRACT_ID in .env.local.",
      "CONTRACT_NOT_CONFIGURED"
    );
  }

  const amountRaw = usdToRawUnits(amountUsd);
  const orderBytes = await hashOrderId(orderId);
  const orderIdHex = bytesToHex(orderBytes);

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

  // 3. Build the invocation.
  onStatus("Building payment transaction…");
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

  // 4. Pre-flight simulation (surfaces errors early) + prepare.
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
    orderIdHex,
    amountRaw,
  });

  return {
    hash: sendResponse.hash,
    status: txResult.status,
    receipt,
    amountUsd,
    amountRaw,
    simulation: {
      minResourceFeeStroops: report.minResourceFee?.toString() ?? "0",
      recommendedInclusionFeeStroops: fee,
      instructions: report.instructions ?? 0,
    },
  };
}
