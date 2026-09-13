import { createHash } from "node:crypto";

import { Keypair, xdr } from "@stellar/stellar-sdk";

import { CheckoutQuoteError } from "./checkout-quote";
import { addressToScVal, bytes32ToScVal, i128ToScVal } from "./stellar/scval";

const QUOTE_DOMAIN = Buffer.from("MOVA_STORE_CHECKOUT_QUOTE_V1", "utf8");
export const CHECKOUT_QUOTE_TTL_SECONDS = 5 * 60;

export type CheckoutQuoteTerms = {
  contractId: string;
  orderId: string;
  buyerPublicKey: string;
  tokenContractId: string;
  amountRaw: bigint;
  expiresAt: number;
};

function u64ToScVal(value: bigint | number | string): xdr.ScVal {
  const parsed = BigInt(value);
  if (parsed < 0n || parsed > 0xffffffffffffffffn) {
    throw new CheckoutQuoteError("checkout quote expiry is outside the u64 range");
  }
  return xdr.ScVal.scvU64(new xdr.Uint64(parsed));
}

function validateOrderId(orderId: string): string {
  const trimmed = orderId.trim();
  if (!trimmed || trimmed.length > 256) {
    throw new CheckoutQuoteError("checkout order id is invalid");
  }
  return trimmed;
}

function scValXdr(value: xdr.ScVal): Buffer {
  return Buffer.from(value.toXDR());
}

/**
 * Canonical bytes verified by the Soroban checkout contract.
 *
 * Keep this byte-for-byte aligned with `build_quote_message` in
 * `contracts/checkout/src/lib.rs`: domain separator followed by ScVal XDR for
 * contract, SHA-256(order id), buyer, token, raw amount, and expiry.
 */
export function buildCheckoutQuoteMessage(terms: CheckoutQuoteTerms): Buffer {
  const orderId = validateOrderId(terms.orderId);
  if (terms.amountRaw <= 0n) {
    throw new CheckoutQuoteError("checkout quote amount must be positive");
  }
  if (!Number.isSafeInteger(terms.expiresAt) || terms.expiresAt <= 0) {
    throw new CheckoutQuoteError("checkout quote expiry is invalid");
  }

  const orderHash = createHash("sha256").update(orderId, "utf8").digest();

  return Buffer.concat([
    QUOTE_DOMAIN,
    scValXdr(addressToScVal(terms.contractId)),
    scValXdr(bytes32ToScVal(orderHash)),
    scValXdr(addressToScVal(terms.buyerPublicKey)),
    scValXdr(addressToScVal(terms.tokenContractId)),
    scValXdr(i128ToScVal(terms.amountRaw)),
    scValXdr(u64ToScVal(terms.expiresAt)),
  ]);
}

/** Convert exact USD cents to a Stellar token's raw integer units. */
export function centsToTokenRaw(amountCents: number, decimals: number): bigint {
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
    throw new CheckoutQuoteError("checkout quote amount must be positive cents");
  }
  if (!Number.isInteger(decimals) || decimals < 2 || decimals > 18) {
    throw new CheckoutQuoteError("checkout token decimals are invalid");
  }
  return BigInt(amountCents) * 10n ** BigInt(decimals - 2);
}

export function signCheckoutQuote(
  terms: CheckoutQuoteTerms,
  secret = process.env.CHECKOUT_QUOTE_SIGNING_SECRET
): { signatureHex: string; signerPublicKey: string } {
  if (!secret) {
    throw new CheckoutQuoteError("checkout quote signing is not configured");
  }

  let keypair: Keypair;
  try {
    keypair = Keypair.fromSecret(secret);
  } catch {
    throw new CheckoutQuoteError("checkout quote signing key is invalid");
  }

  const signature = keypair.sign(buildCheckoutQuoteMessage(terms));
  return {
    signatureHex: Buffer.from(signature).toString("hex"),
    signerPublicKey: keypair.publicKey(),
  };
}
