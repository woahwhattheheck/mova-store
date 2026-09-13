# Checkout quote authority

Mova Store treats the browser as untrusted payment input. Email verification, `localStorage`, displayed cart totals, transaction success by itself, and a buyer-authored pending order are not payment authority.

The checkout contract accepts escrow funding only through a short-lived merchant-authorized quote. A dedicated Ed25519 quote key signs catalog-derived terms on the server. The merchant/admin wallet configures only that key's raw 32-byte public key on-chain and retains all dispatch, refund, token-whitelist, signer-rotation, and merchant-rotation authority.

## Security boundary

A quote commits to the checkout contract deployment, an authoritative order id, the buyer account, the token contract, the raw integer amount, and an expiry timestamp. The authoritative order id also commits to the canonical product-id multiset so a valid low-price quote cannot be reused as proof of payment for a different cart.

The contract verifies the signature before moving funds. The buyer separately authorizes the token transfer through Freighter. A successful transaction is accepted by the UI only when the emitted payment receipt matches the same contract, token, order id, and raw amount.

Quotes expire after five minutes. Rotating the configured quote signer immediately invalidates every quote signed by the old key.

## Key separation

Never reuse the merchant/admin seed as `CHECKOUT_QUOTE_SIGNING_SECRET`. The quote signer exists only to authorize exact catalog price tuples and has no contract method that can dispatch escrow, issue refunds, modify token allowlists, or rotate ownership.

Generate a dedicated keypair in a trusted operator environment, store the `S...` seed only in the server secret store as `CHECKOUT_QUOTE_SIGNING_SECRET`, and store its raw 32-byte public key as 64 lowercase hex characters in `CHECKOUT_QUOTE_SIGNER_HEX`.

One way to generate both values with the project's pinned Stellar SDK is:

```bash
node --input-type=module - <<'NODE'
import { Keypair } from "@stellar/stellar-sdk";
const key = Keypair.random();
console.log(`CHECKOUT_QUOTE_SIGNING_SECRET=${key.secret()}`);
console.log(`CHECKOUT_QUOTE_SIGNER_HEX=${Buffer.from(key.rawPublicKey()).toString("hex")}`);
NODE
```

Treat the command output as a credential. Do not paste the secret into Slack, GitHub issues, build logs, browser-exposed variables, or any variable prefixed with `NEXT_PUBLIC_`.

## Deployment

The signed-quote ABI is intentionally fail-closed. A frontend using `pay_with_quote` requires a checkout contract built from the same signed-quote code and configured with the matching public key. Do not deploy the new frontend against an older contract that only supports buyer-supplied `pay(...)`.

For testnet:

```bash
CHECKOUT_QUOTE_SIGNER_HEX=<64-hex-public-key> scripts/deploy-testnet.sh
```

The deployment script initializes the contract under the deployer, configures the quote signer and token allowlist, then transfers merchant authority if a different merchant address was requested. This lets deployment finish without requiring the merchant's private key in the deployment process.

After deployment, configure the server with all three values:

```text
NEXT_PUBLIC_CHECKOUT_CONTRACT_ID=<deployed C... address>
CHECKOUT_QUOTE_SIGNING_SECRET=<dedicated S... quote seed>
CHECKOUT_QUOTE_SIGNER_HEX=<matching 64-hex raw public key>
```

The quote endpoint verifies that the secret derives the configured public key before it signs. A mismatch fails closed before a buyer reaches Freighter simulation.

## Rotation and recovery

The merchant can rotate the quote key with `set_quote_signer`. Rotate on suspected exposure, during normal secret rotation, or when moving the signing service. Update the server secret/public pair and the on-chain public key as one controlled change. During the transition, old outstanding quotes fail signature verification; clients should request a fresh quote.

Merchant/admin key compromise and quote-key compromise are separate incidents. Compromise of the quote key can authorize prices but cannot dispatch or refund escrow or change contract administration. Compromise of the merchant key remains the higher-authority event and should follow the merchant-key recovery process.

## Fulfillment rule

Fulfillment must never infer purchased products from browser state or from amount alone. Recompute or look up the canonical cart associated with the authoritative order id and require the matching on-chain receipt. Duplicate product ids represent quantity and are preserved when deriving the cart fingerprint; product ordering is normalized so equivalent carts map to the same fingerprint.

## Release checklist

- Contract tests include positive escrow/dispatch/refund coverage under signed quotes and negative coverage for missing signer, expiry, and tampered buyer/token/amount.
- Rust and JavaScript tests share one deterministic signature fixture, so XDR/domain drift fails CI.
- The server derives amount from the canonical product catalog and derives the authoritative order id from the cart fingerprint.
- The browser never supplies a payment amount to transaction construction.
- The watcher is disabled until a signed quote exists and then watches the signed authoritative order id/token/raw amount.
- `CHECKOUT_QUOTE_SIGNING_SECRET` remains server-only; `CHECKOUT_QUOTE_SIGNER_HEX` matches both the secret and the on-chain contract.
- Frontend, Soroban, dependency/security, and Rust audit jobs are green on the exact merge head.
