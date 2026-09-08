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
});