import { eq } from 'drizzle-orm';

import type { Db } from '../../db/client.js';
import { paymentEvents, remittances } from '../../db/schema.js';

/**
 * Normalized payment event — the single shape both the streamer and the
 * reconciler produce, and what the remittance state machine consumes.
 */
export interface NormalizedPayment {
  cursor: string;
  account: string;
  type: 'payment' | 'path_payment' | 'account_merge' | 'create_account';
  amount?: string;
  asset?: string;
  from?: string;
  to?: string;
  txHash?: string;
  createdAt?: string;
}

/** Asset code portion of a 'CODE:ISSUER' spec, or the whole string if native. */
export function assetCodeOf(asset: string | undefined): string | undefined {
  if (!asset) {
    return undefined;
  }
  return asset === 'XLM' ? 'XLM' : asset.split(':')[0]!.toUpperCase();
}

/**
 * Whether a streamed payment event plausibly IS the settlement of the given
 * remittance: it pays the recorded recipient, delivers the committed
 * destination asset, and pays at least the committed destination amount.
 *
 * This prevents a random 1-stroop payment to the recipient (or a payment in
 * the wrong asset) from advancing the live-status feed.
 */
export function matchesSettlementEvent(
  event: NormalizedPayment,
  recipientStellarAccount: string,
  destinationAsset: string,
  expectedDestinationStroops: bigint,
  toStroopsFn: (human: string) => bigint,
): boolean {
  if (!event.to || event.to !== recipientStellarAccount) {
    return false;
  }
  const want = assetCodeOf(destinationAsset);
  const got = assetCodeOf(event.asset);
  if (!want || !got || want !== got) {
    return false;
  }
  if (!event.amount) {
    return false;
  }
  try {
    return toStroopsFn(event.amount) >= expectedDestinationStroops;
  } catch {
    return false;
  }
}

/**
 * Normalize a raw Horizon payment record into our event shape. Handles both
 * `payment` and `path_payment` operation types.
 *
 * For `path_payment` the **destination side** is what the recipient actually
 * receives, so destination amount/asset are preferred and source fields are
 * only a fallback. Using the source side would misreport the payout and break
 * settlement matching downstream.
 */
export function normalizePayment(
  record: Record<string, unknown>,
  account: string,
): NormalizedPayment | null {
  const type = String(record.type ?? '');
  if (!['payment', 'path_payment', 'account_merge', 'create_account'].includes(type)) {
    return null;
  }
  const assetType =
    (record.destination_asset_type as string | undefined) ??
    (record.asset_type as string | undefined) ??
    (record.source_asset_type as string | undefined);
  const assetCode =
    (record.destination_asset_code as string | undefined) ??
    (record.asset_code as string | undefined) ??
    (record.source_asset_code as string | undefined);
  const assetIssuer =
    (record.destination_asset_issuer as string | undefined) ??
    (record.asset_issuer as string | undefined) ??
    (record.source_asset_issuer as string | undefined);
  const asset =
    assetType === 'native'
      ? 'XLM'
      : assetType && assetCode
        ? `${assetCode}:${assetIssuer}`
        : undefined;

  let amount = record.amount as string | undefined;
  if (type === 'path_payment' && amount === undefined) {
    amount =
      (record.destination_amount as string) ??
      (record.source_amount as string);
  }

  return {
    cursor: String(record.paging_token ?? ''),
    account,
    type: type as NormalizedPayment['type'],
    amount,
    asset,
    from: (record.from as string) ?? (record.source_account as string),
    to: (record.to as string) ?? (record.destination as string),
    txHash: record.transaction_hash as string | undefined,
    createdAt: record.created_at as string | undefined,
  };
}

/**
 * Persist normalized events with cursor dedupe (unique(cursor, account)).
 * Returns only the events that were actually new.
 */
export async function persistEvents(
  db: Db,
  events: NormalizedPayment[],
): Promise<NormalizedPayment[]> {
  if (events.length === 0) {
    return [];
  }
  const inserted = await db
    .insert(paymentEvents)
    .values(
      events.map((e) => ({
        cursor: e.cursor,
        account: e.account,
        event_type: e.type,
        amount: e.amount ?? null,
        asset: e.asset ?? null,
        from_addr: e.from ?? null,
        to_addr: e.to ?? null,
        tx_hash: e.txHash ?? null,
      })),
    )
    .onConflictDoNothing()
    .returning({ cursor: paymentEvents.cursor, account: paymentEvents.account });
  const insertedKeys = new Set(inserted.map((r) => `${r.cursor}:${r.account}`));
  return events.filter((e) => insertedKeys.has(`${e.cursor}:${e.account}`));
}

/** Load remittance ids whose sender or recipient account matches the event. */
export async function remittancesForAccount(db: Db, account: string): Promise<string[]> {
  const rows = await db
    .select({ id: remittances.id })
    .from(remittances)
    .where(eq(remittances.recipient_stellar_account, account));
  return rows.map((r) => r.id);
}
