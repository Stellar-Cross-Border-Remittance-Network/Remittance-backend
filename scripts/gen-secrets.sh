#!/usr/bin/env bash
# Generate strong local secrets for .env (never commit real secrets).
set -euo pipefail

JWT_SECRET="$(openssl rand -hex 32)"
ENCRYPTION_KEY="$(openssl rand -hex 32)"
SEP10_SECRET="$(node --input-type=module -e 'import { Keypair } from "@stellar/stellar-sdk"; console.log(Keypair.random().secret())')"

echo "JWT_SECRET=$JWT_SECRET"
echo "ENCRYPTION_KEY=$ENCRYPTION_KEY"
echo "SEP10_SIGNING_SECRET=$SEP10_SECRET"