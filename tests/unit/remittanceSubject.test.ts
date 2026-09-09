import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { Keypair } from '@stellar/stellar-sdk';
import { eq } from 'drizzle-orm';

import { users } from '../../src/db/schema.js';
import { createRemittanceService } from '../../src/modules/remittance/RemittanceService.js';
import type { SorobanService } from '../../src/modules/soroban/SorobanService.js';
import type { QuoteService } from '../../src/modules/quotes/QuoteService.js';
import { createTestDb } from '../helpers/testDb.js';

let db: Awaited<ReturnType<typeof createTestDb>>;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await (db as unknown as { $client: { close(): Promise<void> } }).$client?.close();
});

function stubSoroban(): SorobanService {
  const noop = vi.fn().mockResolvedValue(undefined);
  return {
    createRemittance: vi.fn().mockResolvedValue({ id: 1 }),
    prepareCreateRemittance: vi.fn().mockResolvedValue('AAAA-prepared-create-xdr'),
    fundRemittance: noop,
    prepareFundRemittance: vi.fn().mockResolvedValue('AAAA-prepared-fund-xdr'),
    prepareRefund: vi.fn().mockResolvedValue('AAAA-prepared-refund-xdr'),
    beginProcessing: noop,
    authorizeSettlement: noop,
    release: noop,
    refund: vi.fn().mockResolvedValue(0n),
    waitForTransaction: noop,
    submitEnvelope: vi.fn().mockResolvedValue({ txHash: 'deadbeef' }),
    remittanceCount: vi.fn().mockResolvedValue(0),
    getRemittance: vi.fn().mockResolvedValue({}),
    statusOf: vi.fn().mockResolvedValue('Created'),
    roleSigner: vi.fn().mockReturnValue({ publicKey: 'G', secretEncrypted: 'enc' }),
    onSettlementAuthorized: noop,
  } as unknown as SorobanService;
}

function stubQuotes(overrides: Partial<QuoteService> = {}): QuoteService {
  return {
    createQuote: vi.fn(),
    getQuote: vi.fn().mockResolvedValue({
      id: 'q1',
      sourceAsset: 'XLM',
      destinationAsset: 'XLM',
      sourceAmount: '10',
      destinationAmount: '9.9',
      sourceAmountStroops: 10_000_000_000n,
      destinationAmountStroops: 9_900_000_000n,
      sourceCountry: 'US',
      destinationCountry: 'NG',
      rate: '1',
      rateSource: 'default',
      fees: { platform: '0.1', corridor: '0', anchor: '0', total: '0.1' },
      route: 'XLM->XLM',
      priceImpactBps: 0,
      expiresAt: new Date(Date.now() + 60_000),
      quoteHash: 'quote-hash-1',
    }),
    assertUsable: vi.fn().mockResolvedValue({
      id: 'q1',
      sourceAsset: 'XLM',
      destinationAsset: 'XLM',
      sourceAmount: '10',
      destinationAmount: '9.9',
      sourceAmountStroops: 10_000_000_000n,
      destinationAmountStroops: 9_900_000_000n,
      sourceCountry: 'US',
      destinationCountry: 'NG',
      rate: '1',
      rateSource: 'default',
      fees: { platform: '0.1', corridor: '0', anchor: '0', total: '0.1' },
      route: 'XLM->XLM',
      priceImpactBps: 0,
      expiresAt: new Date(Date.now() + 60_000),
      quoteHash: 'quote-hash-1',
    }),
    claim: vi.fn().mockResolvedValue(true),
    ...overrides,
  } as unknown as QuoteService;
}

/** Seed a real quote row (the remittance insert FK's to it) and return a
 * quotes-service stub that matches its id and terms. */
