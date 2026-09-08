import { describe, expect, it } from 'vitest';

import { bodyHash, signJsonBody, signRequest, verifyRequest } from '../../src/lib/requestSigning.js';

const SECRET = 'test-signing-secret';

describe('request signing', () => {
  const method = 'POST';
  const path = '/v1/internal/reconcile';

  it('signs and verifies a request', () => {
    const body = { accounts: ['GAAA', 'GBBB'] };
    const { headers } = signJsonBody(body, method, path, SECRET);
    const result = verifyRequest(
      headers,
      { method, path },
      SECRET,
    );
    expect(result.ok).toBe(true);
  });

  it('rejects a tampered body hash', () => {
    const { headers } = signJsonBody({ accounts: ['GAAA'] }, method, path, SECRET);
    const result = verifyRequest(
      { ...headers, 'X-Request-Body-Hash': bodyHash(JSON.stringify({ accounts: ['GBBB'] })) },
      { method, path },
      SECRET,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('invalid_signature');
  });

  it('rejects a signature made with a different secret', () => {
    const { headers } = signJsonBody({}, method, path, 'other-secret');
    const result = verifyRequest(headers, { method, path }, SECRET);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('invalid_signature');
  });

  it('rejects replayed signatures outside the clock skew window', () => {
    const old = Date.now() - 3600_000; // 1 hour ago
    const signature = signRequest(
      { method, path, timestampMs: old, bodyHash: bodyHash('') },
      SECRET,
    );
    const result = verifyRequest(
      { 'X-Request-Timestamp': String(old), 'X-Request-Body-Hash': bodyHash(''), 'X-Request-Signature': signature },
      { method, path },
      SECRET,
      { clockSkewMs: 300_000 },
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('clock_skew');
  });

  it('accepts signatures inside the skew window', () => {
    const recent = Date.now() - 60_000;
    const signature = signRequest(
      { method, path, timestampMs: recent, bodyHash: bodyHash('') },
      SECRET,
    );
    const result = verifyRequest(
      { 'X-Request-Timestamp': String(recent), 'X-Request-Body-Hash': bodyHash(''), 'X-Request-Signature': signature },
      { method, path },
      SECRET,
      { clockSkewMs: 300_000 },
    );
    expect(result.ok).toBe(true);
  });

  it('rejects missing headers', () => {
    const result = verifyRequest({}, { method, path }, SECRET);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('missing_headers');
  });

  it('rejects malformed signatures', () => {
    const { headers } = signJsonBody({}, method, path, SECRET);
    const result = verifyRequest({ ...headers, 'X-Request-Signature': 'v2:abc' }, { method, path }, SECRET);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('malformed_signature');
  });

  it('is sensitive to the path', () => {
    const { headers } = signJsonBody({}, method, '/v1/internal/other', SECRET);
    const result = verifyRequest(headers, { method, path }, SECRET);
    expect(result.ok).toBe(false);
  });
});