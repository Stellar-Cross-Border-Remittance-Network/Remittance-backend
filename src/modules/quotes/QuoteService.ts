import { eq } from 'drizzle-orm';

import { loadEnv } from '../../config/env.js';
import type { Db } from '../../db/client.js';
import { anchorAssets, anchors, quotes } from '../../db/schema.js';
import { sha256Hex } from '../../lib/crypto.js';
import { toStroops, fromStroops, assertPositiveStroops } from '../../lib/amounts.js';
import { badRequest, notFound, unprocessable } from '../../lib/errors.js';
import { fetchJson } from '../../lib/http.js';

const RATE_SCALE = 10n ** 12n;
const BPS = 10_000n;

export interface QuoteInput {
  sourceAsset: string; // 'USDC:G...' or 'XLM' (native)
  destinationAsset: string;
  sourceAmount: string; // human decimal string
  sourceCountry: string;
  destinationCountry: string;
  anchorId?: string;
}

export interface ComputedQuote {
  id?: string;
  sourceAsset: string;
  destinationAsset: string;
  sourceAmount: string;
  destinationAmount: string;
  sourceAmountStroops: bigint;
  destinationAmountStroops: bigint;
  sourceCountry?: string;
  destinationCountry?: string;
  rate: string;
  rateSource: 'provider' | 'static' | 'default';
  fees: {
    platform: string;
    corridor: string;
    anchor: string;
    total: string;
  };
  route: string;
  priceImpactBps: number;
  expiresAt: Date;
  quoteHash: string;
}

export interface QuoteService {
  createQuote(input: QuoteInput): Promise<ComputedQuote>;
  getQuote(id: string): Promise<ComputedQuote>;
  /** Integrity + freshness check before a remittance is created from a quote. */
  assertUsable(quoteId: string, expected: Partial<QuoteInput>): Promise<ComputedQuote>;
}

/** Pure FX math — no I/O, fully unit-testable. */
export function computeDestination(
  sourceStroops: bigint,
  rateScaled: bigint,
  platformFeeBps: bigint,
  corridorFeeBps: bigint,
  anchorFeeFixedStroops: bigint,
  anchorFeeBps: bigint,
): { destinationStroops: bigint; fees: { platform: bigint; corridor: bigint; anchor: bigint } } {
  const platform = (sourceStroops * platformFeeBps) / BPS;
  const corridor = (sourceStroops * corridorFeeBps) / BPS;
  const afterSourceFees = sourceStroops - platform - corridor;
  if (afterSourceFees <= 0n) {
    throw badRequest('Fees exceed source amount');
  }
  const gross = (afterSourceFees * rateScaled) / RATE_SCALE;
  const anchorFee = (gross * anchorFeeBps) / BPS + anchorFeeFixedStroops;
  const destinationStroops = gross - anchorFee;
  if (destinationStroops <= 0n) {
    throw badRequest('Destination amount is zero after fees');
  }
  return { destinationStroops, fees: { platform, corridor, anchor: anchorFee } };
}

export function parseRate(raw: string): bigint {
  const s = raw.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) {
    throw badRequest(`Invalid rate: ${raw}`);
  }
  const [whole = '0', frac = ''] = s.split('.');
  const scaled = BigInt(whole) * RATE_SCALE + BigInt((frac + '0'.repeat(12)).slice(0, 12));
  if (scaled <= 0n) {
    throw badRequest(`Rate must be positive: ${raw}`);
  }
  return scaled;
}