async function seededQuote() {
  const { quotes } = await import('../../src/db/schema.js');
  const row = (
    await db
      .insert(quotes)
      .values({
        source_asset: 'XLM',
        destination_asset: 'XLM',
        source_amount_stroops: 10_000_000_000n,
        destination_amount_stroops: 9_900_000_000n,
        source_country: 'US',
        destination_country: 'NG',
        route: 'XLM->XLM',
        quote_hash: 'quote-hash-1',
        rate: '1',
        rate_source: 'default',
        expires_at: new Date(Date.now() + 60_000),
      })
      .returning()
  )[0]!;
  const quote = {
    id: row.id,
    sourceAsset: 'XLM',
    destinationAsset: 'XLM',
    sourceAmount: '10',
    destinationAmount: '9.9',
    sourceAmountStroops: 10_000_000_000n,
    destinationAmountStroops: 9_900_000_000n,
    sourceCountry: 'US',
    destinationCountry: 'NG',
    rate: '1',
    rateSource: 'default',
    fees: { platform: '0.1', corridor: '0', anchor: '0', total: '0.1' },
    route: 'XLM->XLM',
    priceImpactBps: 0,
    expiresAt: new Date(Date.now() + 60_000),
    quoteHash: 'quote-hash-1',
  };
  return { quote, quoteService: stubQuotes({
    getQuote: vi.fn().mockResolvedValue(quote),
    assertUsable: vi.fn().mockResolvedValue(quote),
  } as never) };
}

describe('RemittanceService non-custodial subject resolution', () => {
  it('resolves the session public key to the registered users.id and prepares the create envelope', async () => {
    const sender = Keypair.random();
    // Registration-equivalent rows: users.subject = public key, account FK'd
    // to the users row (what POST /v1/accounts creates).
    const user = (
      await db.insert(users).values({ subject: sender.publicKey() }).returning()
    )[0]!;
    const { stellarAccounts } = await import('../../src/db/schema.js');
    const account = (
      await db
        .insert(stellarAccounts)
        .values({
          user_id: user.id,
          public_key: sender.publicKey(),
          custody_model: 'non_custodial',
          is_default: true,
        })
        .returning()
    )[0]!;

    const { quote, quoteService } = await seededQuote();
    const soroban = stubSoroban();
    const service = createRemittanceService(db, quoteService, soroban);

    // The session subject is the public key (non-custodial JWT), NOT the
    // users.id — the service must resolve it or this 404s.
    const result = await service.create(
      {
        quoteId: quote.id,
        recipientAddress: '+2347000000000',
        recipientStellarAccount: Keypair.random().publicKey(),
        corridor: 'US/NG',
      },
      sender.publicKey(),
    );

    expect(result.approval_required).toBe(true);
    const approval = result.approval as { method: string; transactionXdr: string };
    expect(approval.method).toBe('create_remittance');
    expect(approval.transactionXdr).toBe('AAAA-prepared-create-xdr');
    expect(soroban.prepareCreateRemittance).toHaveBeenCalledTimes(1);
    // The commitment's sender is the registered public key.
    const commitment = (soroban.prepareCreateRemittance as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(commitment.sender).toBe(sender.publicKey());

    // The remittance row links to the resolved users.id and account.
    const { remittances } = await import('../../src/db/schema.js');
    const rows = await db
      .select({ sender_user_id: remittances.sender_user_id, sender_account_id: remittances.sender_account_id })
      .from(remittances)
      .where(eq(remittances.sender_account_id, account.id));
    expect(rows[0]?.sender_user_id).toBe(user.id);
  });

  it('keeps custodial sessions (subject = users.id) working unchanged', async () => {
    const user = (
      await db.insert(users).values({ email: 'cust-subject@example.com' }).returning()
    )[0]!;
    const kp = Keypair.random();
    const { stellarAccounts } = await import('../../src/db/schema.js');
    const { encryptSecret } = await import('../../src/lib/crypto.js');
    await db.insert(stellarAccounts).values({
      user_id: user.id,
      public_key: kp.publicKey(),
      secret_encrypted: encryptSecret(kp.secret()),
      custody_model: 'custodial',
      is_default: true,
    });

    const { quote, quoteService } = await seededQuote();
    const soroban = stubSoroban();
    const service = createRemittanceService(db, quoteService, soroban);

    const result = await service.create(
      {
        quoteId: quote.id,
        recipientAddress: '+2347000000000',
        recipientStellarAccount: Keypair.random().publicKey(),
      },
      user.id, // custodial session subject is the users.id itself
    );

    // Custodial: server signs and submits immediately, no approval step.
    expect(result.approval_required).toBeUndefined();
    expect(soroban.createRemittance).toHaveBeenCalledTimes(1);
    expect(result.contract_remittance_id).toBe(1);
  });
});