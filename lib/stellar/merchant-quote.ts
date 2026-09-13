import {
  Address,
  Keypair,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";

import type { CanonicalQuoteLine } from "../checkout-quote";
import {
  CHECKOUT_CONTRACT_ID,
  RPC_URL,
  defaultToken,
} from "./config";
import { waitForTransaction } from "./events";
import {
  addressToScVal,
  bytes32ToScVal,
  bytesToHex,
  symbolToScVal,
} from "./scval";
import {
  buildInvocationTransaction,
  prepareAndReport,
  simulateContractRead,
} from "./simulate";

export class MerchantQuoteError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "MerchantQuoteError";
  }
}

export interface MerchantQuoteRegistration {
  buyer: string;
  orderId: string;
  lines: CanonicalQuoteLine[];
  amountRaw: bigint;
}

export interface RegisteredMerchantQuote {
  amountRaw: bigint;
  orderIdHex: string;
  expiresAt: number;
  transactionHash: string;
}

async function sha256Text(value: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return new Uint8Array(digest);
}

function quoteLineToScVal(productId: Uint8Array, quantity: number): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: symbolToScVal("product_id"),
      val: bytes32ToScVal(productId),
    }),
    new xdr.ScMapEntry({
      key: symbolToScVal("quantity"),
      val: xdr.ScVal.scvU32(quantity),
    }),
  ]);
}

/** Encode the Rust `Vec<QuoteLine>` contract type deterministically. */
export async function quoteLinesToScVal(lines: CanonicalQuoteLine[]): Promise<xdr.ScVal> {
  const encoded: xdr.ScVal[] = [];
  for (const line of lines) {
    encoded.push(quoteLineToScVal(await sha256Text(line.productId), line.quantity));
  }
  return xdr.ScVal.scvVec(encoded);
}

async function configuredQuoteSigner(server: rpc.Server): Promise<string> {
  const value = await simulateContractRead(server, CHECKOUT_CONTRACT_ID, "quote_signer", []);
  if (!value || value.switch() !== xdr.ScValType.scvAddress()) {
    throw new MerchantQuoteError(
      "QUOTE_SIGNER_NOT_CONFIGURED",
      "Checkout quote signer is not configured on-chain."
    );
  }
  return Address.fromScVal(value).toString();
}

async function assertCatalogMirror(
  server: rpc.Server,
  lines: CanonicalQuoteLine[],
  tokenContractId: string
): Promise<void> {
  for (const line of lines) {
    const productHash = await sha256Text(line.productId);
    const value = await simulateContractRead(
      server,
      CHECKOUT_CONTRACT_ID,
      "product_price",
      [bytes32ToScVal(productHash), addressToScVal(tokenContractId)]
    );

    if (!value || value.switch() === xdr.ScValType.scvVoid()) {
      throw new MerchantQuoteError(
        "CATALOG_NOT_SYNCHRONIZED",
        `Product ${line.productId} has no on-chain checkout price.`
      );
    }

    const onChainRaw = BigInt(scValToNative(value).toString());
    if (onChainRaw !== line.unitAmountRaw) {
      throw new MerchantQuoteError(
        "CATALOG_NOT_SYNCHRONIZED",
        `Product ${line.productId} differs between the canonical catalog and checkout contract.`
      );
    }
  }
}

function quoteSignerKeypair(): Keypair {
  const secret = process.env.STELLAR_QUOTE_SIGNER_SECRET;
  if (!secret) {
    throw new MerchantQuoteError(
      "QUOTE_SIGNER_SECRET_MISSING",
      "Server quote signer is not configured."
    );
  }
  try {
    return Keypair.fromSecret(secret);
  } catch {
    throw new MerchantQuoteError(
      "QUOTE_SIGNER_SECRET_INVALID",
      "Server quote signer configuration is invalid."
    );
  }
}

/**
 * Register a quote using a server-only signer. The browser never supplies a
 * price. Before signing, this function proves that every canonical Supabase
 * unit price exactly matches the merchant-controlled on-chain catalog.
 */
export async function registerMerchantQuote(
  registration: MerchantQuoteRegistration
): Promise<RegisteredMerchantQuote> {
  if (!CHECKOUT_CONTRACT_ID) {
    throw new MerchantQuoteError(
      "CONTRACT_NOT_CONFIGURED",
      "Checkout contract is not configured."
    );
  }

  // Validate address before any RPC or signing work.
  addressToScVal(registration.buyer);

  const token = defaultToken();
  const signer = quoteSignerKeypair();
  const server = new rpc.Server(RPC_URL);

  const onChainSigner = await configuredQuoteSigner(server);
  if (onChainSigner !== signer.publicKey()) {
    throw new MerchantQuoteError(
      "QUOTE_SIGNER_MISMATCH",
      "Server quote signer does not match the signer configured on-chain."
    );
  }

  await assertCatalogMirror(server, registration.lines, token.contractId);

  const orderBytes = await sha256Text(registration.orderId);
  const args = [
    addressToScVal(registration.buyer),
    bytes32ToScVal(orderBytes),
    addressToScVal(token.contractId),
    await quoteLinesToScVal(registration.lines),
  ];

  const account = await server.getAccount(signer.publicKey());
  const tx = buildInvocationTransaction(account, CHECKOUT_CONTRACT_ID, "create_quote", args);
  const { tx: prepared, report } = await prepareAndReport(server, tx);
  if (!report.ok || !report.retval) {
    throw new MerchantQuoteError(
      "QUOTE_SIMULATION_FAILED",
      report.error?.message ?? "Quote registration simulation failed."
    );
  }

  const contractAmountRaw = BigInt(scValToNative(report.retval).toString());
  if (contractAmountRaw !== registration.amountRaw) {
    throw new MerchantQuoteError(
      "QUOTE_AMOUNT_MISMATCH",
      "Canonical catalog total does not match the contract-computed quote amount."
    );
  }

  prepared.sign(signer);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR") {
    throw new MerchantQuoteError(
      "QUOTE_SUBMISSION_FAILED",
      "Quote registration transaction was rejected."
    );
  }

  await waitForTransaction(sent.hash);

  const expiry = await simulateContractRead(
    server,
    CHECKOUT_CONTRACT_ID,
    "quote_expires_at",
    [bytes32ToScVal(orderBytes)],
    signer.publicKey()
  );
  if (!expiry || expiry.switch() === xdr.ScValType.scvVoid()) {
    throw new MerchantQuoteError(
      "QUOTE_PERSISTENCE_FAILED",
      "Quote registration succeeded but its expiry could not be read back."
    );
  }

  return {
    amountRaw: contractAmountRaw,
    orderIdHex: bytesToHex(orderBytes),
    expiresAt: Number(scValToNative(expiry)),
    transactionHash: sent.hash,
  };
}
