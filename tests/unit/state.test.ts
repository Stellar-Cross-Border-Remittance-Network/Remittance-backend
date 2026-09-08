import { describe, expect, it } from 'vitest';

import {
  ALLOWED_TRANSITIONS,
  canTransition,
  isRemittanceStatus,
  isTerminal,
  lifecycleFromStatus,
  REMITTANCE_STATUSES,
} from '../../src/modules/remittance/state.js';

describe('remittance state machine', () => {
  it('exposes all contract statuses', () => {
    expect(REMITTANCE_STATUSES).toEqual([
      'CREATED',
      'FUNDED',
      'PROCESSING',
      'SETTLEMENT_AUTHORIZED',
      'RELEASED',
      'REFUNDED',
      'EXPIRED',
    ]);
  });

  it('allows the happy path', () => {
    expect(canTransition('CREATED', 'FUNDED')).toBe(true);
    expect(canTransition('FUNDED', 'PROCESSING')).toBe(true);
    expect(canTransition('PROCESSING', 'SETTLEMENT_AUTHORIZED')).toBe(true);
    expect(canTransition('SETTLEMENT_AUTHORIZED', 'RELEASED')).toBe(true);
  });

  it('allows refund paths', () => {
    expect(canTransition('FUNDED', 'REFUNDED')).toBe(true);
    expect(canTransition('PROCESSING', 'REFUNDED')).toBe(true);
  });

  it('rejects illegal transitions', () => {
    expect(canTransition('CREATED', 'RELEASED')).toBe(false);
    expect(canTransition('CREATED', 'PROCESSING')).toBe(false);
    expect(canTransition('RELEASED', 'REFUNDED')).toBe(false);
    expect(canTransition('REFUNDED', 'FUNDED')).toBe(false);
    expect(canTransition('SETTLEMENT_AUTHORIZED', 'FUNDED')).toBe(false);
  });

  it('never transitions from terminal states', () => {
    for (const terminal of ['RELEASED', 'REFUNDED', 'EXPIRED'] as const) {
      expect(ALLOWED_TRANSITIONS[terminal]).toEqual([]);
      expect(isTerminal(terminal)).toBe(true);
    }
  });

  it('validates status strings', () => {
    expect(isRemittanceStatus('PROCESSING')).toBe(true);
    expect(isRemittanceStatus('NOT_A_STATUS')).toBe(false);
  });

  it('maps statuses to lifecycle phases', () => {
    expect(lifecycleFromStatus('RELEASED')).toBe('COMPLETED');
    expect(lifecycleFromStatus('REFUNDED')).toBe('REFUNDED');
    expect(lifecycleFromStatus('PROCESSING')).toBe('ANCHOR_PROCESSING');
    expect(lifecycleFromStatus('SETTLEMENT_AUTHORIZED')).toBe('DESTINATION_SETTLEMENT');
    expect(lifecycleFromStatus('CREATED')).toBe('QUOTE_CREATED');
  });
});