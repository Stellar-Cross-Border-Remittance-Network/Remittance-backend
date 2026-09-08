import { eq } from 'drizzle-orm';

import { loadEnv } from '../../config/env.js';
import type { Db } from '../../db/client.js';
import { anchorAssets, anchors, auditEvents } from '../../db/schema.js';
import { notFound } from '../../lib/errors.js';
import { sha256Hex } from '../../lib/crypto.js';
import type { StellarTomlService } from '../sep1/StellarTomlService.js';

/** Well-known Testnet anchors (home domains only — endpoints always discovered). */
export const SEED_TESTNET_ANCHOR_DOMAINS = ['testanchor.stellar.org'];

export interface AnchorService {
  register(homeDomain: string, requesterId?: string): Promise<{ id: string; status: string }>;
  list(): Promise<Array<Record<string, unknown>>>;
  getById(id: string): Promise<Record<string, unknown>>;
  seedKnownAnchors(): Promise<void>;
}

export function createAnchorService(db: Db, toml: StellarTomlService): AnchorService {
  async function upsertAnchor(homeDomain: string) {
    const discovered = await toml.discover(homeDomain);
    const existing = await db
      .select({ id: anchors.id })
      .from(anchors)
      .where(eq(anchors.home_domain, discovered.homeDomain))
      .limit(1);


    const base = {
      home_domain: discovered.homeDomain,
      stellar_toml_url: `https://${discovered.homeDomain}/.well-known/stellar.toml`,
      web_auth_endpoint: discovered.webAuthEndpoint ?? null,
      transfer_server_sep6: discovered.transferServerSep6 ?? null,
      transfer_server_sep24: discovered.transferServerSep24 ?? null,
      sep6_enabled: Boolean(discovered.transferServerSep6),
      sep24_enabled: Boolean(discovered.transferServerSep24),
      deposit_enabled: discovered.currencies.some((c) => c.deposit_enabled !== false),
      withdraw_enabled: discovered.currencies.some((c) => c.withdraw_enabled !== false),
      kyc_required: Boolean(discovered.kycServer),
      status: 'active',
      last_discovered_at: new Date(),
      updated_at: new Date(),
    } as const;

    let anchorId: string;
    if (existing.length > 0) {
      anchorId = existing[0]!.id;
      await db.update(anchors).set(base).where(eq(anchors.id, anchorId));
      await db.delete(anchorAssets).where(eq(anchorAssets.anchor_id, anchorId));
    } else {
      const inserted = await db
        .insert(anchors)
        .values({ ...base, home_domain: discovered.homeDomain })
        .returning({ id: anchors.id });
      anchorId = inserted[0]!.id;
    }

    if (discovered.currencies.length > 0) {
      await db.insert(anchorAssets).values(
        discovered.currencies.map((c) => ({
          anchor_id: anchorId,
          code: c.code,
          issuer: c.issuer ?? null,
          asset_type: c.asset_type ?? 'credit_alphanum4',
          deposit_enabled: c.deposit_enabled ?? false,
          withdraw_enabled: c.withdraw_enabled ?? false,
          deposit_min_amount: c.deposit_min_amount ?? null,
          deposit_max_amount: c.deposit_max_amount ?? null,
          withdraw_min_amount: c.withdraw_min_amount ?? null,
          withdraw_max_amount: c.withdraw_max_amount ?? null,
          fee_fixed: c.fee_fixed ?? null,
          fee_percent: c.fee_percent ?? null,
        })),
      );
    }
    return anchorId;
  }

  return {
    async register(homeDomain, requesterId) {
      const id = await upsertAnchor(homeDomain);
      await db.insert(auditEvents).values({
        actor_id: requesterId ?? null,
        action: 'anchor.register',
        resource_type: 'anchor',
        resource_id: id,
        details: { home_domain: homeDomain },
      });
      return { id, status: 'active' };
    },

    async list() {
      const rows = await db
        .select({
          id: anchors.id,
          home_domain: anchors.home_domain,
          name: anchors.name,
          web_auth_endpoint: anchors.web_auth_endpoint,
          transfer_server_sep6: anchors.transfer_server_sep6,
          transfer_server_sep24: anchors.transfer_server_sep24,
          sep6_enabled: anchors.sep6_enabled,
          sep24_enabled: anchors.sep24_enabled,
          deposit_enabled: anchors.deposit_enabled,
          withdraw_enabled: anchors.withdraw_enabled,
          kyc_required: anchors.kyc_required,
          status: anchors.status,
          last_discovered_at: anchors.last_discovered_at,
        })
        .from(anchors)
        .orderBy(anchors.created_at);
      const assets = await db.select().from(anchorAssets);
      return rows.map((a) => ({
        ...a,
        assets: assets.filter((x) => x.anchor_id === a.id),
      }));
    },

    async getById(id) {
      const rows = await db.select().from(anchors).where(eq(anchors.id, id)).limit(1);
      if (rows.length === 0) {
        throw notFound('Anchor not found');
      }
      const assets = await db.select().from(anchorAssets).where(eq(anchorAssets.anchor_id, id));
      return { ...rows[0], assets };
    },

    async seedKnownAnchors() {
      const env = loadEnv();
      if (env.NETWORK !== 'testnet') {
        return;
      }
      for (const domain of SEED_TESTNET_ANCHOR_DOMAINS) {
        try {
          await upsertAnchor(domain);
        } catch {
          // Seeding is best-effort; registration via the API remains available.
        }
      }
    },
  };
}

/** Stable anchor id helper for quote/remittance integrity fields. */
export function anchorAssetKey(code: string, issuer?: string): string {
  return issuer ? `${code}:${issuer}` : code;
}

export function quoteFingerprint(fields: Record<string, unknown>): string {
  return sha256Hex(JSON.stringify(fields));
}

export function corridorKey(sourceCountry: string, destinationCountry: string): string {
  return `${sourceCountry}/${destinationCountry}`;
}