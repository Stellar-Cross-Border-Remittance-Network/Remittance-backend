import { describe, expect, it } from 'vitest';

import { remittances, quotes, users } from '../../src/db/schema.js';
import { createTestDb } from '../helpers/testDb.js';

describe('database (migrations on pglite)', () => {
  it('applies all migrations and supports round-trip inserts', async () => {
    const db = await createTestDb();

    const user = await db
      .insert(users)
      .values({ email: 'alice@example.com', role: 'user' })
      .returning({ id: users.id });
    expect(user[0]!.id).toBeTruthy();

    const quote = await db
      .insert(quotes)
      .values({
        source_asset: 'USDC:GX',
        destination_asset: 'NGN:GY',
        source_amount_stroops: 100_000_000n,
        destination_amount_stroops: 150_000_000_000n,
        source_country: 'US',
        destination_country: 'NG',
        route: 'USDC:GX->NGN:GY',
        quote_hash: 'hash-1',
        expires_at: new Date(Date.now() + 60_000),
      })
      .returning({ id: quotes.id, quote_hash: quotes.quote_hash });
    expect(quote[0]!.quote_hash).toBe('hash-1');

    const rem = await db
      .insert(remittances)
      .values({
        quote_id: quote[0]!.id,
        sender_user_id: user[0]!.id,
        recipient_address: 'phone-1',
        recipient_stellar_account: 'GRECIP',
        source_asset: 'USDC:GX',
        source_amount_stroops: 100_000_000n,
        destination_asset: 'NGN:GY',
        expected_destination_amount_stroops: 150_000_000_000n,
        corridor: 'US/NG',
        quote_hash: 'hash-1',
        status: 'CREATED',
        lifecycle: 'QUOTE_CREATED',
        expiry: new Date(Date.now() + 60_000),
      })
      .returning({ id: remittances.id, status: remittances.status });
    expect(rem[0]!.status).toBe('CREATED');
  });

  it('enforces unique quote hashes', async () => {
    const db = await createTestDb();
    const values = {
      source_asset: 'USDC:GX',
      destination_asset: 'NGN:GY',
      source_amount_stroops: 1n,
      destination_amount_stroops: 2n,
      route: 'r',
      quote_hash: 'dup',
      expires_at: new Date(Date.now() + 60_000),
    };
    await db.insert(quotes).values(values);
    await expect(db.insert(quotes).values(values)).rejects.toThrow();
  });

  it('bigint stroops round-trip exactly', async () => {
    const db = await createTestDb();
    const row = await db
      .insert(quotes)
      .values({
        source_asset: 'A',
        destination_asset: 'B',
        source_amount_stroops: 12_345_678_901_234_567n,
        destination_amount_stroops: 0n,
        route: 'r',
        quote_hash: 'big',
        expires_at: new Date(),
      })
      .returning({ source_amount_stroops: quotes.source_amount_stroops });
    expect(row[0]!.source_amount_stroops).toBe(12_345_678_901_234_567n);
  });
});