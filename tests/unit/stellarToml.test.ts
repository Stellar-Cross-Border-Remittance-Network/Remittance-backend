import { afterEach, describe, expect, it, vi } from 'vitest';

import { createStellarTomlService } from '../../src/modules/sep1/StellarTomlService.js';
import { AppError } from '../../src/lib/errors.js';

const FULL_TOML = `
NETWORK_PASSPHRASE = "Test SDF Network ; September 2015"
SIGNING_KEY = "GBXP7GBCDHGPP5J2VGVVUOJXTQRT7XKJ34S2LLP6K6XTQY4XZQZJQ5"
WEB_AUTH_ENDPOINT = "https://anchor.example.com/auth"
TRANSFER_SERVER = "https://anchor.example.com/sep6"
TRANSFER_SERVER_SEP0024 = "https://anchor.example.com/sep24"
KYC_SERVER = "https://anchor.example.com/kyc"

[[CURRENCIES]]
code = "USDC"
issuer = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"
asset_type = "credit_alphanum4"
deposit_enabled = true
withdraw_enabled = false
deposit_min_amount = "1"
deposit_max_amount = "100000"
withdraw_min_amount = "1"
withdraw_max_amount = "100000"
fee_fixed = "1"
fee_percent = "0.5"

[[CURRENCIES]]
code = "NGN"
issuer = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"

[[CURRENCIES]]
not_a_real_currency = true
`;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('StellarTomlService (SEP-1)', () => {
  it('discovers endpoints and currencies from a published stellar.toml', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(FULL_TOML, { status: 200 })),
    );
    const service = createStellarTomlService();
    const toml = await service.discover('anchor.example.com');
    expect(toml.homeDomain).toBe('anchor.example.com');
    expect(toml.webAuthEndpoint).toBe('https://anchor.example.com/auth');
    expect(toml.transferServerSep6).toBe('https://anchor.example.com/sep6');
    expect(toml.transferServerSep24).toBe('https://anchor.example.com/sep24');
    expect(toml.signingKey).toBe('GBXP7GBCDHGPP5J2VGVVUOJXTQRT7XKJ34S2LLP6K6XTQY4XZQZJQ5');
    expect(toml.kycServer).toBe('https://anchor.example.com/kyc');
    expect(toml.currencies).toHaveLength(2);
    const usdc = toml.currencies[0]!;
    expect(usdc.code).toBe('USDC');
    expect(usdc.deposit_enabled).toBe(true);
    expect(usdc.withdraw_enabled).toBe(false);
    expect(usdc.fee_fixed).toBe('1');
    expect(usdc.fee_percent).toBe('0.5');
    // Malformed entries are skipped, not fatal.
    expect(toml.currencies.some((c) => c.code === 'NGN')).toBe(true);
  });

  it('normalizes the home domain (strips scheme and trailing slash)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('SIGNING_KEY = "GAAA"', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const service = createStellarTomlService();
    await service.discover('https://anchor.example.com/');
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toBe('https://anchor.example.com/.well-known/stellar.toml');
  });

  it('maps a fetch failure to an upstream error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ENOTFOUND')));
    const service = createStellarTomlService();
    await expect(service.discover('missing.example.com')).rejects.toMatchObject({
      statusCode: 502,
    });
  });

  it('maps an unparseable toml to an upstream error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not [ valid toml', { status: 200 })));
    const service = createStellarTomlService();
    await expect(service.discover('bad.example.com')).rejects.toThrow(AppError);
  });
});