import { createHmac, createHash } from 'node:crypto';

import { safeEqual } from './crypto.js';

/**
 * Request signing for machine-to-machine calls (internal ops, webhooks from
 * counterparties, cross-service RPC). A request is signed with an HMAC-SHA256
 * over a canonical string of method + path + timestamp + body hash, carried
 * in headers, and verified constant-time with a bounded clock skew so a
 * captured signature cannot be replayed later.
 *
 * Header contract:
 *   X-Request-Timestamp  — unix ms (signer clock)
 *   X-Request-Body-Hash  — sha256 hex of the raw body ('' for empty)
 *   X-Request-Signature  — `v1:<hex hmac-sha256>`
 */

export interface SignableRequest {
  method: string;
  path: string;
  timestampMs: number;
  bodyHash: string;
}

export function bodyHash(body: string): string {
  return createHash('sha256').update(body ?? '').digest('hex');
}

function canonical(req: SignableRequest): string {
  return [req.method.toUpperCase(), req.path, String(req.timestampMs), req.bodyHash].join('\n');
}

/** Produce the `v1:<hex>` signature for a request. */
export function signRequest(req: SignableRequest, secret: string): string {
  const mac = createHmac('sha256', secret).update(canonical(req)).digest('hex');
  return `v1:${mac}`;
}

export interface VerificationResult {
  ok: boolean;
  reason?: 'missing_headers' | 'malformed_signature' | 'clock_skew' | 'invalid_signature';
}

/** Verify headers against the shared secret and a bounded clock skew. */
export function verifyRequest(
  headers: {
    timestamp?: string;
    bodyHash?: string;
    signature?: string;
    /** Header-name spellings (X-Request-*) are also accepted. */
    'X-Request-Timestamp'?: string;
    'X-Request-Body-Hash'?: string;
    'X-Request-Signature'?: string;
  },
  req: { method: string; path: string },
  secret: string,
  opts: { clockSkewMs?: number } = {},
): VerificationResult {
  const clockSkewMs = opts.clockSkewMs ?? 300_000; // 5 min default
  const timestamp = headers.timestamp ?? headers['X-Request-Timestamp'];
  const bodyHashHeader = headers.bodyHash ?? headers['X-Request-Body-Hash'];
  const signature = headers.signature ?? headers['X-Request-Signature'];
  if (!timestamp || !bodyHashHeader || !signature) {
    return { ok: false, reason: 'missing_headers' };
  }
  if (!signature.startsWith('v1:')) {
    return { ok: false, reason: 'malformed_signature' };
  }
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > clockSkewMs) {
    return { ok: false, reason: 'clock_skew' };
  }
  const expected = signRequest(
    { method: req.method, path: req.path, timestampMs: ts, bodyHash: bodyHashHeader },
    secret,
  );
  if (!safeEqual(signature, expected)) {
    return { ok: false, reason: 'invalid_signature' };
  }
  return { ok: true };
}

/** Convenience: canonicalize a raw JSON body for signing. */
export function signJsonBody(body: unknown, method: string, path: string, secret: string, now = Date.now()): {
  headers: Record<string, string>;
} {
  const raw = JSON.stringify(body ?? {});
  const hash = bodyHash(raw);
  return {
    headers: {
      'X-Request-Timestamp': String(now),
      'X-Request-Body-Hash': hash,
      'X-Request-Signature': signRequest({ method, path, timestampMs: now, bodyHash: hash }, secret),
    },
  };
}