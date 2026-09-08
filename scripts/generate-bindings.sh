#!/usr/bin/env bash
# Regenerate the typed Soroban contract bindings from the contract WASM.
#
# Prereqs:
#   - `stellar` CLI (stellar-cli release binary or `cargo install stellar-cli`)
#   - the built contract WASM at remittance-contracts/target/.../remittance_contract.wasm
#
# Usage:
#   STELLAR_CLI=stellar bash scripts/generate-bindings.sh /path/to/remittance_contract.wasm
set -euo pipefail

STELLAR_CLI="${STELLAR_CLI:-stellar}"
WASM="${1:-../remittance-contracts/target/wasm32v1-none/release/remittance_contract.wasm}"

if [ ! -f "$WASM" ]; then
  echo "error: WASM not found at $WASM — build it first: cargo build --release -p remittance-contract" >&2
  exit 1
fi

OUT="src/modules/soroban/bindings"
echo "Generating TypeScript bindings into $OUT ..."
"$STELLAR_CLI" contract bindings typescript \
  --wasm "$WASM" \
  --output-dir "$OUT" \
  --overwrite \
  --network testnet

echo "Bindings regenerated. Two patches applied by hand previously must be re-applied:"
echo "  1. remove the window.Buffer shim and unused type exports (Timepoint/Duration)"
echo "  2. add 'override' to the generated Client.deploy"
echo "Run: pnpm typecheck && pnpm test"