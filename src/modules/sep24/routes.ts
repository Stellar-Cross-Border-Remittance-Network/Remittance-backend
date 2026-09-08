import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { anchors, sepTransactions, stellarAccounts, type Anchor } from '../../db/schema.js';
import { decryptSecret, encryptSecret } from '../../lib/crypto.js';
import { notFound } from '../../lib/errors.js';
import type { Container } from '../../server/container.js';
import { getAnchorJwt } from '../sep10/anchorAuth.js';

const transferBody = z.object({
  anchor_id: z.string().uuid(),
  asset_code: z.string().min(1).max(12),
  account: z.string().regex(/^G[A-Z0-9]{55}$/),
  amount: z.string().regex(/^\d+(\.\d+)?$/).optional(),
  country_code: z.string().length(2).optional(),
  lang: z.string().max(8).optional(),
  on_change_callback: z.string().url().optional(),
  remittance_id: z.string().uuid().optional(),
  /** Anchor SEP-10 JWT — required for non-custodial accounts; optional otherwise. */
  anchor_jwt: z.string().optional(),
});

type TransferBody = z.infer<typeof transferBody>;

async function resolveAnchorJwt(
  c: Container,
  body: TransferBody,
): Promise<{ jwt: string; anchor: Anchor }> {
  const anchorRows = await c.db
    .select()
    .from(anchors)
    .where(eq(anchors.id, body.anchor_id))
    .limit(1);
  if (anchorRows.length === 0) {
    throw notFound('Anchor not found');
  }
  const anchor = anchorRows[0]!;
  if (body.anchor_jwt) {
    return { jwt: body.anchor_jwt, anchor };
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
  const jwt = await getAnchorJwt({
    anchor,
    account: body.account,
    secretEncrypted: accountRows[0]!.secret_encrypted,
  });
  return { jwt, anchor };
}

export function registerSep24Routes(app: FastifyInstance, c: Container): void {
  const interactive = (kind: 'deposit' | 'withdraw') =>
    async (req: FastifyRequest) => {
      const body = transferBody.parse(req.body);
      const { jwt } = await resolveAnchorJwt(c, body);
      const result = await c.sep24[kind]({
        anchorId: body.anchor_id,
        assetCode: body.asset_code,
        account: body.account,
        amount: body.amount,
        lang: body.lang,
        countryCode: body.country_code,
        onChangeCallback: body.on_change_callback,
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

  app.post('/v1/sep24/deposit', {
    schema: { tags: ['sep24'], summary: 'Start a SEP-24 deposit (interactive)' },
  }, interactive('deposit'));

  app.post('/v1/sep24/withdraw', {
    schema: { tags: ['sep24'], summary: 'Start a SEP-24 withdrawal (interactive)' },
  }, interactive('withdraw'));

  app.get('/v1/sep24/transactions/:id', {
    schema: { tags: ['sep24'], summary: 'Look up a SEP-24 transaction' },
  }, async (req) => {
    const { id } = req.params as { id: string };
    const rows = await c.db
      .select()
      .from(sepTransactions)
      .where(eq(sepTransactions.id, id))
      .limit(1);
    if (rows.length === 0) {
      throw notFound('SEP-24 transaction not found');
    }
    const tx = rows[0]!;
    if (!tx.anchor_jwt_encrypted) {
      throw notFound('Anchor session expired; re-authenticate with the anchor');
    }
    return c.sep24.transactionStatus(
      tx.anchor_id!,
      tx.anchor_tx_id!,
      decryptSecret(tx.anchor_jwt_encrypted),
    );
  });
}