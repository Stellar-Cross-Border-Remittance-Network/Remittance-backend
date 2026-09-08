import { PassThrough } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { loadEnv } from '../../config/env.js';
import { forbidden, unauthorized } from '../../lib/errors.js';
import { bodyHash, verifyRequest } from '../../lib/requestSigning.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Raw request body string, captured in preParsing for signature checks. */
    rawBody?: string;
  }
}

/**
 * Captures the raw body so signature verification can hash exactly what was
 * sent (JSON.parse/stringify round-trips are NOT guaranteed to match the
 * wire bytes). Registers once; returns a `requireSignature` preHandler
 * factory for routes that opt in.
 */
export function requestSignaturePlugin(app: FastifyInstance): () => (req: FastifyRequest, reply: FastifyReply) => Promise<void> {
  const env = loadEnv();
  const secret = env.REQUEST_SIGNING_SECRET ?? '';
  const clockSkewMs = env.REQUEST_SIGNING_CLOCK_SKEW_MS;

  app.addHook('preParsing', async (req, _reply, payload) => {
    if (!secret) {
      return payload;
    }
    const chunks: Buffer[] = [];
    const tee = new PassThrough();
    payload.on('data', (c: Buffer) => {
      chunks.push(c);
      tee.write(c);
    });
    payload.on('end', () => {
      req.rawBody = Buffer.concat(chunks).toString('utf8');
      tee.end();
    });
    payload.on('error', (e: Error) => tee.destroy(e));
    return tee;
  });

  /**
   * Route-level preHandler. Enforces the signature when REQUEST_SIGNING_SECRET
   * is set; without it the route is allowed in dev/test but rejected in
   * production so a misconfigured deployment fails closed.
   */
  return function requireSignature() {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      if (!secret) {
        if (env.NODE_ENV === 'production') {
          throw forbidden('Request signing is not configured (REQUEST_SIGNING_SECRET)');
        }
        req.log.warn('request signing disabled: REQUEST_SIGNING_SECRET not set');
        return;
      }
      const claimedBodyHash = String(req.headers['x-request-body-hash'] ?? '');
      const actualBodyHash = bodyHash(req.rawBody ?? '');
      // Body integrity: the claimed hash must match the bytes actually
      // received, otherwise a signed header set could be paired with a
      // tampered payload.
      if (!claimedBodyHash || claimedBodyHash !== actualBodyHash) {
        throw unauthorized('Request signature invalid (body hash mismatch)');
      }
      const result = verifyRequest(
        {
          timestamp: String(req.headers['x-request-timestamp'] ?? ''),
          bodyHash: claimedBodyHash,
          signature: String(req.headers['x-request-signature'] ?? ''),
        },
        { method: req.method, path: req.url.split('?')[0] ?? '/' },
        secret,
        { clockSkewMs },
      );
      if (!result.ok) {
        req.log.warn({ reason: result.reason }, 'request signature verification failed');
        throw unauthorized(`Request signature invalid (${result.reason ?? 'unknown'})`);
      }
      void reply;
    };
  };
}