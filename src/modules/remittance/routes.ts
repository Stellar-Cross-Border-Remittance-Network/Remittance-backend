import { eq, inArray } from 'drizzle-orm';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';

import { remittances, stellarAccounts, streamCursors } from '../../db/schema.js';
import type { Container } from '../../server/container.js';

interface RouteOptions {
  /** PreHandler factory from the request-signature plugin (internal ops). */
  requireSignature?: () => preHandlerHookHandler;
}

const quoteBody = z.object({
  source_asset: z.string().min(1),
  destination_asset: z.string().min(1),
  source_amount: z.string().regex(/^\d+(\.\d+)?$/, 'source_amount must be a decimal string'),
  source_country: z.string().length(2),
  destination_country: z.string().length(2),
  anchor_id: z.string().uuid().optional(),
});

const createBody = z.object({
  quote_id: z.string().uuid(),
  // Optional — the backend resolves the user's default account when omitted
  // (the mobile app relies on this).
  sender_account_id: z.string().uuid().optional(),
  recipient_address: z.string().min(1),
  recipient_stellar_account: z.string().regex(/^G[A-Z0-9]{55}$/),
  anchor_id: z.string().uuid().optional(),
  corridor: z.string().min(2).max(16).optional(),
});

const confirmBody = z.object({
  tx_hash: z.string().min(1),
  method: z.enum(['create_remittance', 'fund_remittance']),
});

const relayBody = z.object({
  signed_xdr: z.string().min(1),
  method: z.enum(['create_remittance', 'fund_remittance', 'refund']),
});

