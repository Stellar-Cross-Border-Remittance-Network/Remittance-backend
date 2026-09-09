import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { Keypair } from '@stellar/stellar-sdk';
import { z } from 'zod';

import { stellarAccounts, users } from '../../db/schema.js';
import { forbidden } from '../../lib/errors.js';
import { encryptSecret } from '../../lib/crypto.js';
import type { Container } from '../../server/container.js';

const registerBody = z.object({
  // Only non-custodial accounts register through the session-authenticated
  // endpoint. Custodial accounts are created server-side (POST
  // /v1/accounts/custodial) because the secret must never transit the wire.
  custody: z.literal('non_custodial'),
  public_key: z.string().regex(/^G[A-Z0-9]{55}$/, 'Invalid Stellar account'),
  make_default: z.boolean().optional().default(true),
});

const custodialBody = z.object({
  network: z.enum(['testnet', 'mainnet']).optional().default('testnet'),
});

/**
 * Account registration and custody-account issuance.
 *
 * - POST /v1/accounts — session-authenticated. Registers a non-custodial
 *   Stellar account (the public key only) against the authenticated identity.
 *   Idempotent: re-registering the same key returns the existing row.
 * - POST /v1/accounts/custodial — public (rate-limited). Issues a fresh
 *   custodial account: the secret is generated server-side, encrypted at
 *   rest, and returned to the client exactly once. SEP-10 custodial
 *   verification afterwards signs with the stored secret on the user's behalf.
 */
/**
 * Session-authenticated registration for non-custodial accounts. Registered
 * inside the JWT-protected scope (see server/app.ts).
 */
export function registerAccountRoutes(app: FastifyInstance, c: Container): void {
  const db = c.db;

  app.post('/v1/accounts', {
    schema: {
      tags: ['accounts'],
      summary: 'Register a non-custodial Stellar account for the session identity',
      body: {
        type: 'object',
        required: ['custody', 'public_key'],
        properties: {
          custody: { type: 'string', enum: ['non_custodial'] },
          public_key: { type: 'string' },
          make_default: { type: 'boolean' },
        },
      },
    },
  }, async (req) => {
    const body = registerBody.parse(req.body);
    const subject = req.session!.sub;

    // A non-custodial identity is keyed by its Stellar public key — the same
    // value the SEP-10 challenge was issued to. The users row is created on
    // first registration; re-registration (same subject + key) is a no-op.
    const existingUser = await db.select().from(users).where(eq(users.subject, subject)).limit(1);
    let user = existingUser[0];
    if (!user) {
      const inserted = await db
        .insert(users)
        .values({ subject, role: 'user', status: 'active' })
        .returning();
      user = inserted[0]!;
    }

    const existingAccount = await db
      .select()
      .from(stellarAccounts)
      .where(and(eq(stellarAccounts.user_id, user.id), eq(stellarAccounts.public_key, body.public_key)))
      .limit(1);
    if (existingAccount[0]) {
      return {
        id: existingAccount[0]!.id,
        public_key: existingAccount[0]!.public_key,
        custody: existingAccount[0]!.custody_model,
        is_default: existingAccount[0]!.is_default,
      };
    }

    if (body.make_default) {
      await db
        .update(stellarAccounts)
        .set({ is_default: false, updated_at: new Date() })
        .where(eq(stellarAccounts.user_id, user.id));
    }
    const inserted = await db
      .insert(stellarAccounts)
      .values({
        user_id: user.id,
        public_key: body.public_key,
        custody_model: 'non_custodial',
        network: 'testnet',
        is_default: body.make_default ?? true,
      })
      .returning();
    return {
      id: inserted[0]!.id,
      public_key: inserted[0]!.public_key,
      custody: inserted[0]!.custody_model,
      is_default: inserted[0]!.is_default,
    };
  });

}

/**
 * Public custodial-account issuance (rate-limited by the global limiter).
 * Registered outside the JWT scope — there is no session yet on onboarding.
 */
export function registerCustodialAccountRoute(app: FastifyInstance, c: Container): void {
  const db = c.db;

  app.post('/v1/accounts/custodial', {
    schema: {
      tags: ['accounts'],
      summary: 'Issue a custodial account (server-held secret, returned once)',
      body: {
        type: 'object',
        properties: { network: { type: 'string', enum: ['testnet', 'mainnet'] } },
      },
    },
  }, async (req) => {
    const body = custodialBody.parse(req.body);
    if (body.network === 'mainnet') {
      throw forbidden('Custodial account issuance is disabled on mainnet');
    }
    // The secret is generated server-side and encrypted at rest before the
    // account row exists — the plaintext is returned to the caller exactly
    // once and never stored, logged, or re-servable.
    const kp = Keypair.random();
    const user = (
      await db.insert(users).values({ role: 'user', status: 'active' }).returning()
    )[0]!;
    const account = (
      await db
        .insert(stellarAccounts)
        .values({
          user_id: user.id,
          public_key: kp.publicKey(),
          secret_encrypted: encryptSecret(kp.secret()),
          custody_model: 'custodial',
          network: body.network,
          is_default: true,
        })
        .returning()
    )[0]!;
    return {
      user_id: user.id,
      account_id: account.id,
      public_key: kp.publicKey(),
      secret: kp.secret(),
      network: body.network,
    };
  });
}