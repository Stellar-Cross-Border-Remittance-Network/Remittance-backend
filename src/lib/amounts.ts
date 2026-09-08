/**
 * Exact integer money handling. Human amounts travel as decimal strings;
 * internally everything is an integer number of stroops (1e-7 units on
 * Stellar). Never use floating point for money.
 */

export const STROOPS_PER_UNIT = 10_000_000n; // 10^7

export function toStroops(amount: string | number, decimals = 7): bigint {
  const s = typeof amount === 'number' ? String(amount) : amount;
  const normalized = s.includes('.') ? s : `${s}.`;
  const [whole = '0', frac = ''] = normalized.split('.');
  const padded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  if (!/^\d+$/.test(whole) || !/^\d*$/.test(padded)) {
    throw new Error(`Invalid amount: ${s}`);
  }
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(padded || '0');
}

export function fromStroops(stroops: bigint, decimals = 7): string {
  if (stroops < 0n) {
    return `-${fromStroops(-stroops, decimals)}`;
  }
  const unit = 10n ** BigInt(decimals);
  const whole = stroops / unit;
  const frac = (stroops % unit).toString().padStart(decimals, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
}

export function assertPositiveStroops(stroops: bigint): void {
  if (stroops <= 0n) {
    throw new Error('Amount must be positive');
  }
}