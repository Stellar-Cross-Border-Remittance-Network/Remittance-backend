import { describe, expect, it } from 'vitest';

import { fromStroops, toStroops } from '../../src/lib/amounts.js';

describe('amounts (exact integer stroop math)', () => {
  it('converts 1 unit to 10^7 stroops', () => {
    expect(toStroops('1')).toBe(10_000_000n);
  });

  it('handles fractional amounts with padding', () => {
    expect(toStroops('0.5')).toBe(5_000_000n);
    expect(toStroops('0.0000001')).toBe(1n);
    expect(toStroops('123.456')).toBe(1_234_560_000n);
  });

  it('truncates beyond 7 decimals instead of rounding (no float drift)', () => {
    expect(toStroops('0.123456789')).toBe(1_234_567n);
  });

  it('rejects invalid amounts', () => {
    expect(() => toStroops('abc')).toThrow();
    expect(() => toStroops('-5')).toThrow();
    expect(() => toStroops('')).toThrow();
  });

  it('round-trips through fromStroops', () => {
    for (const human of ['0.0000001', '1', '1520.5', '999999.9999999', '0']) {
      expect(fromStroops(toStroops(human))).toBe(human);
    }
  });

  it('formats big values without scientific notation', () => {
    expect(fromStroops(123_456_789_012_345n)).toBe('12345678.9012345');
  });

  it('handles negative stroops', () => {
    expect(fromStroops(-5_000_000n)).toBe('-0.5');
  });

  it('supports custom decimals (e.g. rate scale of 12)', () => {
    expect(fromStroops(1_520_500_000_000_000n, 12)).toBe('1520.5');
    expect(toStroops('1520.5', 12)).toBe(1_520_500_000_000_000n);
  });
});