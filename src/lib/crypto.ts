import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import { loadEnv } from '../config/env.js';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

function keyMaterial(): Buffer {
  // Accepts a hex or a plain string; normalizes to a 32-byte key.
  const raw = Buffer.from(loadEnv().ENCRYPTION_KEY, 'hex');
  if (raw.length === 32) {
    return raw;
  }
  return createHash('sha256').update(loadEnv().ENCRYPTION_KEY).digest();
}

/**
 * Encrypt a secret at rest. Output format: `v1:<base64(iv)>:<base64(tag)>:<base64(ciphertext)>`.
 * Never store provider credentials or signing secrets in plaintext.
 */
export function encryptSecret(plaintext: string): string {
  const key = keyMaterial();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [
    'v1',
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    ciphertext.toString('base64'),
  ].join(':');
}

export function decryptSecret(payload: string): string {
  const [version, ivB64, tagB64, ctB64] = payload.split(':');
  if (version !== 'v1' || !ivB64 || !tagB64 || !ctB64) {
    throw new Error('Unsupported or malformed encrypted payload');
  }
  const key = keyMaterial();
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ctB64, 'base64')),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function randomBytesHex(length = 32): string {
  return randomBytes(length).toString('hex');
}

/** Constant-time comparison for challenge/signature material. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    return false;
  }
  return ab.equals(bb);
}