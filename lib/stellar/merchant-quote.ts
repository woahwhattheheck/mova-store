import {
  Address,
  Keypair,
  StrKey,
  authorizeEntry,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { assembleTransaction } from "@stellar/stellar-sdk/rpc";

import type { CanonicalQuoteLine } from "../checkout-quote";
import {
  CHECKOUT_CONTRACT_ID,
  NETWORK_PASSPHRASE,
  RPC_URL,
  defaultToken,
} from "./config";
import {
  addressToScVal,
  bytes32ToScVal,
  bytesToHex,
  symbolToScVal,
} from "./scval";
import { buildInvocationTransaction, simulateContractRead } from "./simulate";

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

export interface PreparedMerchantQuote {
  amountRaw: bigint;
  orderIdHex: string;
  transactionXdr: string;
  authValidUntilLedger: number;
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

function authorizationAddress(entry: xdr.SorobanAuthorizationEntry): string | null {
  const credentials = entry.credentials();
  const kind = credentials.switch();

  if (kind === xdr.SorobanCredentialsType.sorobanCredentialsSourceAccount()) {
    return null;
  }
  if (kind === xdr.SorobanCredentialsType.sorobanCredentialsAddress()) {
    return Address.fromScAddress(credentials.address().address()).toString();
  }
  if (kind === xdr.SorobanCredentialsType.sorobanCredentialsAddressV2()) {
    return Address.fromScAddress(credentials.addressV2().address()).toString();
  }
  throw new MerchantQuoteError(
    "UNSUPPORTED_QUOTE_AUTH",
    "Checkout simulation returned an unsupported authorization credential."
  );
}

/**
 * Prepare a merchant-authorized quote transaction without spending server XLM.
 *
 * The buyer is the transaction source (and therefore the eventual fee payer).
 * Recording-mode simulation produces the non-invoker authorization entry for
 * the dedicated quote signer; the server signs only that bounded entry, then
 * returns a partially authorized transaction for the buyer wallet to sign and
 * submit. This prevents an anonymous quote endpoint from becoming a fee-drain
 * primitive against the merchant signer.
 */
export async function prepareMerchantQuote(
  registration: MerchantQuoteRegistration
): Promise<PreparedMerchantQuote> {
  if (!CHECKOUT_CONTRACT_ID) {
    throw new MerchantQuoteError(
      "CONTRACT_NOT_CONFIGURED",
      "Checkout contract is not configured."
    );
  }

  // The buyer is the transaction source/fee payer, so only a real Stellar
  // account (G...) is valid here. Contract addresses can satisfy generic
  // Address parsing but cannot serve as the transaction source account.
  if (!StrKey.isValidEd25519PublicKey(registration.buyer)) {
    throw new MerchantQuoteError(
      "INVALID_BUYER_ACCOUNT",
      "Buyer must be a Stellar account public key."
    );
  }
  addressToScVal(registration.buyer);

  const token = defaultToken();
  const signer = quoteSignerKeypair();
  if (registration.buyer === signer.publicKey()) {
    throw new MerchantQuoteError(
      "BUYER_SIGNER_COLLISION",
      "Quote signer cannot also be the buyer transaction source."
    );
  }

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

  // The buyer source account pays the transaction fee when it later submits
  // this XDR. The server secret signs only the Soroban authorization entry.
  const buyerAccount = await server.getAccount(registration.buyer);
  const tx = buildInvocationTransaction(
    buyerAccount,
    CHECKOUT_CONTRACT_ID,
    "create_quote",
    args
  );
  const simulation = await server.simulateTransaction(tx, undefined, undefined, true);
  if (rpc.Api.isSimulationError(simulation) || !simulation.result?.retval) {
    throw new MerchantQuoteError(
      "QUOTE_SIMULATION_FAILED",
      rpc.Api.isSimulationError(simulation)
        ? String(simulation.error)
        : "Quote registration simulation returned no result."
    );
  }

  const contractAmountRaw = BigInt(scValToNative(simulation.result.retval).toString());
  if (contractAmountRaw !== registration.amountRaw) {
    throw new MerchantQuoteError(
      "QUOTE_AMOUNT_MISMATCH",
      "Canonical catalog total does not match the contract-computed quote amount."
    );
  }

  const entries = simulation.result.auth ?? [];
  const nonSourceEntries = entries.filter((entry) => authorizationAddress(entry) !== null);
  if (nonSourceEntries.length !== 1 || authorizationAddress(nonSourceEntries[0]) !== signer.publicKey()) {
    throw new MerchantQuoteError(
      "QUOTE_AUTH_MISMATCH",
      "Quote simulation did not request exactly the configured quote signer authorization."
    );
  }

  const authValidUntilLedger = simulation.latestLedger + 12;
  simulation.result.auth = await Promise.all(
    entries.map(async (entry) => {
      const address = authorizationAddress(entry);
      if (address === null) return entry;
      if (address !== signer.publicKey()) {
        throw new MerchantQuoteError(
          "QUOTE_AUTH_MISMATCH",
          "Quote simulation requested an unexpected authorization signer."
        );
      }
      return authorizeEntry(entry, signer, authValidUntilLedger, NETWORK_PASSPHRASE);
    })
  );

  const prepared = assembleTransaction(tx, simulation).build();

  // Signed auth entries switch simulation into enforcement mode. Validate the
  // bounded server authorization before returning any XDR to the browser.
  const enforcement = await server.simulateTransaction(prepared);
  if (rpc.Api.isSimulationError(enforcement)) {
    throw new MerchantQuoteError(
      "QUOTE_AUTH_INVALID",
      "Prepared quote authorization failed enforcement simulation."
    );
  }

  return {
    amountRaw: contractAmountRaw,
    orderIdHex: bytesToHex(orderBytes),
    transactionXdr: prepared.toXDR(),
    authValidUntilLedger,
  };
}
