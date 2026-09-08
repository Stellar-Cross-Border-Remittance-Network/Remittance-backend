import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { quotes } from '../../src/db/schema.js';
import { AppError } from '../../src/lib/errors.js';
import { createQuoteService } from '../../src/modules/quotes/QuoteService.js';
import { createTestDb } from '../helpers/testDb.js';

describe('quote service (DB-backed)', () => {
  it('creates a quote with hash integrity and deterministic fees', async () => {
    const db = await createTestDb();
    const service = createQuoteService(db);
    const quote = await service.createQuote({
      sourceAsset: 'USDC:GUSDC',
      destinationAsset: 'NGN:GNGN',
      sourceAmount: '100',
      sourceCountry: 'US',
      destinationCountry: 'NG',
    });
    expect(quote.id).toBeTruthy();
    expect(quote.quoteHash).toHaveLength(64);
    expect(quote.destinationAmountStroops).toBeGreaterThan(0n);
    // Static testnet rate 1500 from tests/setup env: 100 USDC * 1500 - fees.
    expect(quote.fees.platform).toBe('0.5'); // 50 bps of 100 units
    expect(quote.rateSource).toBe('static');

    // Hash is stable for identical inputs.
    const again = await service.createQuote({
      sourceAsset: 'USDC:GUSDC',
      destinationAsset: 'NGN:GNGN',
      sourceAmount: '100',
      sourceCountry: 'US',
      destinationCountry: 'NG',
    });
    expect(again.quoteHash).toBe(quote.quoteHash);
  });

  it('persists quotes and reads them back', async () => {
    const db = await createTestDb();
    const service = createQuoteService(db);
    const created = await service.createQuote({
      sourceAsset: 'USDC:GUSDC',
      destinationAsset: 'NGN:GNGN',
      sourceAmount: '10',
      sourceCountry: 'US',
      destinationCountry: 'NG',
    });
    const fetched = await service.getQuote(created.id!);
    expect(fetched.quoteHash).toBe(created.quoteHash);
    expect(fetched.sourceAmountStroops).toBe(created.sourceAmountStroops);
    expect(fetched.destinationAmountStroops).toBe(created.destinationAmountStroops);
  });

  it('assertUsable accepts matching inputs', async () => {
    const db = await createTestDb();
    const service = createQuoteService(db);
    const created = await service.createQuote({
      sourceAsset: 'USDC:GUSDC',
      destinationAsset: 'NGN:GNGN',
      sourceAmount: '10',
      sourceCountry: 'US',
      destinationCountry: 'NG',
    });
    await expect(
      service.assertUsable(created.id!, {
        sourceAsset: 'USDC:GUSDC',
        destinationAsset: 'NGN:GNGN',
        sourceAmount: '10',
      }),
    ).resolves.toBeTruthy();
  });

  it('assertUsable rejects mismatched terms', async () => {
    const db = await createTestDb();
    const service = createQuoteService(db);
    const created = await service.createQuote({
      sourceAsset: 'USDC:GUSDC',
      destinationAsset: 'NGN:GNGN',
      sourceAmount: '10',
      sourceCountry: 'US',
      destinationCountry: 'NG',
    });
    await expect(
      service.assertUsable(created.id!, { sourceAsset: 'USDC:GOTHER' }),
    ).rejects.toThrow();
    await expect(
      service.assertUsable(created.id!, { sourceAmount: '999' }),
    ).rejects.toThrow();
  });

  it('assertUsable rejects an expired quote', async () => {
    const db = await createTestDb();
    const service = createQuoteService(db);
    const created = await service.createQuote({
      sourceAsset: 'USDC:GUSDC',
      destinationAsset: 'NGN:GNGN',
      sourceAmount: '10',
      sourceCountry: 'US',
      destinationCountry: 'NG',
    });
    // Force expiry.
    await db
      .update(quotes)
      .set({ expires_at: new Date(Date.now() - 1000) })
      .where(eq(quotes.id, created.id!));
    await expect(service.assertUsable(created.id!, {})).rejects.toThrow(AppError);
  });

  it('rejects an unknown quote', async () => {
    const db = await createTestDb();
    const service = createQuoteService(db);
    await expect(service.getQuote('00000000-0000-0000-0000-000000000000')).rejects.toThrow(
      AppError,
    );
  });

  it('scopes identical quotes per user and persists the rate', async () => {
    const db = await createTestDb();
    const service = createQuoteService(db);
    const { users } = await import('../../src/db/schema.js');
    const u1 = await db.insert(users).values({ email: 'q1@example.com' }).returning({ id: users.id });
    const u2 = await db.insert(users).values({ email: 'q2@example.com' }).returning({ id: users.id });
    const input = {
      sourceAsset: 'USDC:GUSDC',
      destinationAsset: 'NGN:GNGN',
      sourceAmount: '100',
      sourceCountry: 'US',
      destinationCountry: 'NG',
    };
    const a = await service.createQuote(input, u1[0]!.id);
    const b = await service.createQuote(input, u2[0]!.id);
    // Same terms, different users: different rows (and ids).
    expect(a.quoteHash).toBe(b.quoteHash);
    expect(a.id).not.toBe(b.id);

    // The persisted rate round-trips instead of a hardcoded 1.0.
    const fetched = await service.getQuote(a.id!);
    expect(fetched.rate).toBe(a.rate);
    expect(fetched.rate).toBe('1500');
    expect(fetched.rateSource).toBe('static');
  });

  it('claim() is single-use: the second claim loses', async () => {
    const db = await createTestDb();
    const service = createQuoteService(db);
    const created = await service.createQuote({
      sourceAsset: 'USDC:GUSDC',
      destinationAsset: 'NGN:GNGN',
      sourceAmount: '10',
      sourceCountry: 'US',
      destinationCountry: 'NG',
    });
    expect(await service.claim(created.id!)).toBe(true);
    expect(await service.claim(created.id!)).toBe(false);
    // assertUsable now rejects the consumed quote.
    await expect(service.assertUsable(created.id!, {})).rejects.toThrow(/already been used/i);
  });

  it('assertUsable rejects a quote consumed by a remittance (end to end)', async () => {
    const db = await createTestDb();
    const { users, stellarAccounts } = await import('../../src/db/schema.js');
    const { createRemittanceService } = await import('../../src/modules/remittance/RemittanceService.js');
    const { createFakeSoroban } = await import('../helpers/fakeSoroban.js');
    const { Keypair } = await import('@stellar/stellar-sdk');

    const user = await db.insert(users).values({ email: 'single@example.com' }).returning({ id: users.id });
    const kp = Keypair.random();
    const account = await db
      .insert(stellarAccounts)
      .values({ user_id: user[0]!.id, public_key: kp.publicKey(), secret_encrypted: 'v1:iv:tag:ct' })
      .returning({ id: stellarAccounts.id });

    const service = createQuoteService(db);
    const quote = await service.createQuote(
      {
        sourceAsset: 'USDC:GUSDC',
        destinationAsset: 'NGN:GNGN',
        sourceAmount: '10',
        sourceCountry: 'US',
        destinationCountry: 'NG',
      },
      user[0]!.id,
    );
    const remittance = createRemittanceService(db, service, createFakeSoroban().fake);
    await remittance.create(
      {
        quoteId: quote.id!,
        senderAccountId: account[0]!.id,
        recipientAddress: 'r',
        recipientStellarAccount: Keypair.random().publicKey(),
      },
      user[0]!.id,
    );
    // A second remittance from the same quote must fail.
    await expect(
      remittance.create(
        {
          quoteId: quote.id!,
          senderAccountId: account[0]!.id,
          recipientAddress: 'r2',
          recipientStellarAccount: Keypair.random().publicKey(),
        },
        user[0]!.id,
      ),
    ).rejects.toThrow(/already been used/i);
  });
});