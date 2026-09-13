import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import {
  buildCheckoutQuoteMessage,
  centsToTokenRaw,
  signCheckoutQuote,
} from "../../lib/checkout-quote-signing";
import {
  TESTNET_NATIVE_ASSET_CONTRACT_ID,
  TESTNET_USDC_CONTRACT_ID,
  TESTNET_USDC_ISSUER,
} from "../../lib/stellar/config";

const keypair = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7));
const baseTerms = {
  contractId: TESTNET_NATIVE_ASSET_CONTRACT_ID,
  orderId: "SS-merchant-authority-fixture-1",
  buyerPublicKey: TESTNET_USDC_ISSUER,
  tokenContractId: TESTNET_USDC_CONTRACT_ID,
  amountRaw: 123_400_000n,
  expiresAt: 1_800_000_000,
};

describe("checkout quote signing", () => {
  it("converts exact cents to 7-decimal token units without floating point", () => {
    expect(centsToTokenRaw(1234, 7)).toBe(123_400_000n);
  });

  it("signs the exact canonical quote bytes with Ed25519", () => {
    const signed = signCheckoutQuote(baseTerms, keypair.secret());
    const message = buildCheckoutQuoteMessage(baseTerms);

    expect(signed.signatureHex).toHaveLength(128);
    expect(signed.signerPublicKey).toBe(keypair.publicKey());
    expect(keypair.verify(message, Buffer.from(signed.signatureHex, "hex"))).toBe(true);
  });

  it.each([
    ["contract", { contractId: TESTNET_USDC_CONTRACT_ID }],
    ["order", { orderId: "SS-merchant-authority-fixture-2" }],
    ["buyer", { buyerPublicKey: Keypair.fromRawEd25519Seed(Buffer.alloc(32, 9)).publicKey() }],
    ["token", { tokenContractId: TESTNET_NATIVE_ASSET_CONTRACT_ID }],
    ["amount", { amountRaw: 123_400_001n }],
    ["expiry", { expiresAt: baseTerms.expiresAt + 1 }],
  ])("invalidates a signature when %s is changed", (_field, changed) => {
    const signed = signCheckoutQuote(baseTerms, keypair.secret());
    const tamperedMessage = buildCheckoutQuoteMessage({ ...baseTerms, ...changed });

    expect(keypair.verify(tamperedMessage, Buffer.from(signed.signatureHex, "hex"))).toBe(false);
  });

  it("fails closed when the signing secret is absent", () => {
    expect(() => signCheckoutQuote(baseTerms, "")).toThrow(/not configured/i);
  });
});
