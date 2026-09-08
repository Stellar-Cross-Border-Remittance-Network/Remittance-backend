import { describe, expect, it } from 'vitest';

import { computeDestination, parseRate } from '../../src/modules/quotes/QuoteService.js';

const RATE = 1_500_000_000_000n; // rate 1.5 (scale 10^12)

describe('quote fee math (deterministic, integer-only)', () => {
  it('applies the FX rate with no fees', () => {
    const { destinationStroops } = computeDestination(100n * 10_000_000n, RATE, 0n, 0n, 0n, 0n);
    expect(destinationStroops).toBe(150n * 10_000_000n);
  });

  it('deducts platform fee in bps on the source amount', () => {
    // 50 bps of 100 USDC = 0.5 USDC
    const { destinationStroops, fees } = computeDestination(
      100n * 10_000_000n,
      RATE,
      50n,
      0n,
      0n,
      0n,
    );
    expect(fees.platform).toBe(5_000_000n); // 0.5 units
    expect(destinationStroops).toBe(1_492_500_000n); // 99.5 units * 1.5
  });

  it('deducts corridor + anchor fees', () => {
    const { fees, destinationStroops } = computeDestination(
      100n * 10_000_000n,
      RATE,
      50n,
      20n,
      2n * 10_000_000n, // fixed 2 units
      100n, // 1%
    );
    expect(fees.corridor).toBe(200_000n * 10n);
    expect(fees.anchor).toBeGreaterThan(0n);
    expect(destinationStroops).toBeGreaterThan(0n);
  });

  it('rejects fees exceeding the source amount', () => {
    expect(() => computeDestination(100n * 10_000_000n, RATE, 200_000n, 0n, 0n, 0n)).toThrow();
  });

  it('rejects a zero destination after fees', () => {
    expect(() => computeDestination(1_000_000n, RATE, 0n, 0n, 2_000_000n, 0n)).toThrow();
  });

  it('is exact — no floating point drift on awkward numbers', () => {
    const source = 1_234_567n;
    const rate = 1_234_567_890_123n;
    const { destinationStroops } = computeDestination(source, rate, 1n, 1n, 1n, 1n);
    expect(destinationStroops).toBeGreaterThan(0n);
    // Recomputing must be stable.
    const again = computeDestination(source, rate, 1n, 1n, 1n, 1n);
    expect(again.destinationStroops).toBe(destinationStroops);
  });
});

describe('parseRate', () => {
  it('parses decimal rates to 12-digit scale', () => {
    expect(parseRate('1.5')).toBe(1_500_000_000_000n);
    expect(parseRate('1520.5')).toBe(1_520_500_000_000_000n);
    expect(parseRate('1')).toBe(1_000_000_000_000n);
  });

  it('rejects non-positive or malformed rates', () => {
    expect(() => parseRate('0')).toThrow();
    expect(() => parseRate('-1')).toThrow();
    expect(() => parseRate('abc')).toThrow();
    expect(() => parseRate('1.2.3')).toThrow();
  });
});