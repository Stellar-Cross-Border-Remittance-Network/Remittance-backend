import { describe, expect, it } from 'vitest';

import { createAnchorService } from '../../src/modules/anchors/AnchorService.js';
import type { StellarTomlService } from '../../src/modules/sep1/StellarTomlService.js';
import { createTestDb } from '../helpers/testDb.js';

/** Deterministic fake stellar.toml discovery — no network. */
function fakeToml(): StellarTomlService {
  return {
    async discover(homeDomain: string) {
      return {
        // Mirror the real StellarTomlService normalization.
        homeDomain: homeDomain.replace(/^https?:\/\//, '').replace(/\/$/, ''),
        webAuthEndpoint: `https://${homeDomain}/auth`,
        transferServerSep6: `https://${homeDomain}/sep6`,
        transferServerSep24: `https://${homeDomain}/sep24`,
        signingKey: 'GBOGUS',
        kycServer: `https://${homeDomain}/kyc`,
        currencies: [
          {
            code: 'USDC',
            issuer: 'GBUSDC',
            deposit_enabled: true,
            withdraw_enabled: true,
            deposit_min_amount: '1',
            deposit_max_amount: '10000',
            fee_fixed: '0.1',
            fee_percent: '0.5',
          },
          {
            code: 'NGN',
            issuer: 'GNGN',
            deposit_enabled: false,
            withdraw_enabled: true,
          },
        ],
        raw: {},
      };
    },
  };
}

describe('anchor registry (SEP-1 discovery)', () => {
  it('registers an anchor with discovered endpoints and assets', async () => {
    const db = await createTestDb();
    const service = createAnchorService(db, fakeToml());
    const res = await service.register('anchor.example.com');
    expect(res.status).toBe('active');

    const list = await service.list();
    expect(list).toHaveLength(1);
    const anchor = list[0]!;
    expect(anchor.home_domain).toBe('anchor.example.com');
    expect(anchor.web_auth_endpoint).toBe('https://anchor.example.com/auth');
    expect(anchor.transfer_server_sep24).toBe('https://anchor.example.com/sep24');
    expect(anchor.assets).toHaveLength(2);
    const ngn = (anchor.assets as Array<{ code: string; withdraw_enabled: boolean }>).find(
      (a) => a.code === 'NGN',
    );
    expect(ngn?.withdraw_enabled).toBe(true);
  });

  it('is idempotent on re-registration (upsert, no duplicates)', async () => {
    const db = await createTestDb();
    const service = createAnchorService(db, fakeToml());
    await service.register('anchor.example.com');
    await service.register('anchor.example.com');
    const list = await service.list();
    expect(list).toHaveLength(1);
  });

  it('normalizes scheme prefixes in home domains', async () => {
    const db = await createTestDb();
    const service = createAnchorService(db, fakeToml());
    await service.register('https://anchor.example.com/');
    const list = await service.list();
    expect(list[0]!.home_domain).toBe('anchor.example.com');
  });

  it('getById returns the anchor with assets', async () => {
    const db = await createTestDb();
    const service = createAnchorService(db, fakeToml());
    const { id } = await service.register('anchor.example.com');
    const got = await service.getById(id);
    expect(got.assets).toHaveLength(2);
  });
});