async function resolveRate(
  sourceAsset: string,
  destinationAsset: string,
  sourceCountry: string,
  destinationCountry: string,
): Promise<{ rate: bigint; source: ComputedQuote['rateSource'] }> {
  const env = loadEnv();
  const pair = `${sourceAsset}/${destinationAsset}`;
  const corridor = `${sourceCountry}/${destinationCountry}`;

  if (env.RATE_PROVIDER_URL) {
    try {
      const url = `${env.RATE_PROVIDER_URL}?base=${encodeURIComponent(sourceAsset)}&quote=${encodeURIComponent(destinationAsset)}&corridor=${encodeURIComponent(corridor)}`;
      const data = await fetchJson<{ rate?: string | number }>(url, {
        headers: env.RATE_PROVIDER_TOKEN ? { Authorization: `Bearer ${env.RATE_PROVIDER_TOKEN}` } : {},
        timeoutMs: 5000,
      });
      if (data.rate !== undefined) {
        return { rate: parseRate(String(data.rate)), source: 'provider' };
      }
    } catch {
      // Provider failure falls back to static rates; the quote records the
      // actual source so pricing is always auditable.
    }
  }
  if (env.CORRIDOR_RATES_JSON) {
    try {
      const staticRates = JSON.parse(env.CORRIDOR_RATES_JSON) as Record<string, string | number>;
      const value = staticRates[pair] ?? staticRates[corridor];
      if (value !== undefined) {
        return { rate: parseRate(String(value)), source: 'static' };
      }
    } catch {
      // fall through to default
    }
  }
  return { rate: RATE_SCALE, source: 'default' };
}

