import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

import { forbidden, unauthorized } from '../lib/errors.js';
import { hasPermission, isRole } from './roles.js';
import type { SessionClaims } from './jwt.js';

declare module 'fastify' {
  interface FastifyRequest {
    session?: SessionClaims;
  }
}

/**
 * Verifies `Authorization: Bearer <jwt>` on every request and attaches
 * `request.session`. Per-route permission checks use `requirePermission`.
 */
export const authPlugin: FastifyPluginAsync = fp(async (app) => {
  app.decorateRequest('session', undefined);
  app.addHook('onRequest', async (req) => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      throw unauthorized('Missing bearer token');
    }
    const token = header.slice('Bearer '.length).trim();
    req.session = app.jwt.verify<SessionClaims>(token);
  });
});

export function requirePermission(permission: string) {
  return async (req: { session?: SessionClaims }): Promise<void> => {
    const session = req.session;
    if (!session) {
      throw unauthorized();
    }
    if (!isRole(session.role) || !hasPermission(session.role, permission)) {
      throw forbidden(`Missing permission: ${permission}`);
    }
  };
}

/** Admin-only short-hand for route configs. */
export const requireAdmin = requirePermission('remittance:*');