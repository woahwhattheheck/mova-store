import { Keypair, rpc, xdr } from "@stellar/stellar-sdk";

import { CHECKOUT_CONTRACT_ID, RPC_URL } from "./config";
import { addressToScVal, bytes32ToScVal, i128ToScVal } from "./scval";
import { buildInvocationTransaction } from "./simulate";
import { waitForTransaction } from "./events";

export interface RegisterMerchantQuoteInput {
  buyer: string;
  orderIdBytes: Uint8Array;
  tokenContractId: string;
  amountRaw: bigint;
  expiresAt: number;
}

function u64ToScVal(value: number): xdr.ScVal {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Quote expiry must be a non-negative safe integer.");
  }
  return xdr.ScVal.scvU64(new xdr.Uint64(BigInt(value)));
}

/**
 * Register a merchant-authoritative pending quote on Soroban.
 *
 * Key custody: MOVA_QUOTE_SIGNER_SECRET is server-only and must never use a
 * NEXT_PUBLIC_ prefix. The corresponding public account is configured on the
 * checkout contract via `set_quote_signer`. Prefer a dedicated, minimally
 * funded operational signer instead of the merchant escrow/admin wallet.
 */
export async function registerMerchantQuote(
  input: RegisterMerchantQuoteInput
): Promise<{ hash: string; signerPublicKey: string }> {
  if (!CHECKOUT_CONTRACT_ID) {
    throw new Error("Checkout contract is not configured.");
  }

  const secret = process.env.MOVA_QUOTE_SIGNER_SECRET?.trim();
  if (!secret) {
    throw new Error("Merchant quote signer is not configured.");
  }

  let signer: Keypair;
  try {
    signer = Keypair.fromSecret(secret);
  } catch {
    throw new Error("Merchant quote signer secret is invalid.");
  }

  const server = new rpc.Server(RPC_URL);
  const account = await server.getAccount(signer.publicKey());
  const tx = buildInvocationTransaction(account, CHECKOUT_CONTRACT_ID, "create_quote", [
    addressToScVal(input.buyer),
    bytes32ToScVal(input.orderIdBytes),
    addressToScVal(input.tokenContractId),
    i128ToScVal(input.amountRaw),
    u64ToScVal(input.expiresAt),
  ]);

  const prepared = await server.prepareTransaction(tx);
  prepared.sign(signer);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR") {
    throw new Error("Merchant quote transaction was rejected.");
  }

  await waitForTransaction(sent.hash);
  return { hash: sent.hash, signerPublicKey: signer.publicKey() };
}