export function registerRemittanceRoutes(app: FastifyInstance, c: Container, opts: RouteOptions = {}): void {
  app.post('/v1/remittances/quote', {
    schema: {
      tags: ['remittances'],
      summary: 'Create a quote (persisted with hash integrity and expiry)',
      body: { type: 'object', required: ['source_asset', 'destination_asset', 'source_amount', 'source_country', 'destination_country'] },
    },
  }, async (req) => {
    const body = quoteBody.parse(req.body);
    return c.quotes.createQuote(
      {
        sourceAsset: body.source_asset,
        destinationAsset: body.destination_asset,
        sourceAmount: body.source_amount,
        sourceCountry: body.source_country,
        destinationCountry: body.destination_country,
        anchorId: body.anchor_id,
      },
      req.session!.sub,
    );
  });

  app.post('/v1/remittances', {
    schema: {
      tags: ['remittances'],
      summary: 'Create a remittance from an accepted quote (invokes the Soroban contract)',
      // sender_account_id is optional — the backend resolves the session's
      // default account (the mobile app relies on this). The OpenAPI schema
      // must mirror the Zod shape or Fastify rejects valid requests.
      body: { type: 'object', required: ['quote_id', 'recipient_address', 'recipient_stellar_account'] },
    },
  }, async (req) => {
    const body = createBody.parse(req.body);
    return c.remittance.create(
      {
        quoteId: body.quote_id,
        senderAccountId: body.sender_account_id,
        recipientAddress: body.recipient_address,
        recipientStellarAccount: body.recipient_stellar_account,
        anchorId: body.anchor_id,
        corridor: body.corridor,
      },
      req.session!.sub,
    );
  });

  app.get('/v1/remittances/:id', {
    schema: { tags: ['remittances'], summary: 'Get a remittance with live on-chain status' },
  }, async (req) => {
    const { id } = req.params as { id: string };
    return c.remittance.get(id, req.session!.sub);
  });

  app.get('/v1/remittances/:id/events', {
    schema: { tags: ['remittances'], summary: 'Event feed (anchor, stellar, soroban, audit, payments)' },
  }, async (req) => {
    const { id } = req.params as { id: string };
    return c.remittance.events(id, req.session!.sub);
  });

  app.post('/v1/remittances/:id/fund', {
    schema: { tags: ['remittances'], summary: 'Fund the on-chain escrow' },
  }, async (req) => {
    const { id } = req.params as { id: string };
    return c.remittance.fund(id, req.session!.sub);
  });

  app.post('/v1/remittances/:id/release', {
    schema: { tags: ['remittances'], summary: 'Release the escrow (requires SETTLEMENT_AUTHORIZED)' },
  }, async (req) => {
    const { id } = req.params as { id: string };
    return c.remittance.release(id, req.session!.sub);
  });

  app.post('/v1/remittances/:id/refund', {
    schema: { tags: ['remittances'], summary: 'Refund the escrow to the sender' },
  }, async (req) => {
    const { id } = req.params as { id: string };
    return c.remittance.refund(id, req.session!.sub);
  });

  app.post('/v1/remittances/:id/confirm-soroban', {
    schema: {
      tags: ['remittances'],
      summary: 'Confirm an in-app signed Soroban submission (non-custodial path)',
      body: { type: 'object', required: ['tx_hash', 'method'], properties: { tx_hash: { type: 'string' }, method: { type: 'string' } } },
    },
  }, async (req) => {
    const { id } = req.params as { id: string };
    const body = confirmBody.parse(req.body);
    await c.remittance.confirmSorobanSubmission(id, { txHash: body.tx_hash, method: body.method }, req.session!.sub);
    return { ok: true };
  });

  // Non-custodial path: prepare an envelope the app signs on-device, then
  // relay the signed envelope back for submission + on-chain verification.
  app.post('/v1/remittances/:id/prepare-fund', {
    schema: {
      tags: ['remittances'],
      summary: 'Prepare the fund_remittance envelope for on-device signing (non-custodial)',
    },
  }, async (req) => {
    const { id } = req.params as { id: string };
    return c.remittance.prepareFund(id, req.session!.sub);
  });

  app.post('/v1/remittances/:id/prepare-refund', {
    schema: {
      tags: ['remittances'],
      summary: 'Prepare the sender-cancel refund envelope for on-device signing (non-custodial)',
    },
  }, async (req) => {
    const { id } = req.params as { id: string };
    return c.remittance.prepareRefund(id, req.session!.sub);
  });

  app.post('/v1/remittances/:id/relay', {
    schema: {
      tags: ['remittances'],
      summary: 'Submit a client-signed Soroban envelope and verify on-chain state (non-custodial)',
      body: { type: 'object', required: ['signed_xdr', 'method'], properties: { signed_xdr: { type: 'string' }, method: { type: 'string' } } },
    },
  }, async (req) => {
    const { id } = req.params as { id: string };
    const body = relayBody.parse(req.body);
    return c.remittance.relay(id, { signedXdr: body.signed_xdr, method: body.method }, req.session!.sub);
  });

  // Path payment planning (real Horizon paths only) — used by the app's send flow.
  app.post('/v1/path-payments/plan', {
    schema: {
      tags: ['path-payments'],
      summary: 'Find real PathPaymentStrictSend paths via Horizon',
      body: {
        type: 'object',
        required: ['send_asset', 'send_amount', 'dest_asset', 'dest_account'],
        properties: {
          send_asset: { type: 'string' },
          send_amount: { type: 'string' },
          dest_asset: { type: 'string' },
          dest_account: { type: 'string' },
        },
      },
    },
  }, async (req) => {
    const body = z
      .object({
        send_asset: z.string().min(1),
        send_amount: z.string().regex(/^\d+(\.\d+)?$/),
        dest_asset: z.string().min(1),
        dest_account: z.string().regex(/^G[A-Z0-9]{55}$/),
      })
      .parse(req.body);
    return c.pathPayments.plan({
      sendAsset: body.send_asset,
      sendAmount: body.send_amount,
      destAsset: body.dest_asset,
      destAccount: body.dest_account,
    });
  });

  // The app's activity feed: scoped to the authenticated session's Stellar
  // account (the SEP-10 session `account` claim). Never expose other users'
  // remittances through an authenticated endpoint.
  app.get('/v1/internal/remittances', {
    schema: { tags: ['internal'], summary: 'The caller\u2019s own remittances (activity feed)' },
  }, async (req) => {
    const account = req.session!.account ?? req.session!.sub;
    const accountRows = await c.db
      .select({ id: stellarAccounts.id })
      .from(stellarAccounts)
      .where(eq(stellarAccounts.public_key, account))
      .limit(1);
    if (accountRows.length === 0) {
      return [];
    }
    const rows = await c.db
      .select()
      .from(remittances)
      .where(inArray(remittances.sender_account_id, accountRows.map((r) => r.id)));
    return rows.map((r) => ({ id: r.id, status: r.status, lifecycle: r.lifecycle, contract_remittance_id: r.contract_remittance_id }));
  });

  app.get('/v1/internal/stream-cursors', {
    schema: { tags: ['internal'] },
  }, async () => {
    const rows = await c.db.select().from(streamCursors);
    return rows;
  });

  app.post('/v1/internal/reconcile', {
    schema: { tags: ['internal'], summary: 'Trigger a polling reconciliation pass (signed)' },
    ...(opts.requireSignature ? { preHandler: [opts.requireSignature()] } : {}),
  }, async () => {
    const accounts = (await c.db.select().from(streamCursors)).map((r) => r.account);
    const processed = await c.reconciler.reconcileAll(accounts);
    return { accounts, processed };
  });
}

export async function internalRemittanceLookup(c: Container, contractRemittanceId: string) {
  const rows = await c.db
    .select({ id: remittances.id })
    .from(remittances)
    .where(eq(remittances.contract_remittance_id, contractRemittanceId))
    .limit(1);
  return rows[0]?.id ?? null;
}