import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { anchors, sepTransactions, stellarAccounts } from '../../db/schema.js';
import { decryptSecret, encryptSecret } from '../../lib/crypto.js';
import { notFound } from '../../lib/errors.js';
import type { Container } from '../../server/container.js';
import { getAnchorJwt } from '../sep10/anchorAuth.js';
import type { SepProtocolPreference } from './Sep6Service.js';

const transferBody = z.object({
  anchor_id: z.string().uuid(),
  asset_code: z.string().min(1).max(12),
  account: z.string().regex(/^G[A-Z0-9]{55}$/),
  amount: z.string().regex(/^\d+(\.\d+)?$/).optional(),
  country_code: z.string().length(2).optional(),
  type: z.string().optional(),
  remittance_id: z.string().uuid().optional(),
  /** 'AUTO' prefers SEP-24 and falls back to SEP-6. */
  preference: z.enum(['AUTO', 'SEP24', 'SEP6']).optional(),
  anchor_jwt: z.string().optional(),
});

type TransferBody = z.infer<typeof transferBody>;

async function resolveAnchorJwt(c: Container, body: TransferBody): Promise<string> {
  if (body.anchor_jwt) {
    return body.anchor_jwt;
  }
  const anchorRows = await c.db
    .select()
    .from(anchors)
    .where(eq(anchors.id, body.anchor_id))
    .limit(1);
  if (anchorRows.length === 0) {
    throw notFound('Anchor not found');
  }
  const accountRows = await c.db
    .select()
    .from(stellarAccounts)
    .where(eq(stellarAccounts.public_key, body.account))
    .limit(1);
  if (accountRows.length === 0 || !accountRows[0]!.secret_encrypted) {
    throw notFound(
      'Custodial account required to authenticate with the anchor; pass anchor_jwt for non-custodial',
    );
  }
  return getAnchorJwt({
    anchor: anchorRows[0]!,
    account: body.account,
    secretEncrypted: accountRows[0]!.secret_encrypted,
  });
}

export function registerSep6Routes(app: FastifyInstance, c: Container): void {
  const programmatic = (kind: 'deposit' | 'withdraw') =>
    async (req: FastifyRequest) => {
      const body = transferBody.parse(req.body);
      const jwt = await resolveAnchorJwt(c, body);
      const result = await c.sep6[kind]({
        anchorId: body.anchor_id,
        assetCode: body.asset_code,
        account: body.account,
        amount: body.amount,
        countryCode: body.country_code,
        type: body.type,
        preference: (body.preference ?? 'AUTO') as SepProtocolPreference,
        jwt,
        userId: req.session!.sub,
        remittanceId: body.remittance_id,
      });
      if (body.remittance_id) {
        await c.remittance.onAnchorTransferStarted(body.remittance_id);
      }
      await c.db
        .update(sepTransactions)
        .set({ anchor_jwt_encrypted: encryptSecret(jwt), updated_at: new Date() })
        .where(eq(sepTransactions.id, result.id));
      return result;
    };

  app.post('/v1/sep6/deposit', {
    schema: { tags: ['sep6'], summary: 'Programmatic SEP-6 deposit (AUTO falls back to SEP-24)' },
  }, programmatic('deposit'));

  app.post('/v1/sep6/withdraw', {
    schema: { tags: ['sep6'], summary: 'Programmatic SEP-6 withdrawal (AUTO falls back to SEP-24)' },
  }, programmatic('withdraw'));

  app.get('/v1/sep6/transactions/:id', {
    schema: { tags: ['sep6'], summary: 'Look up a SEP-6 transaction' },
  }, async (req) => {
    const { id } = req.params as { id: string };
    const rows = await c.db
      .select()
      .from(sepTransactions)
      .where(eq(sepTransactions.id, id))
      .limit(1);
    if (rows.length === 0) {
      throw notFound('SEP-6 transaction not found');
    }
    const tx = rows[0]!;
    if (!tx.anchor_jwt_encrypted) {
      throw notFound('Anchor session expired; re-authenticate with the anchor');
    }
    return c.sep6.transactionStatus(
      tx.anchor_id!,
      tx.anchor_tx_id!,
      decryptSecret(tx.anchor_jwt_encrypted),
    );
  });
}