# remittance-backend

Production-grade TypeScript backend for a Stellar-native cross-border remittance
application. Powers SEP-1 / SEP-6 / SEP-10 / SEP-24, Horizon streaming, an
integer-exact quote engine, real PathPaymentStrictSend routing, and Soroban
escrow settlement against the `remittance-contracts` contract.

**Stack:** Node.js · TypeScript · Fastify · PostgreSQL · Redis · BullMQ ·
@stellar/stellar-sdk · Drizzle ORM · OpenAPI (Swagger UI) · Vitest · Docker ·
OpenTelemetry

---

## Architecture

```
┌────────────────────────────────────────────────────────────────┐
│  remittance-app (React Native)                                 │
└───────────────┬────────────────────────────────────────────────┘
                │ HTTPS (JWT)
┌───────────────▼────────────────────────────────────────────────┐
│  Fastify API (this repo)                                       │
│  ┌──────────┬──────────┬───────────┬──────────────┬─────────┐  │
│  │ SEP-1    │ SEP-10   │ SEP-24/6  │ Quotes       │ Paths   │  │
│  │ anchors  │ auth     │ transfers │ (hash + TTL) │ (real)  │  │
│  └────┬─────┴────┬─────┴─────┬─────┴──────┬───────┴────┬────┘  │
│       │          │           │            │            │       │
│  PostgreSQL      │     Horizon/SEPs      │      Soroban RPC     │
│  (state, audit)  │     (anchors)         │   (escrow contract)  │
│       │          │                       │                      │
│  Redis + BullMQ  │   Payment Streamer ───┴── Reconciler (poll)  │
│  (jobs, events)  │   (SSE, cursors, dedupe, reconnect)          │
└──────────────────┴───────────────────────────────────────────────┘
```

## Modules

| Module | Responsibility |
|---|---|
| `sep1/` | `stellar.toml` discovery — endpoints and assets are always fetched per anchor, never hard-coded |
| `anchors/` | Anchor registry with SEP-1 discovery, asset catalog, KYC flags |
| `sep10/` | Challenge issuance + verification (non-custodial and custodial), session JWTs; anchor auth on the user's behalf |
| `sep24/` | Interactive deposit/withdraw — returns the interactive URL for the app's WebView |
| `sep6/` | Programmatic deposit/withdraw with `AUTO` preference (SEP-24 first, SEP-6 fallback) |
| `horizon/` | Account loading, transaction submission, `strict_send_paths` |
| `streaming/` | Durable payment SSE streaming with persisted cursors, dedupe, exponential-backoff reconnect |
| `reconciler` | Polling reconciliation — the recovery path for stream gaps (overlap-safe via `unique(cursor, account)`) |
| `quotes/` | Integer-exact quote engine (stroops), deterministic fees, persisted quote hash, expiry |
| `pathPayments/` | `PathPaymentStrictSend` — real Horizon paths only, slippage-guarded `destMin` |
| `soroban/` | Typed bindings (generated from the contract WASM) + invocation service with execution verification |
| `remittance/` | State machine orchestration, Soroban lifecycle, BullMQ jobs (expiry sweep, anchor status poll) |
| `signing/` | Signing abstraction — local Keypair backed, HSM-ready interface; secrets encrypted at rest |

## API (all under `/v1`, docs at `/docs`)

```
POST /remittances/quote                 GET  /remittances/{id}
POST /remittances                       POST /remittances/{id}/fund
POST /remittances/{id}/release          POST /remittances/{id}/refund
GET  /remittances/{id}/events           POST /remittances/{id}/confirm-soroban
POST /sep10/challenge                   POST /sep10/verify
POST /sep24/deposit                     POST /sep24/withdraw
POST /sep6/deposit                      POST /sep6/withdraw
GET  /anchors                           GET  /anchors/{id}    POST /anchors (admin)
POST /path-payments/plan                GET  /health
```

## Money handling

All amounts travel as **decimal strings** over the API and as **integer
stroops (`bigint`)** internally. No floating point anywhere in the money path
(see `src/lib/amounts.ts` and the quote engine tests). The HTTP layer
serializes `bigint` to strings automatically.

## Running locally

```bash
# 1. secrets
cp .env.example .env && bash scripts/gen-secrets.sh >> .env

# 2. infra (postgres + redis)
docker compose up -d postgres redis

# 3. install + migrate + dev server
pnpm install
pnpm migrate
pnpm dev            # http://localhost:8080, docs at /docs
```

To exercise the full Soroban flow, deploy the contract to Testnet first
(see `remittance-contracts/scripts/deploy-testnet.sh`) and set
`CONTRACT_ID` / `ADMIN_SECRET` / `ORACLE_SECRET` / `FEE_OPERATOR_SECRET`.

## Testing

```bash
pnpm typecheck
pnpm test          # unit + integration (pglite in-memory Postgres; no external deps)
pnpm test:integration   # Testnet live tests (requires secrets)
```

The suite covers: SEP-10 challenge/verify (tamper, wrong-account, custodial),
quote math + integrity + expiry, anchor discovery/upsert, the remittance state
machine (fund/refund/double-fund/settle pipeline), non-custodial approval
reconciliation, payment normalization + dedupe, DB migrations, and the HTTP
surface (auth, validation, error codes, BigInt-safe serialization).

## Security

- **No private keys in logs**; secrets encrypted at rest (AES-256-GCM, service
  key from `ENCRYPTION_KEY`).
- JWT sessions with RBAC (`user` / `admin`), rate limiting, request-scoped
  authorization on every remittance.
- Settlement authorization re-states the full committed terms on-chain; any
  mismatch is rejected by the contract (`SettlementMismatch`).
- Non-custodial Soroban submissions are reconciled by reading back the
  on-chain record and matching sender + quote hash — never trusted blindly.
- Anchor endpoints come from each anchor's published `stellar.toml`; the
  `ALLOW_INSECURE_HTTP` flag exists only for local development.
- **Request signing** for machine-to-machine routes: HMAC-SHA256 over
  method + path + timestamp + body hash (`X-Request-Signature` +
  `X-Request-Timestamp` + `X-Request-Body-Hash`), constant-time verified with
  a bounded clock-skew so replay is rejected. Enabled by setting
  `REQUEST_SIGNING_SECRET` (required in production — internal ops routes fail
  closed without it). See `src/lib/requestSigning.ts`.

## Live Testnet integration tests

`tests/testnet/live.test.ts` hits real Testnet (Horizon, Soroban RPC, the
**deployed escrow contract**, and testanchor's stellar.toml via SEP-1).
Skipped by default; run explicitly:

```bash
RUN_TESTNET_TESTS=1 CONTRACT_ID=CAA2LHIITEFNS5KL3H5ZLRVVR6BPUKWXCHKN5V6HMR4XLJBQZHRBT6QZ \
  pnpm vitest run tests/testnet/live.test.ts
```

See also the threat model in `remittance-contracts/docs/SECURITY.md`.