import { describe, expect, it } from 'vitest';

import { Keypair } from '@stellar/stellar-sdk';

import { encryptSecret } from '../../src/lib/crypto.js';
import { AppError } from '../../src/lib/errors.js';
import { createQuoteService } from '../../src/modules/quotes/QuoteService.js';
import { createRemittanceService } from '../../src/modules/remittance/RemittanceService.js';
import { createFakeSoroban } from '../helpers/fakeSoroban.js';
import { createTestDb } from '../helpers/testDb.js';

const SENDER = Keypair.random();
const RECIPIENT = Keypair.random();

async function seedUser(db: Awaited<ReturnType<typeof createTestDb>>, custodial: boolean) {
  const { users, stellarAccounts } = await import('../../src/db/schema.js');
  const user = await db.insert(users).values({ email: 'bob@example.com' }).returning({ id: users.id });
  const account = await db
    .insert(stellarAccounts)
    .values({
      user_id: user[0]!.id,
      public_key: SENDER.publicKey(),
      secret_encrypted: custodial ? encryptSecret(SENDER.secret()) : null,
      custody_model: custodial ? 'custodial' : 'non_custodial',
    })
    .returning({ id: stellarAccounts.id });
  return { userId: user[0]!.id, accountId: account[0]!.id };
}

async function makeQuote(db: Awaited<ReturnType<typeof createTestDb>>) {
  const quotesService = createQuoteService(db);
  const quote = await quotesService.createQuote({
    sourceAsset: 'USDC:GUSDC',
    destinationAsset: 'NGN:GNGN',
    sourceAmount: '100',
    sourceCountry: 'US',
    destinationCountry: 'NG',
  });
  return { quotesService, quote };
}

