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
  it('resolves the default sender account when none is passed (mobile app path)', async () => {
    const db = await createTestDb();
    const { userId } = await seedUser(db, true);
    const { quotesService, quote } = await makeQuote(db);
    const soroban = createFakeSoroban();
    const service = createRemittanceService(db, quotesService, soroban.fake);

    const created = (await service.create(
      {
        quoteId: quote.id!,
        recipientAddress: '+234...',
        recipientStellarAccount: RECIPIENT.publicKey(),
      },
      userId,
    )) as { status: string; contract_remittance_id: string };
    expect(created.status).toBe('CREATED');
    expect(created.contract_remittance_id).toBe('0');
    expect(soroban.calls).toContain('create_remittance');
    expect(soroban.lastCommitment?.sender).toBe(SENDER.publicKey());
  });

  it('rejects a sender account that belongs to another user', async () => {
    const db = await createTestDb();
    const { userId } = await seedUser(db, true);
    // A second user whose account id must NOT be usable by the first user.
    const { users, stellarAccounts } = await import('../../src/db/schema.js');
    const other = await db.insert(users).values({ email: 'eve@example.com' }).returning({ id: users.id });
    const otherAccount = await db
      .insert(stellarAccounts)
      .values({ user_id: other[0]!.id, public_key: Keypair.random().publicKey() })
      .returning({ id: stellarAccounts.id });
    const { quotesService, quote } = await makeQuote(db);
    const soroban = createFakeSoroban();
    const service = createRemittanceService(db, quotesService, soroban.fake);

    await expect(
      service.create(
        {
          quoteId: quote.id!,
          senderAccountId: otherAccount[0]!.id,
          recipientAddress: 'r',
          recipientStellarAccount: RECIPIENT.publicKey(),
        },
        userId,
      ),
    ).rejects.toThrow(/not found/i);
    expect(soroban.calls).not.toContain('create_remittance');
  });

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

  it('advances lifecycle only when a streamed payment matches the committed settlement', async () => {
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
    const before = (await service.get(id, userId)) as { expected_destination_amount: string };
    const payout = before.expected_destination_amount;

    // A random dust payment to the recipient in the WRONG asset must NOT
    // advance the live-status feed.
    await service.applyPaymentEvent(id, {
      cursor: '1',
      account: SENDER.publicKey(),
      type: 'payment',
      amount: '0.0000001',
      asset: 'USDC:GUSDC',
      from: SENDER.publicKey(),
      to: RECIPIENT.publicKey(),
    });
    let state = (await service.get(id, userId)) as { lifecycle: string };
    expect(state.lifecycle).toBe('TRANSFER_INITIATED');

    // The committed payout: path payment delivering the destination asset at
    // (or above) the committed amount to the recipient.
    await service.applyPaymentEvent(id, {
      cursor: '2',
      account: SENDER.publicKey(),
      type: 'path_payment',
      amount: payout,
      asset: 'NGN:GNGN',
      from: SENDER.publicKey(),
      to: RECIPIENT.publicKey(),
    });
    state = (await service.get(id, userId)) as { lifecycle: string };
    expect(state.lifecycle).toBe('STELLAR_PAYMENT_SUBMITTED');

    await service.applyPaymentEvent(id, {
      cursor: '3',
      account: RECIPIENT.publicKey(),
      type: 'payment',
      amount: payout,
      asset: 'NGN:GNGN',
      from: SENDER.publicKey(),
      to: RECIPIENT.publicKey(),
    });
    state = (await service.get(id, userId)) as { lifecycle: string };
    expect(state.lifecycle).toBe('STELLAR_PAYMENT_CONFIRMED');
  });

  it('prepares + relays a non-custodial fund and verifies on-chain state', async () => {
    const db = await createTestDb();
    const { userId, accountId } = await seedUser(db, false);
    const { quotesService, quote } = await makeQuote(db);
    const soroban = createFakeSoroban();
    const service = createRemittanceService(db, quotesService, soroban.fake);

    const created = (await service.create(
      { quoteId: quote.id!, senderAccountId: accountId, recipientAddress: 'r', recipientStellarAccount: RECIPIENT.publicKey() },
      userId,
    )) as { id: string; approval_required?: boolean };
    expect(created.approval_required).toBe(true);

    // The app signs + relays the create first, which reconciles the on-chain id.
    soroban.setTxConfirmed();
    await service.relay(created.id, { signedXdr: 'AAAA', method: 'create_remittance' }, userId);

    const prepared = await service.prepareFund(created.id, userId);
    expect(prepared.transactionXdr).toBeTruthy();
    expect(soroban.calls).toContain('prepare_fund:0');

    // The app signs the prepared envelope; the backend relays it; the
    // contract lands in Funded and the DB follows.
    soroban.setTxConfirmed();
    await service.relay(created.id, { signedXdr: prepared.transactionXdr, method: 'fund_remittance' }, userId);
    const got = (await service.get(created.id, userId)) as { status: string; lifecycle: string };
    expect(got.status).toBe('FUNDED');
    expect(got.lifecycle).toBe('TRANSFER_INITIATED');
    expect(soroban.calls).toContain('submit_envelope');
    expect(soroban.records.get('0')?.status).toBe('Funded');
  });

  it('refuses to advance state when a relayed fund did not move the contract', async () => {
    const db = await createTestDb();
    const { userId, accountId } = await seedUser(db, false);
    const { quotesService, quote } = await makeQuote(db);
    const soroban = createFakeSoroban();
    const service = createRemittanceService(db, quotesService, soroban.fake);

    const created = (await service.create(
      { quoteId: quote.id!, senderAccountId: accountId, recipientAddress: 'r', recipientStellarAccount: RECIPIENT.publicKey() },
      userId,
    )) as { id: string };
    // Put the remittance on-chain first (relayed create), then relay a fund
    // envelope WITHOUT preparing one — the contract stays in Created even
    // though the envelope 'submits' successfully.
    soroban.setTxConfirmed();
    await service.relay(created.id, { signedXdr: 'AAAA', method: 'create_remittance' }, userId);
    await expect(
      service.relay(created.id, { signedXdr: 'AAAA', method: 'fund_remittance' }, userId),
    ).rejects.toThrow(/did not fund/i);
    const got = (await service.get(created.id, userId)) as { status: string };
    expect(got.status).toBe('CREATED');
  });

  it('relays a sender-cancel refund for a non-custodial funded remittance', async () => {
    const db = await createTestDb();
    const { userId, accountId } = await seedUser(db, false);
    const { quotesService, quote } = await makeQuote(db);
    const soroban = createFakeSoroban();
    const service = createRemittanceService(db, quotesService, soroban.fake);

    const created = (await service.create(
      { quoteId: quote.id!, senderAccountId: accountId, recipientAddress: 'r', recipientStellarAccount: RECIPIENT.publicKey() },
      userId,
    )) as { id: string };
    soroban.setTxConfirmed();
    await service.relay(created.id, { signedXdr: 'AAAA', method: 'create_remittance' }, userId);
    const fundXdr = (await service.prepareFund(created.id, userId)).transactionXdr;
    await service.relay(created.id, { signedXdr: fundXdr, method: 'fund_remittance' }, userId);

    const refundXdr = (await service.prepareRefund(created.id, userId)).transactionXdr;
    expect(refundXdr).toBeTruthy();
    expect(soroban.calls).toContain('prepare_refund:0');
    await service.relay(created.id, { signedXdr: refundXdr, method: 'refund' }, userId);
    const got = (await service.get(created.id, userId)) as { status: string; lifecycle: string };
    expect(got.status).toBe('REFUNDED');
    expect(got.lifecycle).toBe('REFUNDED');
    expect(soroban.records.get('0')?.status).toBe('Refunded');
  });

  it('cannot prepare a refund for a custodial account (server signs instead)', async () => {
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
    await expect(service.prepareRefund(id, userId)).rejects.toThrow(/custodial/i);
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