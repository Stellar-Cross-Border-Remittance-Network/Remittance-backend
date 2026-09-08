import Fastify, { type FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resetEnvCache } from '../../src/config/env.js';
import { bodyHash, signJsonBody } from '../../src/lib/requestSigning.js';
import { requestSignaturePlugin } from '../../src/server/plugins/requestSignature.js';

const SECRET = 'plugin-test-secret';

let app: Awaited<ReturnType<typeof Fastify>>;

beforeAll(async () => {
  process.env.REQUEST_SIGNING_SECRET = SECRET;
  process.env.REQUEST_SIGNING_CLOCK_SKEW_MS = '300000';
  resetEnvCache();
  app = Fastify({ logger: { level: 'silent' } });
  const requireSignature = await requestSignaturePlugin(app);
  app.post('/internal/op', { preHandler: [requireSignature()] }, async (req: FastifyRequest) => {
    return { ok: true, body: req.body };
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  delete process.env.REQUEST_SIGNING_SECRET;
  delete process.env.REQUEST_SIGNING_CLOCK_SKEW_MS;
  resetEnvCache();
});

describe('request-signature plugin', () => {
  it('rejects requests without signature headers', async () => {
    const res = await app.inject({ method: 'POST', url: '/internal/op', payload: { a: 1 } });
    expect(res.statusCode).toBe(401);
  });

  it('rejects requests with a wrong signature', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/internal/op',
      headers: {
        'X-Request-Timestamp': String(Date.now()),
        'X-Request-Body-Hash': bodyHash(JSON.stringify({ a: 1 })),
        'X-Request-Signature': 'v1:deadbeef',
      },
      payload: { a: 1 },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects replayed signatures (stale timestamp)', async () => {
    const { headers } = signJsonBody({ a: 1 }, 'POST', '/internal/op', SECRET, Date.now() - 3600_000);
    const res = await app.inject({ method: 'POST', url: '/internal/op', headers, payload: { a: 1 } });
    expect(res.statusCode).toBe(401);
  });

  it('accepts a correctly signed request', async () => {
    const { headers } = signJsonBody({ a: 1 }, 'POST', '/internal/op', SECRET);
    const res = await app.inject({ method: 'POST', url: '/internal/op', headers, payload: { a: 1 } });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it('rejects when the body was tampered after signing', async () => {
    const { headers } = signJsonBody({ a: 1 }, 'POST', '/internal/op', SECRET);
    const res = await app.inject({ method: 'POST', url: '/internal/op', headers, payload: { a: 2 } });
    expect(res.statusCode).toBe(401);
  });
});