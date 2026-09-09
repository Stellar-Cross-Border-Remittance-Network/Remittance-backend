import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyInstance } from 'fastify';

import { authPlugin } from '../auth/guard.js';
import { loadEnv } from '../config/env.js';
import { users } from '../db/schema.js';
import { isAppError } from '../lib/errors.js';
import { registerAccountRoutes, registerCustodialAccountRoute } from '../modules/accounts/routes.js';
import { registerAnchorRoutes } from '../modules/anchors/routes.js';
import { registerRemittanceRoutes } from '../modules/remittance/routes.js';
import { registerSep6Routes } from '../modules/sep6/routes.js';
import { registerSep10Routes } from '../modules/sep10/routes.js';
import { registerSep24Routes } from '../modules/sep24/routes.js';
import type { Container } from './container.js';
import { requestSignaturePlugin } from './plugins/requestSignature.js';

export async function buildApp(container: Container): Promise<FastifyInstance> {
  const env = loadEnv();
  const app = Fastify({
    // Fastify v5 accepts logger options, not a pino instance.
    logger:
      env.NODE_ENV === 'test'
        ? { level: 'silent' }
        : {
            level: env.LOG_LEVEL,
            base: { service: 'remittance-backend' },
            ...(env.NODE_ENV === 'development'
              ? {
                  transport: {
                    target: 'pino-pretty',
                    options: { colorize: true, translateTime: 'SYS:HH:MM:ss' },
                  },
                }
              : {}),
          },
    trustProxy: true,
    bodyLimit: 1_048_576,
  });

  const requireSignature = await requestSignaturePlugin(app);

  await app.register(sensible);
  await app.register(cors, { origin: true });
  await app.register(rateLimit, {
    max: 120,
    timeWindow: '1 minute',
    errorResponseBuilder: () => ({
      statusCode: 429,
      code: 'RATE_LIMITED',
      error: 'Too Many Requests',
      message: 'Rate limit exceeded — slow down',
    }),
  });
  await app.register(jwt, { secret: env.JWT_SECRET });
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'remittance-backend',
        description: 'Stellar-native cross-border remittance backend (SEP-1/6/10/24, Horizon streaming, quotes, path payments, Soroban escrow).',
        version: '1.0.0',
      },
      servers: [{ url: `http://localhost:${env.PORT}` }],
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        },
      },
    },
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  // Money travels as integer stroops internally (bigint) but the JSON API
  // must never emit raw BigInt (JSON.stringify would throw). Convert deep.
  function stringifyBigInts(value: unknown): unknown {
    if (typeof value === 'bigint') {
      return value.toString();
    }
    if (Array.isArray(value)) {
      return value.map(stringifyBigInts);
    }
    // Leave Date (and other non-plain objects) untouched so Fastify's
    // serializer turns them into ISO strings. Rebuilding them from
    // Object.entries would flatten a Date into an empty object.
    if (value && typeof value === 'object' && value.constructor === Object) {
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, stringifyBigInts(v)]),
      );
    }
    return value;
  }
  app.addHook('preSerialization', async (_req, _reply, payload) => stringifyBigInts(payload));

  // Error normalization: AppError -> stable JSON shape; ZodError -> 422.
  app.setErrorHandler((err, req, reply) => {
    if (isAppError(err)) {
      req.log.warn({ code: err.code, status: err.statusCode, details: err.details }, err.message);
      return reply.status(err.statusCode).send({
        code: err.code,
        message: err.message,
        ...(err.details !== undefined ? { details: err.details } : {}),
      });
    }
    const isZod = err && typeof err === 'object' && 'name' in err && (err as { name: string }).name === 'ZodError';
    const isFastifyValidation =
      err && typeof err === 'object' && 'validation' in err && Array.isArray((err as { validation: unknown[] }).validation);
    if (isZod) {
      const issues = (
        err as unknown as { issues: Array<{ path: (string | number)[]; message: string }> }
      ).issues;
      return reply.status(422).send({
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    if (isFastifyValidation) {
      const validation = (err as { validation: Array<{ instancePath: string; message: string }> }).validation;
      return reply.status(422).send({
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: validation.map((v) => ({ path: v.instancePath, message: v.message })),
      });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ code: 'INTERNAL_ERROR', message: 'Internal server error' });
  });

  app.get('/health', {
    schema: { tags: ['ops'], summary: 'Liveness + readiness' },
  }, async () => {
    await container.db.select({ ok: users.id }).from(users).limit(1);
    return { status: 'ok', service: 'remittance-backend', network: env.NETWORK };
  });

  // Public SEP-10 challenge/verify (auth issuance) + custodial onboarding
  // (rate-limited; no session exists yet).
  app.register(async (publicApp) => {
    registerSep10Routes(publicApp, container);
    registerCustodialAccountRoute(publicApp, container);
  });

  // Everything else requires a session JWT.
  app.register(async (authed) => {
    await authed.register(authPlugin);
    registerAccountRoutes(authed, container);
    registerAnchorRoutes(authed, container);
    registerRemittanceRoutes(authed, container, { requireSignature });
    registerSep24Routes(authed, container);
    registerSep6Routes(authed, container);
  });

  return app;
}