/**
 * Remittance state machine.
 *
 * `status` mirrors the on-chain contract machine exactly:
 *   CREATED → FUNDED → PROCESSING → SETTLEMENT_AUTHORIZED → RELEASED
 *             FUNDED → PROCESSING → REFUNDED
 *             FUNDED → REFUNDED (sender cancel, pre-processing)
 *   any pre-authorization state past expiry → EXPIRED (derived)
 *
 * `lifecycle` adds the off-chain phases the app renders in its live feed:
 *   QUOTE_CREATED → TRANSFER_INITIATED → ANCHOR_PROCESSING →
 *   STELLAR_PAYMENT_SUBMITTED → STELLAR_PAYMENT_CONFIRMED →
 *   DESTINATION_SETTLEMENT → COMPLETED (or REFUNDED / EXPIRED)
 */

export const REMITTANCE_STATUSES = [
  'CREATED',
  'FUNDED',
  'PROCESSING',
  'SETTLEMENT_AUTHORIZED',
  'RELEASED',
  'REFUNDED',
  'EXPIRED',
] as const;

export type RemittanceStatus = (typeof REMITTANCE_STATUSES)[number];

export const LIFECYCLE_PHASES = [
  'QUOTE_CREATED',
  'TRANSFER_INITIATED',
  'ANCHOR_PROCESSING',
  'STELLAR_PAYMENT_SUBMITTED',
  'STELLAR_PAYMENT_CONFIRMED',
  'DESTINATION_SETTLEMENT',
  'COMPLETED',
  'REFUNDED',
  'EXPIRED',
] as const;

export type LifecyclePhase = (typeof LIFECYCLE_PHASES)[number];

const STATUS_RANK: Record<RemittanceStatus, number> = {
  CREATED: 0,
  FUNDED: 1,
  PROCESSING: 2,
  SETTLEMENT_AUTHORIZED: 3,
  RELEASED: 4,
  REFUNDED: 4,
  EXPIRED: 4,
};

/** Legal direct transitions between contract-mirroring statuses. */
export const ALLOWED_TRANSITIONS: Record<RemittanceStatus, RemittanceStatus[]> = {
  CREATED: ['FUNDED', 'REFUNDED', 'EXPIRED'],
  FUNDED: ['PROCESSING', 'REFUNDED', 'EXPIRED', 'SETTLEMENT_AUTHORIZED'],
  PROCESSING: ['SETTLEMENT_AUTHORIZED', 'REFUNDED', 'EXPIRED'],
  SETTLEMENT_AUTHORIZED: ['RELEASED'],
  RELEASED: [],
  REFUNDED: [],
  EXPIRED: [],
};

export function canTransition(from: RemittanceStatus, to: RemittanceStatus): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

export function isTerminal(status: RemittanceStatus): boolean {
  return status === 'RELEASED' || status === 'REFUNDED' || status === 'EXPIRED';
}

export function isRemittanceStatus(value: string): value is RemittanceStatus {
  return (REMITTANCE_STATUSES as readonly string[]).includes(value);
}

export function isLifecyclePhase(value: string): value is LifecyclePhase {
  return (LIFECYCLE_PHASES as readonly string[]).includes(value);
}

/** Derive the effective lifecycle phase from status (fallback mapping). */
export function lifecycleFromStatus(status: RemittanceStatus): LifecyclePhase {
  switch (status) {
    case 'RELEASED':
      return 'COMPLETED';
    case 'REFUNDED':
      return 'REFUNDED';
    case 'EXPIRED':
      return 'EXPIRED';
    case 'SETTLEMENT_AUTHORIZED':
      return 'DESTINATION_SETTLEMENT';
    case 'PROCESSING':
      return 'ANCHOR_PROCESSING';
    case 'FUNDED':
      return 'TRANSFER_INITIATED';
    default:
      return 'QUOTE_CREATED';
  }
}

export { STATUS_RANK };