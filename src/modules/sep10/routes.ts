import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { stellarAccounts } from '../../db/schema.js';
import { forbidden, notFound } from '../../lib/errors.js';
import type { Container } from '../../server/container.js';

const challengeBody = z.object({
  account: z.string().regex(/^G[A-Z0-9]{55}$/, 'Invalid Stellar account'),
  memo: z.string().max(28).optional(),
});

const verifyBody = z.object({
  transaction: z.string().min(1),
  account: z.string().regex(/^G[A-Z0-9]{55}$/, 'Invalid Stellar account'),
  custody: z.enum(['non_custodial', 'custodial']).optional(),
});

export function registerSep10Routes(app: FastifyInstance, c: Container): void {
  app.post(
    '/v1/sep10/challenge',
    {
      schema: {
        tags: ['sep10'],
        summary: 'Request a SEP-10 challenge for an account',
        body: {
          type: 'object',
          required: ['account'],
          properties: { account: { type: 'string' }, memo: { type: 'string' } },
        },
      },
    },
    async (req) => {
      const body = challengeBody.parse(req.body);
      return c.sep10.challenge(body.account, body.memo);
    },
  );

  app.post(
    '/v1/sep10/verify',
    {
      schema: {
        tags: ['sep10'],
        summary: 'Verify a signed SEP-10 challenge and receive a session JWT',
        body: {
          type: 'object',
          required: ['transaction', 'account'],
          properties: {
            transaction: { type: 'string' },
            account: { type: 'string' },
            custody: { type: 'string', enum: ['non_custodial', 'custodial'] },
          },
        },
      },
    },
    async (req) => {
      const body = verifyBody.parse(req.body);
      let secretEncrypted: string | undefined;
      let userId: string | undefined;
      if (body.custody === 'custodial') {
        // Look up the stored account secret for the given address.
        const rows = await c.db
          .select()
          .from(stellarAccounts)
          .where(eq(stellarAccounts.public_key, body.account))
          .limit(1);
        if (rows.length === 0) {
          throw notFound('Stellar account is not registered with this service');
        }
        secretEncrypted = rows[0]!.secret_encrypted ?? undefined;
        userId = rows[0]!.user_id;
        if (!secretEncrypted) {
          throw forbidden('Account is not custodial');
        }
      }
      return c.sep10.verify({ ...body, secretEncrypted, userId });
    },
  );
}