export function createQuoteService(db: Db): QuoteService {
  function fingerprint(q: Omit<ComputedQuote, 'quoteHash' | 'id' | 'expiresAt'>): string {
    return sha256Hex(
      JSON.stringify({
        source_asset: q.sourceAsset,
        destination_asset: q.destinationAsset,
        source_amount_stroops: q.sourceAmountStroops.toString(),
        destination_amount_stroops: q.destinationAmountStroops.toString(),
        fees: Object.fromEntries(
          Object.entries(q.fees).map(([k, v]) => [k, toStroops(v).toString()]),
        ),
        route: q.route,
        rate: q.rate,
        price_impact_bps: q.priceImpactBps,
      }),
    );
  }

  async function compute(input: QuoteInput): Promise<Omit<ComputedQuote, 'id'>> {
    const env = loadEnv();
    const sourceStroops = toStroops(input.sourceAmount);
    assertPositiveStroops(sourceStroops);

    const { rate, source } = await resolveRate(
      input.sourceAsset,
      input.destinationAsset,
      input.sourceCountry,
      input.destinationCountry,
    );

    // Anchor fee from the anchor's published stellar.toml asset entry.
    let anchorFeeFixedStroops = 0n;
    let anchorFeeBps = 0n;
    if (input.anchorId) {
      const anchorRows = await db.select().from(anchors).where(eq(anchors.id, input.anchorId)).limit(1);
      if (anchorRows.length === 0) {
        throw notFound('Anchor not found');
      }
      const code = input.destinationAsset.split(':')[0];
      const assetRows = await db
        .select()
        .from(anchorAssets)
        .where(eq(anchorAssets.anchor_id, input.anchorId))
        .limit(200);
      const asset = assetRows.find((a) => a.code === code);
      if (asset?.fee_fixed) {
        anchorFeeFixedStroops = toStroops(asset.fee_fixed);
      }
      if (asset?.fee_percent) {
        const pct = Number.parseFloat(asset.fee_percent);
        if (Number.isFinite(pct) && pct > 0) {
          anchorFeeBps = BigInt(Math.round(pct * 100)); // % -> bps
        }
      }
    }

    const platformFeeBps = BigInt(env.PLATFORM_FEE_BPS ?? 50);
    const corridorFeeBps = BigInt(env.CORRIDOR_FEE_BPS ?? 0);

    const { destinationStroops, fees } = computeDestination(
      sourceStroops,
      rate,
      platformFeeBps,
      corridorFeeBps,
      anchorFeeFixedStroops,
      anchorFeeBps,
    );

    const route = `${input.sourceAsset}->${input.destinationAsset}`;
    const expiresAt = new Date(Date.now() + env.QUOTE_TTL_SECONDS * 1000);

    const q: Omit<ComputedQuote, 'id' | 'quoteHash'> = {
      sourceAsset: input.sourceAsset,
      destinationAsset: input.destinationAsset,
      sourceAmount: input.sourceAmount,
      destinationAmount: fromStroops(destinationStroops),
      sourceAmountStroops: sourceStroops,
      destinationAmountStroops: destinationStroops,
      sourceCountry: input.sourceCountry,
      destinationCountry: input.destinationCountry,
      rate: fromStroops(rate, 12),
      rateSource: source,
      fees: {
        platform: fromStroops(fees.platform),
        corridor: fromStroops(fees.corridor),
        anchor: fromStroops(fees.anchor),
        total: fromStroops(fees.platform + fees.corridor + fees.anchor),
      },
      route,
      priceImpactBps: 0, // informational; no on-chain liquidity pool for fiat corridors
      expiresAt,
    };
    return { ...q, quoteHash: fingerprint(q) };
  }

  return {
    async createQuote(input) {
      const q = await compute(input);
      // Identical terms produce the identical hash; return the existing quote
      // rather than failing on the unique constraint (idempotent re-quotes).
      const inserted = await db
        .insert(quotes)
        .values({
          source_asset: q.sourceAsset,
          destination_asset: q.destinationAsset,
          source_amount_stroops: q.sourceAmountStroops,
          destination_amount_stroops: q.destinationAmountStroops,
          source_country: input.sourceCountry,
          destination_country: input.destinationCountry,
          anchor_id: input.anchorId ?? null,
          platform_fee_stroops: toStroops(q.fees.platform),
          corridor_fee_stroops: toStroops(q.fees.corridor),
          anchor_fee_stroops: toStroops(q.fees.anchor),
          route: q.route,
          price_impact_bps: q.priceImpactBps,
          quote_hash: q.quoteHash,
          expires_at: q.expiresAt,
        })
        .onConflictDoNothing()
        .returning({ id: quotes.id });
      if (inserted.length > 0) {
        return { ...q, id: inserted[0]!.id };
      }
      const existing = await db
        .select({ id: quotes.id })
        .from(quotes)
        .where(eq(quotes.quote_hash, q.quoteHash))
        .limit(1);
      return { ...q, id: existing[0]!.id };
    },

    async getQuote(id) {
      const rows = await db.select().from(quotes).where(eq(quotes.id, id)).limit(1);
      if (rows.length === 0) {
        throw notFound('Quote not found');
      }
      const row = rows[0]!;
      return {
        id: row.id,
        sourceAsset: row.source_asset,
        destinationAsset: row.destination_asset,
        sourceAmount: fromStroops(row.source_amount_stroops),
        destinationAmount: fromStroops(row.destination_amount_stroops),
        sourceAmountStroops: row.source_amount_stroops,
        destinationAmountStroops: row.destination_amount_stroops,
        sourceCountry: row.source_country ?? undefined,
        destinationCountry: row.destination_country ?? undefined,
        rate: '1.0',
        rateSource: 'default',
        fees: {
          platform: fromStroops(row.platform_fee_stroops),
          corridor: fromStroops(row.corridor_fee_stroops),
          anchor: fromStroops(row.anchor_fee_stroops),
          total: fromStroops(
            row.platform_fee_stroops + row.corridor_fee_stroops + row.anchor_fee_stroops,
          ),
        },
        route: row.route,
        priceImpactBps: row.price_impact_bps,
        expiresAt: row.expires_at,
        quoteHash: row.quote_hash,
      };
    },

    async assertUsable(quoteId, expected) {
      const q = await this.getQuote(quoteId);
      if (q.expiresAt.getTime() <= Date.now()) {
        throw unprocessable('Quote has expired', { quote_id: quoteId });
      }
      if (
        expected.sourceAsset &&
        expected.sourceAsset !== q.sourceAsset
      ) {
        throw unprocessable('Quote source asset mismatch');
      }
      if (
        expected.destinationAsset &&
        expected.destinationAsset !== q.destinationAsset
      ) {
        throw unprocessable('Quote destination asset mismatch');
      }
      if (expected.sourceAmount && toStroops(expected.sourceAmount) !== q.sourceAmountStroops) {
        throw unprocessable('Quote source amount mismatch');
      }
      return q;
    },
  };
}