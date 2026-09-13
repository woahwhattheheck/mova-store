import { rpc, TransactionBuilder } from "@stellar/stellar-sdk";

import type { MerchantQuote } from "./merchant-quote-client";
import { assertPaymentReady } from "./account";
import {
  CHECKOUT_CONTRACT_ID,
  NETWORK_PASSPHRASE,
  RPC_URL,
  tokenForContract,
} from "./config";
import { decodePaymentEvent, PaymentReceipt, waitForTransaction } from "./events";
import { ensureNetwork, signWithFreighter, WalletError } from "./freighter";
import {
  addressToScVal,
  bytes32ToScVal,
  bytesToHex,
  hashOrderId,
  i128ToScVal,
} from "./scval";
import { buildInvocationTransaction, budgetFee, prepareAndReport } from "./simulate";

export interface MerchantQuotePayOptions {
  quote: MerchantQuote;
  publicKey: string;
  onStatus?: (status: string) => void;
}

export interface MerchantQuotePayResult {
  hash: string;
  status: string;
  receipt: PaymentReceipt;
  amountUsd: string;
  amountRaw: bigint;
  quote: MerchantQuote;
  simulation: {
    minResourceFeeStroops: string;
    recommendedInclusionFeeStroops: string;
    instructions: number;
  };
}

function status(message: string): void {
  console.log(`[stellar] ${message}`);
}

function parseQuotedAmount(quote: MerchantQuote): bigint {
  try {
    const amount = BigInt(quote.amountRaw);
    if (amount <= 0n) throw new Error("non-positive");
    return amount;
  } catch {
    throw new WalletError("Merchant quote contained an invalid amount.", "INVALID_QUOTE");
  }
}

async function assertQuoteIntegrity(quote: MerchantQuote, publicKey: string): Promise<bigint> {
  if (!CHECKOUT_CONTRACT_ID) {
    throw new WalletError(
      "Checkout contract is not configured. Set NEXT_PUBLIC_CHECKOUT_CONTRACT_ID in .env.local.",
      "CONTRACT_NOT_CONFIGURED"
    );
  }
  if (quote.buyer !== publicKey) {
    throw new WalletError("Merchant quote belongs to a different wallet.", "QUOTE_BUYER_MISMATCH");
  }
  if (quote.expiresAt <= Math.floor(Date.now() / 1000)) {
    throw new WalletError("Merchant quote expired. Request a new quote.", "QUOTE_EXPIRED");
  }
  if (!tokenForContract(quote.tokenContractId)) {
    throw new WalletError("Merchant quote uses an unsupported payment token.", "QUOTE_TOKEN_MISMATCH");
  }

  const derivedOrderIdHex = bytesToHex(await hashOrderId(quote.orderId));
  if (derivedOrderIdHex.toLowerCase() !== quote.orderIdHex.toLowerCase()) {
    throw new WalletError("Merchant quote order id failed its integrity check.", "INVALID_QUOTE");
  }

  return parseQuotedAmount(quote);
}

function assertExactQuoteReceipt(
  receipt: PaymentReceipt | null,
  quote: MerchantQuote,
  amountRaw: bigint
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

  const matches =
    receipt.contractId === CHECKOUT_CONTRACT_ID &&
    receipt.token === quote.tokenContractId &&
    receipt.buyer === quote.buyer &&
    receipt.orderId?.toLowerCase() === quote.orderIdHex.toLowerCase() &&
    actualAmount === amountRaw;

  if (!matches) {
    throw new WalletError(
      "Transaction succeeded but its payment receipt did not match the merchant quote.",
      "PAYMENT_RECEIPT_MISMATCH"
    );
  }
  return receipt;
}

/**
 * Pay an already-registered merchant quote. Browser price/total fields never
 * enter this function: token, order id and raw amount all come from the quote
 * that the server registered on-chain before returning it to the buyer.
 */
export async function payMerchantQuote(
  options: MerchantQuotePayOptions
): Promise<MerchantQuotePayResult> {
  const { quote, publicKey, onStatus = status } = options;
  const amountRaw = await assertQuoteIntegrity(quote, publicKey);
  const token = tokenForContract(quote.tokenContractId)!;

  onStatus("Checking Freighter network…");
  await ensureNetwork();

  const server = new rpc.Server(RPC_URL);
  onStatus("Checking account readiness…");
  const readiness = await assertPaymentReady(server, publicKey, {
    token,
    requiredRaw: amountRaw,
    strict: true,
  });
  if (!readiness.account) {
    throw new WalletError("Unable to load the payment account.", "ACCOUNT_NOT_FOUND");
  }

  onStatus("Building quoted payment transaction…");
  const tx = buildInvocationTransaction(readiness.account, CHECKOUT_CONTRACT_ID, "pay", [
    addressToScVal(quote.tokenContractId),
    addressToScVal(publicKey),
    bytes32ToScVal(quote.orderIdHex),
    i128ToScVal(amountRaw),
  ]);

  onStatus("Simulating transaction…");
  const { tx: prepared, report } = await prepareAndReport(server, tx);
  if (!report.ok) {
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
  const sent = await server.sendTransaction(signedTx);
  if (sent.status === "ERROR") {
    throw new WalletError(
      `Transaction rejected: ${sent.errorResult?.toXDR("base64") ?? "unknown error"}`,
      "TX_SEND_ERROR"
    );
  }
  if (sent.status === "PENDING" || sent.status === "DUPLICATE") {
    onStatus("Confirming transaction…");
  }

  const finalTx = await waitForTransaction(sent.hash);
  const receipt = assertExactQuoteReceipt(decodePaymentEvent(finalTx), quote, amountRaw);

  return {
    hash: sent.hash,
    status: finalTx.status,
    receipt,
    amountUsd: quote.amountUsd,
    amountRaw,
    quote,
    simulation: {
      minResourceFeeStroops: report.minResourceFee?.toString() ?? "0",
      recommendedInclusionFeeStroops: fee,
      instructions: report.instructions ?? 0,
    },
  };
}
