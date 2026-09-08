import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
    sequence: { concurrent: false },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: [
        // Process entrypoint and optional tracing bootstrap are exercised by
        // the live testnet suite, not unit/integration tests.
        'src/server/index.ts',
        'src/server/plugins/otel.ts',
        // Generated Soroban client bindings (SDK-generated, not hand-written).
        'src/modules/soroban/bindings/**',
        // SQL migrations are applied and verified against real Postgres.
        'src/db/migrations/**',
        'src/**/*.test.ts',
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        statements: 80,
        branches: 70,
      },
    },
  },
});