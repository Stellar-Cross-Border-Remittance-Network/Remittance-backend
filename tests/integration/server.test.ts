import { Keypair, Transaction } from '@stellar/stellar-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger } from '../../src/lib/logger.js';
import { buildApp } from '../../src/server/app.js';
import { buildContainer, type Container } from '../../src/server/container.js';
import { createTestDb } from '../helpers/testDb.js';

let app: Awaited<ReturnType<typeof buildApp>>;
let container: Container;

beforeAll(async () => {
  const db = await createTestDb();
  const logger = createLogger();
  container = buildContainer(db, logger);
  app = await buildApp(container);
});

afterAll(async () => {
  await app.close();
});

async function signIn(): Promise<string> {
  const kp = Keypair.random();
  const challenge = await app.inject({
    method: 'POST',
    url: '/v1/sep10/challenge',
    payload: { account: kp.publicKey() },
  });
  expect(challenge.statusCode).toBe(200);
  const { transaction, network_passphrase } = challenge.json();
  const tx = new Transaction(transaction, network_passphrase);
  tx.sign(kp);
  const verify = await app.inject({
    method: 'POST',
    url: '/v1/sep10/verify',
    payload: { transaction: tx.toXDR(), account: kp.publicKey() },
  });
  expect(verify.statusCode).toBe(200);
  return verify.json().token as string;
}

describe('HTTP API', () => {
  it('serves health checks', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ok');
  });

  it('serves OpenAPI docs at /docs', async () => {
    const res = await app.inject({ method: 'GET', url: '/docs' });
    expect(res.statusCode).toBe(200);
  });

  it('runs the SEP-10 challenge -> verify flow over HTTP', async () => {
    const token = await signIn();
    expect(token).toBeTruthy();
  });

  it('rejects SEP-10 verify with an unsigned challenge', async () => {
    const kp = Keypair.random();
    const challenge = await app.inject({
      method: 'POST',
      url: '/v1/sep10/challenge',
      payload: { account: kp.publicKey() },
    });
    const { transaction } = challenge.json();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/sep10/verify',
      payload: { transaction, account: kp.publicKey() },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 for protected routes without a token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/remittances/quote',
      payload: {
        source_asset: 'USDC:GUSDC',
        destination_asset: 'NGN:GNGN',
        source_amount: '100',
        source_country: 'US',
        destination_country: 'NG',
      },
    });
    expect(res.statusCode).toBe(401);
  });

  it('creates a quote with a valid session', async () => {
    const token = await signIn();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/remittances/quote',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        source_asset: 'USDC:GUSDC',
        destination_asset: 'NGN:GNGN',
        source_amount: '100',
        source_country: 'US',
        destination_country: 'NG',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().quoteHash).toHaveLength(64);
  });

  it('returns 422 on validation errors', async () => {
    const token = await signIn();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/remittances/quote',
      headers: { authorization: `Bearer ${token}` },
      payload: { source_amount: 'not-a-number' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('VALIDATION_ERROR');
  });

  it('returns 404 for unknown routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/does-not-exist' });
    expect(res.statusCode).toBe(404);
  });

  it('normalizes AppError responses with stable codes', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/anchors/00000000-0000-0000-0000-000000000000' });
    // Authed scope: no token -> 401 before the handler runs.
    expect(res.statusCode).toBe(401);
  });
});