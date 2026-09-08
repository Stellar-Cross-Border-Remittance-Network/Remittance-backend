import jwt from 'jsonwebtoken';

import { loadEnv } from '../config/env.js';
import { unauthorized } from '../lib/errors.js';
import type { Role } from './roles.js';

export interface SessionClaims {
  sub: string; // user id
  role: Role;
  /** Address used in the SEP-10 challenge; null for server-issued sessions. */
  account?: string;
  /** Session kind so custodial vs non-custodial auth can be audited. */
  custody?: 'non_custodial' | 'custodial';
  iat: number;
  exp: number;
}

export interface JwtService {
  sign(subject: string, role: Role, extra?: Partial<SessionClaims>): string;
  verify(token: string): SessionClaims;
}

export function createJwtService(): JwtService {
  const env = loadEnv();
  return {
    sign(subject, role, extra = {}) {
      return jwt.sign(
        { role, ...extra } as object,
        env.JWT_SECRET,
        { subject, expiresIn: env.JWT_EXPIRES_IN, issuer: 'remittance-backend' } as jwt.SignOptions,
      );
    },
    verify(token) {
      try {
        return jwt.verify(token, env.JWT_SECRET, {
          issuer: 'remittance-backend',
          // Pin the algorithm so a downgrade to 'none' or a symmetric-key
          // confusion attack is structurally impossible.
          algorithms: ['HS256'],
        }) as SessionClaims;
      } catch {
        throw unauthorized('Invalid or expired session');
      }
    },
  };
}