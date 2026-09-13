import {
  Account,
  Keypair,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import {
  NETWORK_PASSPHRASE,
  defaultToken,
} from "../../../lib/stellar/config";
import { WalletError } from "../../../lib/stellar/freighter";
import { parsePreparedQuoteResponse } from "../../../lib/stellar/quote-client";

const BUYER = Keypair.random().publicKey();
const OTHER = Keypair.random().publicKey();
const ORDER_HEX = "11".repeat(32);

function validXdr(): string {
  return new TransactionBuilder(new Account(BUYER, "1"), {
    fee: "100",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(Operation.manageData({ name: "quote-test", value: "1" }))
    .setTimeout(0)
    .build()
    .toXDR();
}

function payload(overrides: Record<string, unknown> = {}) {
  const token = defaultToken();
  return {
    quote: {
      orderId: "server-generated-order",
      orderIdHex: ORDER_HEX,
      buyer: BUYER,
      tokenContractId: token.contractId,
      tokenSymbol: token.symbol,
      amountRaw: "123400000",
      authValidUntilLedger: 123456,
      transactionXdr: validXdr(),
      ...overrides,
    },
  };
}

function codeFor(value: unknown, buyer = BUYER): string | undefined {
  try {
    parsePreparedQuoteResponse(value, buyer);
    return undefined;
  } catch (error) {
    return error instanceof WalletError ? error.code : undefined;
  }
}

describe("prepared merchant quote response", () => {
  it("preserves the exact server-bound identity and raw amount", () => {
    const parsed = parsePreparedQuoteResponse(payload(), BUYER);
    expect(parsed.orderId).toBe("server-generated-order");
    expect(parsed.orderIdHex).toBe(ORDER_HEX);
    expect(parsed.buyer).toBe(BUYER);
    expect(parsed.amountRaw).toBe(BigInt("123400000"));
  });

  it("rejects a quote bound to another buyer", () => {
    expect(codeFor(payload({ buyer: OTHER }))).toBe("QUOTE_BUYER_MISMATCH");
  });

  it("rejects a quote for another token", () => {
    expect(codeFor(payload({ tokenContractId: "CFAKE" }))).toBe("QUOTE_TOKEN_MISMATCH");
  });

  it("rejects zero, negative, decimal, and non-numeric raw amounts", () => {
    for (const amountRaw of ["0", "-1", "1.5", "12x", ""]) {
      expect(codeFor(payload({ amountRaw }))).toBe("QUOTE_AMOUNT_INVALID");
    }
  });

  it("rejects malformed order hashes and authorization ledgers", () => {
    expect(codeFor(payload({ orderIdHex: "abcd" }))).toBe("QUOTE_RESPONSE_INVALID");
    expect(codeFor(payload({ authValidUntilLedger: 0 }))).toBe("QUOTE_RESPONSE_INVALID");
    expect(codeFor(payload({ authValidUntilLedger: 1.5 }))).toBe("QUOTE_RESPONSE_INVALID");
  });

  it("rejects invalid transaction XDR before opening the wallet", () => {
    expect(codeFor(payload({ transactionXdr: "not-xdr" }))).toBe("QUOTE_RESPONSE_INVALID");
  });
});
