import { describe, expect, it } from 'vitest';

import {
  matchesSettlementEvent,
  normalizePayment,
  persistEvents,
  remittancesForAccount,
} from '../../src/modules/horizon/payments.js';
import { toStroops } from '../../src/lib/amounts.js';
import { createTestDb } from '../helpers/testDb.js';

describe('payment normalization', () => {
  it('normalizes a native payment record', () => {
    const ev = normalizePayment(
      {
        type: 'payment',
        paging_token: '1288490594104321-1',
        asset_type: 'native',
        amount: '10.5000000',
        from: 'GAAAA',
        to: 'GBBBB',
        transaction_hash: 'deadbeef',
        created_at: '2026-01-01T00:00:00Z',
      },
      'GAAAA',
    );
    expect(ev).toMatchObject({
      cursor: '1288490594104321-1',
      type: 'payment',
      asset: 'XLM',
      amount: '10.5000000',
      from: 'GAAAA',
      to: 'GBBBB',
      txHash: 'deadbeef',
    });
  });

  it('normalizes a path_payment with the destination side (what the recipient receives)', () => {
    const ev = normalizePayment(
      {
        type: 'path_payment',
        paging_token: '1-2',
        source_asset_type: 'credit_alphanum4',
        source_asset_code: 'USDC',
        source_asset_issuer: 'GUSDC',
        source_amount: '5.0000000',
        destination_asset_type: 'credit_alphanum4',
        destination_asset_code: 'NGN',
        destination_asset_issuer: 'GNGN',
        destination_amount: '7500.0000000',
        from: 'GSENDER',
        to: 'GRECIP',
      },
      'GSENDER',
    );
    expect(ev?.asset).toBe('NGN:GNGN');
    expect(ev?.type).toBe('path_payment');
    expect(ev?.amount).toBe('7500.0000000');
  });

  it('ignores non-payment records', () => {
    expect(normalizePayment({ type: 'manage_offer', paging_token: '1' }, 'G')).toBeNull();
    expect(normalizePayment({ type: 'set_options', paging_token: '1' }, 'G')).toBeNull();
  });

  it('handles account_merge records', () => {
    const ev = normalizePayment(
      { type: 'account_merge', paging_token: '9', into: 'GDEST', account: 'GSOURCE' },
      'GSOURCE',
    );
    expect(ev?.type).toBe('account_merge');
  });
});

describe('settlement event matching', () => {
  const recipient = 'GRECIP';
  const dest = 'NGN:GNGN';
  const expected = toStroops('99.5');

  const base = {
    cursor: '1',
    account: 'GSENDER',
    type: 'path_payment' as const,
    from: 'GSENDER',
    to: recipient,
    asset: 'NGN:GNGN',
    amount: '99.5',
  };

  it('accepts the committed payout', () => {
    expect(matchesSettlementEvent(base, recipient, dest, expected, toStroops)).toBe(true);
  });

  it('accepts an overpayment (path strict-send surplus)', () => {
    expect(matchesSettlementEvent({ ...base, amount: '100.0' }, recipient, dest, expected, toStroops)).toBe(true);
  });

  it('rejects a payment to a different account', () => {
    expect(matchesSettlementEvent({ ...base, to: 'GOTHER' }, recipient, dest, expected, toStroops)).toBe(false);
  });

  it('rejects a payment in the wrong asset', () => {
    expect(matchesSettlementEvent({ ...base, asset: 'USDC:GUSDC' }, recipient, dest, expected, toStroops)).toBe(false);
  });

  it('rejects a tiny dust payment even in the right asset', () => {
    expect(matchesSettlementEvent({ ...base, amount: '0.0000001' }, recipient, dest, expected, toStroops)).toBe(false);
  });

  it('rejects events without an amount', () => {
    const { amount: _amount, ...noAmount } = base;
    expect(matchesSettlementEvent(noAmount, recipient, dest, expected, toStroops)).toBe(false);
  });
});

describe('payment persistence (dedupe)', () => {
  it('persists events and dedupes on (cursor, account)', async () => {
    const db = await createTestDb();
    const event = {
      cursor: 'cursor-1',
      account: 'GAAAA',
      type: 'payment' as const,
      amount: '1.0',
      asset: 'XLM',
      from: 'GAAAA',
      to: 'GBBBB',
      txHash: 'tx1',
    };
    const first = await persistEvents(db, [event]);
    expect(first).toHaveLength(1);

    // Same cursor + account again: no-op.
    const second = await persistEvents(db, [event]);
    expect(second).toHaveLength(0);

    // Different cursor: stored.
    const third = await persistEvents(db, [{ ...event, cursor: 'cursor-2' }]);
    expect(third).toHaveLength(1);
  });

  it('is safe when the stream and reconciler overlap', async () => {
    const db = await createTestDb();
    const events = [
      { cursor: 'c1', account: 'GA', type: 'payment' as const, amount: '1' },
      { cursor: 'c2', account: 'GA', type: 'payment' as const, amount: '2' },
    ];
    const pass1 = await persistEvents(db, events);
    const pass2 = await persistEvents(db, events);
    expect(pass1).toHaveLength(2);
    expect(pass2).toHaveLength(0);
  });

  it('remittancesForAccount finds matches by recipient account', async () => {
    const db = await createTestDb();
    const { remittances } = await import('../../src/db/schema.js');
    const inserted = await db
      .insert(remittances)
      .values({
        recipient_address: 'phone-1',
        recipient_stellar_account: 'GRECIP',
        source_asset: 'USDC:GX',
        source_amount_stroops: 100n,
        destination_asset: 'NGN:GY',
        expected_destination_amount_stroops: 1500n,
        corridor: 'US/NG',
        quote_hash: 'ab',
        expiry: new Date(Date.now() + 60_000),
      })
      .returning({ id: remittances.id });
    expect(inserted[0]).toBeTruthy();
    const ids = await remittancesForAccount(db, 'GRECIP');
    expect(ids).toContain(inserted[0]!.id);
  });
});