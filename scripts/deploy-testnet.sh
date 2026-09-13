#!/usr/bin/env bash
#
# Deploy the Mova Store checkout contract to Stellar testnet and initialize it.
#
# Requires:
#   - Rust + wasm32v1-none target  (rustup target add wasm32v1-none)
#   - Stellar CLI                   (brew install stellar-cli, or see
#                                    https://github.com/stellar/stellar-cli)
#   - A funded testnet keypair      (stellar keys generate --fund)
#   - A dedicated quote signer public key as 64 hex chars
#
# Usage:
#   CHECKOUT_QUOTE_SIGNER_HEX=<64-hex-public-key> scripts/deploy-testnet.sh [MERCHANT_G_ADDRESS]
#   scripts/deploy-testnet.sh [MERCHANT_G_ADDRESS] <64-hex-public-key>
#
# The quote signer is NOT the merchant/admin wallet. Only its raw 32-byte
# Ed25519 public key is written on-chain; the matching secret seed belongs only
# in the server's CHECKOUT_QUOTE_SIGNING_SECRET environment variable.

set -euo pipefail

NETWORK="${STELLAR_NETWORK:-testnet}"
SOURCE_ACCOUNT="${STELLAR_SOURCE_ACCOUNT:-alice}"
CONTRACT_DIR="contracts/checkout"
DEPLOYER="$(stellar keys address "${SOURCE_ACCOUNT}")"
MERCHANT="${1:-${DEPLOYER}}"
QUOTE_SIGNER_HEX="${2:-${CHECKOUT_QUOTE_SIGNER_HEX:-}}"

if [[ ! "${QUOTE_SIGNER_HEX}" =~ ^[0-9A-Fa-f]{64}$ ]]; then
  echo "error: provide CHECKOUT_QUOTE_SIGNER_HEX as exactly 64 hex characters (raw Ed25519 public key)" >&2
  exit 2
fi

QUOTE_SIGNER_HEX="${QUOTE_SIGNER_HEX,,}"

echo "==> Building contract (wasm32v1-none)…"
(cd "${CONTRACT_DIR}" && cargo build --target wasm32v1-none --release)

WASM="${CONTRACT_DIR}/target/wasm32v1-none/release/movastore_checkout.wasm"
if [[ ! -f "${WASM}" ]]; then
  echo "error: ${WASM} not found. Is your toolchain configured for wasm32v1-none?" >&2
  exit 1
fi

echo "==> Deploying to ${NETWORK}…"
CONTRACT_ID=$(stellar contract deploy \
  --wasm "${WASM}" \
  --source-account "${SOURCE_ACCOUNT}" \
  --network "${NETWORK}" \
  --alias movastore_checkout)
echo "    contract id: ${CONTRACT_ID}"

echo "==> Initializing under deployer ${DEPLOYER}…"
stellar contract invoke \
  --id "${CONTRACT_ID}" \
  --source-account "${SOURCE_ACCOUNT}" \
  --network "${NETWORK}" \
  -- \
  initialize \
  --merchant "${DEPLOYER}"

echo "==> Configuring dedicated checkout quote signer…"
stellar contract invoke \
  --id "${CONTRACT_ID}" \
  --source-account "${SOURCE_ACCOUNT}" \
  --network "${NETWORK}" \
  -- \
  set_quote_signer \
  --signer "${QUOTE_SIGNER_HEX}"

# Whitelist the default supported tokens (testnet USDC SAC + native XLM SAC).
# Override with TESTNET_USDC_CONTRACT_ID / TESTNET_NATIVE_CONTRACT_ID.
USDC_CONTRACT="${TESTNET_USDC_CONTRACT_ID:-CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA}"
NATIVE_CONTRACT="${TESTNET_NATIVE_CONTRACT_ID:-CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC}"

echo "==> Whitelisting USDC (${USDC_CONTRACT})…"
stellar contract invoke \
  --id "${CONTRACT_ID}" \
  --source-account "${SOURCE_ACCOUNT}" \
  --network "${NETWORK}" \
  -- \
  add_token \
  --token "${USDC_CONTRACT}"

echo "==> Whitelisting native XLM (${NATIVE_CONTRACT})…"
stellar contract invoke \
  --id "${CONTRACT_ID}" \
  --source-account "${SOURCE_ACCOUNT}" \
  --network "${NETWORK}" \
  -- \
  add_token \
  --token "${NATIVE_CONTRACT}"

if [[ "${MERCHANT}" != "${DEPLOYER}" ]]; then
  echo "==> Transferring merchant authority to ${MERCHANT}…"
  stellar contract invoke \
    --id "${CONTRACT_ID}" \
    --source-account "${SOURCE_ACCOUNT}" \
    --network "${NETWORK}" \
    -- \
    set_merchant \
    --new_merchant "${MERCHANT}"
fi

echo
echo "Done. Add this contract id to .env.local:"
echo "  NEXT_PUBLIC_CHECKOUT_CONTRACT_ID=${CONTRACT_ID}"
echo "Keep CHECKOUT_QUOTE_SIGNING_SECRET server-only and verify its public key matches CHECKOUT_QUOTE_SIGNER_HEX."
