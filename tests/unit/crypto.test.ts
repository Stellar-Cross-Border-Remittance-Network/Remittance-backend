import { describe, expect, it } from 'vitest';

import { decryptSecret, encryptSecret, safeEqual, sha256Hex } from '../../src/lib/crypto.js';

describe('crypto (AES-256-GCM at rest)', () => {
  it('round-trips secrets through encrypt/decrypt', () => {
    const secret = 'S' + 'A'.repeat(55);
    const encrypted = encryptSecret(secret);
    expect(encrypted.startsWith('v1:')).toBe(true);
    expect(encrypted).not.toContain(secret);
    expect(decryptSecret(encrypted)).toBe(secret);
  });

  it('produces a different ciphertext each time (random IV)', () => {
    const a = encryptSecret('same-secret');
    const b = encryptSecret('same-secret');
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe(decryptSecret(b));
  });

  it('rejects tampered ciphertext', () => {
    const encrypted = encryptSecret('secret-value');
    const tampered = encrypted.slice(0, -2) + (encrypted.endsWith('AA') ? 'BB' : 'AA');
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it('rejects malformed payloads', () => {
    expect(() => decryptSecret('not-a-payload')).toThrow();
    expect(() => decryptSecret('v2:foo:bar:baz')).toThrow();
  });

  it('sha256Hex is deterministic', () => {
    expect(sha256Hex('abc')).toBe(sha256Hex('abc'));
    expect(sha256Hex('abc')).toHaveLength(64);
    expect(sha256Hex('abc')).not.toBe(sha256Hex('abd'));
  });

  it('safeEqual is constant-time and correct', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});