describe('remittance orchestration', () => {
  it('creates a custodial remittance and invokes the contract', async () => {
    const db = await createTestDb();
    const { userId, accountId } = await seedUser(db, true);
    const { quotesService, quote } = await makeQuote(db);
    const soroban = createFakeSoroban();
    const service = createRemittanceService(db, quotesService, soroban.fake);

    const created = await service.create(
      {
        quoteId: quote.id!,
        senderAccountId: accountId,
        recipientAddress: '+234...',
        recipientStellarAccount: RECIPIENT.publicKey(),
      },
      userId,
    );
    expect(created.status).toBe('CREATED');
    expect(created.contract_remittance_id).toBe('0');
    expect(soroban.calls).toContain('create_remittance');
  });

  it('funds a custodial remittance through the contract', async () => {
    const db = await createTestDb();
    const { userId, accountId } = await seedUser(db, true);
    const { quotesService, quote } = await makeQuote(db);
    const soroban = createFakeSoroban();
    const service = createRemittanceService(db, quotesService, soroban.fake);

    const { id } = (await service.create(
      { quoteId: quote.id!, senderAccountId: accountId, recipientAddress: 'r', recipientStellarAccount: RECIPIENT.publicKey() },
      userId,
    )) as { id: string };

    const funded = await service.fund(id, userId);
    expect(funded.status).toBe('FUNDED');
    expect(soroban.calls).toContain('fund_remittance:0');
    expect(soroban.records.get('0')?.status).toBe('Funded');
  });

  it('refunds a funded remittance back to the sender', async () => {
    const db = await createTestDb();
    const { userId, accountId } = await seedUser(db, true);
    const { quotesService, quote } = await makeQuote(db);
    const soroban = createFakeSoroban();
    const service = createRemittanceService(db, quotesService, soroban.fake);

    const { id } = (await service.create(
      { quoteId: quote.id!, senderAccountId: accountId, recipientAddress: 'r', recipientStellarAccount: RECIPIENT.publicKey() },
      userId,
    )) as { id: string };
    await service.fund(id, userId);
    const refunded = await service.refund(id, userId);
    expect(refunded.status).toBe('REFUNDED');
    expect(soroban.calls).toContain('refund:0');
    expect(soroban.records.get('0')?.status).toBe('Refunded');
  });

  it('cannot refund before funding', async () => {
    const db = await createTestDb();
    const { userId, accountId } = await seedUser(db, true);
    const { quotesService, quote } = await makeQuote(db);
    const soroban = createFakeSoroban();
    const service = createRemittanceService(db, quotesService, soroban.fake);

    const { id } = (await service.create(
      { quoteId: quote.id!, senderAccountId: accountId, recipientAddress: 'r', recipientStellarAccount: RECIPIENT.publicKey() },
      userId,
    )) as { id: string };
    await expect(service.refund(id, userId)).rejects.toThrow(AppError);
  });

  it('cannot fund twice', async () => {
    const db = await createTestDb();
    const { userId, accountId } = await seedUser(db, true);
    const { quotesService, quote } = await makeQuote(db);
    const soroban = createFakeSoroban();
    const service = createRemittanceService(db, quotesService, soroban.fake);

    const { id } = (await service.create(
      { quoteId: quote.id!, senderAccountId: accountId, recipientAddress: 'r', recipientStellarAccount: RECIPIENT.publicKey() },
      userId,
    )) as { id: string };
    await service.fund(id, userId);
    await expect(service.fund(id, userId)).rejects.toThrow(/state/i);
  });

  it('runs the full settle pipeline: processing -> authorized -> released', async () => {
    const db = await createTestDb();
    const { userId, accountId } = await seedUser(db, true);
    const { quotesService, quote } = await makeQuote(db);
    const soroban = createFakeSoroban();
    const service = createRemittanceService(db, quotesService, soroban.fake);

    const { id } = (await service.create(
      { quoteId: quote.id!, senderAccountId: accountId, recipientAddress: 'r', recipientStellarAccount: RECIPIENT.publicKey() },
      userId,
    )) as { id: string };
    await service.fund(id, userId);
    await service.onAnchorTransferStarted(id);
    expect(soroban.calls).toContain('begin_processing:0');
    const result = await service.authorizeAndRelease(id);
    expect(result.status).toBe('RELEASED');
    expect(soroban.calls).toContain('authorize_settlement:0');
    expect(soroban.calls).toContain('release:0');
    expect(soroban.records.get('0')?.status).toBe('Released');
  });

  it('cannot release before settlement authorization', async () => {
    const db = await createTestDb();
    const { userId, accountId } = await seedUser(db, true);
    const { quotesService, quote } = await makeQuote(db);
    const soroban = createFakeSoroban();
    const service = createRemittanceService(db, quotesService, soroban.fake);

    const { id } = (await service.create(
      { quoteId: quote.id!, senderAccountId: accountId, recipientAddress: 'r', recipientStellarAccount: RECIPIENT.publicKey() },
      userId,
    )) as { id: string };
    await service.fund(id, userId);
    await expect(service.release(id, userId)).rejects.toThrow(/state/i);
  });

  it('rejects a non-owner', async () => {
    const db = await createTestDb();
    const { userId, accountId } = await seedUser(db, true);
    const { quotesService, quote } = await makeQuote(db);
    const soroban = createFakeSoroban();
    const service = createRemittanceService(db, quotesService, soroban.fake);

    const { id } = (await service.create(
      { quoteId: quote.id!, senderAccountId: accountId, recipientAddress: 'r', recipientStellarAccount: RECIPIENT.publicKey() },
      userId,
    )) as { id: string };
    await expect(service.get(id, 'someone-else')).rejects.toThrow(AppError);
  });

  it('supports the non-custodial approval flow (prepare + confirm)', async () => {
    const db = await createTestDb();
    const { userId, accountId } = await seedUser(db, false);
    const { quotesService, quote } = await makeQuote(db);
    const soroban = createFakeSoroban();
    const service = createRemittanceService(db, quotesService, soroban.fake);

    const created = (await service.create(
      { quoteId: quote.id!, senderAccountId: accountId, recipientAddress: 'r', recipientStellarAccount: RECIPIENT.publicKey() },
      userId,
    )) as { id: string; approval_required?: boolean; approval?: { method: string } };
    expect(created.approval_required).toBe(true);
    expect(created.approval?.method).toBe('create_remittance');

    // The app signs + submits; the tx lands; the backend confirms.
    soroban.setTxConfirmed();
    await service.confirmSorobanSubmission(created.id, { txHash: 'tx-abc', method: 'create_remittance' }, userId);
    const got = (await service.get(created.id, userId)) as { contract_remittance_id: string };
    expect(got.contract_remittance_id).toBe('0');
  });

  it('confirmSorobanSubmission rejects when the on-chain record mismatches', async () => {
    const db = await createTestDb();
    const { userId, accountId } = await seedUser(db, false);
    const { quotesService, quote } = await makeQuote(db);
    const soroban = createFakeSoroban();
    const service = createRemittanceService(db, quotesService, soroban.fake);

    const created = (await service.create(
      { quoteId: quote.id!, senderAccountId: accountId, recipientAddress: 'r', recipientStellarAccount: RECIPIENT.publicKey() },
      userId,
    )) as { id: string };
    // Corrupt the on-chain record so the quote hash no longer matches.
    const rec = soroban.records.get('0')!;
    rec.commitment = { ...rec.commitment, quoteHash: 'f'.repeat(64) };
    soroban.setTxConfirmed();
    await expect(
      service.confirmSorobanSubmission(created.id, { txHash: 'tx-bad', method: 'create_remittance' }, userId),
    ).rejects.toThrow(/does not match/i);
  });

  it('advances lifecycle from streamed path-payment events', async () => {
    const db = await createTestDb();
    const { userId, accountId } = await seedUser(db, true);
    const { quotesService, quote } = await makeQuote(db);
    const soroban = createFakeSoroban();
    const service = createRemittanceService(db, quotesService, soroban.fake);

    const { id } = (await service.create(
      { quoteId: quote.id!, senderAccountId: accountId, recipientAddress: 'r', recipientStellarAccount: RECIPIENT.publicKey() },
      userId,
    )) as { id: string };
    await service.fund(id, userId);

    await service.applyPaymentEvent(id, {
      cursor: '1',
      account: SENDER.publicKey(),
      type: 'path_payment',
      amount: '100',
      asset: 'USDC:GUSDC',
      from: SENDER.publicKey(),
      to: RECIPIENT.publicKey(),
    });
    const after = (await service.get(id, userId)) as { lifecycle: string };
    expect(after.lifecycle).toBe('STELLAR_PAYMENT_SUBMITTED');

    await service.applyPaymentEvent(id, {
      cursor: '2',
      account: RECIPIENT.publicKey(),
      type: 'payment',
      amount: '100',
      asset: 'USDC:GUSDC',
      from: SENDER.publicKey(),
      to: RECIPIENT.publicKey(),
    });
    const after2 = (await service.get(id, userId)) as { lifecycle: string };
    expect(after2.lifecycle).toBe('STELLAR_PAYMENT_CONFIRMED');
  });

  it('onAnchorStatus completes a processing remittance', async () => {
    const db = await createTestDb();
    const { userId, accountId } = await seedUser(db, true);
    const { quotesService, quote } = await makeQuote(db);
    const soroban = createFakeSoroban();
    const service = createRemittanceService(db, quotesService, soroban.fake);

    const { id } = (await service.create(
      { quoteId: quote.id!, senderAccountId: accountId, recipientAddress: 'r', recipientStellarAccount: RECIPIENT.publicKey() },
      userId,
    )) as { id: string };
    await service.fund(id, userId);
    await service.onAnchorTransferStarted(id);
    await service.onAnchorStatus(id, 'completed');
    const got = (await service.get(id, userId)) as { status: string; lifecycle: string };
    expect(got.status).toBe('RELEASED');
    expect(got.lifecycle).toBe('COMPLETED');
  });
});