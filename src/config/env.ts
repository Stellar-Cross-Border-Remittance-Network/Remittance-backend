import 'dotenv/config';

import { z } from 'zod';

/** Optional URL that tolerates empty-string env values (treats them as unset). */
const optionalUrl = z.preprocess(
  (v) => (v === '' ? undefined : v),
  z.string().url().optional(),
);

/**
 * Boolean env values. `z.coerce.boolean()` treats the string 'false' as true
 * (Boolean('false') === true), so parse real truthy strings only.
 */
const bool = (def: boolean) =>
  z.preprocess(
    (v) => (v === undefined || v === '' ? undefined : v === true || v === 'true' || v === '1'),
    z.boolean().default(def),
  );

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.string().default('info'),

  DATABASE_URL: z
    .string()
    .default('postgres://remittance:remittance@localhost:5432/remittance'),
  REDIS_URL: z.string().default('redis://localhost:6379'),

  // Network
  NETWORK: z.enum(['testnet', 'mainnet', 'local']).default('testnet'),
  HORIZON_URL: z.string().url().default('https://horizon-testnet.stellar.org'),
  RPC_URL: z.string().url().default('https://soroban-testnet.stellar.org'),
  NETWORK_PASSPHRASE: z
    .string()
    .default('Test SDF Network ; September 2015'),

  // Security
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  JWT_EXPIRES_IN: z.string().default('15m'),
  ENCRYPTION_KEY: z
    .string()
    .min(32, 'ENCRYPTION_KEY must be a 32+ byte hex/string secret'),
  SEP10_SIGNING_SECRET: z.string().optional().describe('SEP-10 server keypair'),
  SEP10_CHALLENGE_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  SEP10_CLIENT_ATTRIBUTION: z.string().default('remittance-backend'),

  // Identity
  SERVER_HOME_DOMAIN: z.string().default('remittance.example.com'),
  WEB_AUTH_DOMAIN: z.string().default('remittance.example.com'),

  // Soroban contract
  CONTRACT_ID: z.string().optional(),
  ADMIN_SECRET: z.string().optional().describe('contract ADMIN keypair secret'),
  ORACLE_SECRET: z.string().optional().describe('contract SETTLEMENT_ORACLE keypair secret'),
  FEE_OPERATOR_SECRET: z.string().optional().describe('contract FEE_OPERATOR keypair secret'),

  // Quote engine
  QUOTE_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  PLATFORM_FEE_BPS: z.coerce.number().int().positive().default(50),
  CORRIDOR_FEE_BPS: z.coerce.number().int().min(0).default(0),
  CORRIDOR_RATES_JSON: z
    .string()
    .optional()
    .describe('Static corridor FX fallback rates, e.g. {"USDC/NGN": "1520.5"}'),
  RATE_PROVIDER_URL: optionalUrl.describe('Optional FX rate API'),
  RATE_PROVIDER_TOKEN: z.string().optional(),

  // Operations
  STREAM_ENABLED: bool(true),
  POLL_RECONCILE_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  ALLOW_INSECURE_HTTP: bool(false),

  // Request signing (HMAC over method/path/timestamp/body-hash)
  REQUEST_SIGNING_SECRET: z.string().optional().describe('Shared secret for signed internal/webhook requests'),
  REQUEST_SIGNING_CLOCK_SKEW_MS: z.coerce.number().int().min(0).default(300_000),

  // Observability
  OTEL_ENABLED: bool(false),
  OTEL_EXPORTER_OTLP_ENDPOINT: optionalUrl,
  OTEL_SERVICE_NAME: z.string().default('remittance-backend'),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;

/** Parse and memoize process.env. Throws with a descriptive error on misconfiguration. */
export function loadEnv(overrides: Record<string, unknown> = {}): Env {
  if (cached && Object.keys(overrides).length === 0) {
    return cached;
  }
  const parsed = EnvSchema.safeParse({ ...process.env, ...overrides });
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  cached = parsed.data;
  return cached;
}

export function resetEnvCache(): void {
  cached = undefined;
}

export const NETWORKS = {
  testnet: {
    horizon: 'https://horizon-testnet.stellar.org',
    rpc: 'https://soroban-testnet.stellar.org',
    passphrase: 'Test SDF Network ; September 2015',
  },
  mainnet: {
    horizon: 'https://horizon.stellar.org',
    rpc: 'https://mainnet.sorobanrpc.com',
    passphrase: 'Public Global Stellar Network ; September 2015',
  },
  local: {
    horizon: 'http://localhost:8000',
    rpc: 'http://localhost:8000/soroban/rpc',
    passphrase: 'Standalone Network ; February 2017',
  },
} as const;