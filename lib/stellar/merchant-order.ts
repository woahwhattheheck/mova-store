import "server-only";

import { Keypair, rpc, xdr } from "@stellar/stellar-sdk";

import type { MerchantQuote } from "../checkout/merchant-quote";
import {
  CHECKOUT_CONTRACT_ID,
  RPC_URL,
} from "./config";
import {
  addressToScVal,
  bytes32ToScVal,
  hashOrderId,
  i128ToScVal,
} from "./scval";
import { buildInvocationTransaction, prepareAndReport } from "./simulate";
import { waitForTransaction } from "./events";

export interface MerchantOrderSubmission {
  hash: string;
  ledger: number;
  merchantPublicKey: string;
}

function u64ToScVal(value: number): xdr.ScVal {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("expiresAt must be a non-negative safe integer");
  }
  return xdr.ScVal.scvU64(new xdr.Uint64(BigInt(value)));
}

/**
 * Create the immutable pending quote/order on-chain with merchant authority.
 *
 * Key custody rule: STELLAR_MERCHANT_SECRET_KEY is server-only. It must never
 * use a NEXT_PUBLIC_ prefix, be serialized into a response, or be logged.
 * This function is the only checkout-quote path that reads it.
 */
export async function issueMerchantAuthorizedOrder(
  quote: MerchantQuote
): Promise<MerchantOrderSubmission> {
  if (!CHECKOUT_CONTRACT_ID) {
    throw new Error("checkout contract is not configured");
  }

  const secret = process.env.STELLAR_MERCHANT_SECRET_KEY?.trim();
  if (!secret) {
    throw new Error("merchant signing key is not configured");
  }

  let merchant: Keypair;
  try {
    merchant = Keypair.fromSecret(secret);
  } catch {
    throw new Error("merchant signing key is invalid");
  }

  const server = new rpc.Server(RPC_URL);
  const account = await server.getAccount(merchant.publicKey());
  const orderBytes = await hashOrderId(quote.orderId);

  const tx = buildInvocationTransaction(
    account,
    CHECKOUT_CONTRACT_ID,
    "create_order",
    [
      addressToScVal(quote.buyer),
      bytes32ToScVal(orderBytes),
      addressToScVal(quote.tokenContractId),
      i128ToScVal(quote.amountRaw),
      u64ToScVal(quote.expiresAt),
    ]
  );

  const { tx: prepared, report } = await prepareAndReport(server, tx);
  if (!report.ok) {
    throw new Error(
      `merchant quote simulation failed: ${report.error?.message ?? "unknown contract error"}`
    );
  }

  prepared.sign(merchant);
  const sendResponse = await server.sendTransaction(prepared);
  if (sendResponse.status === "ERROR") {
    throw new Error("merchant-authorized quote transaction was rejected");
  }

  const result = await waitForTransaction(sendResponse.hash);
  return {
    hash: sendResponse.hash,
    ledger: result.ledger,
    merchantPublicKey: merchant.publicKey(),
  };
}
