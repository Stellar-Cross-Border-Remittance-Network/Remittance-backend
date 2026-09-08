import { parse } from 'smol-toml';

import { loadEnv } from '../../config/env.js';
import { fetchText } from '../../lib/http.js';
import { upstream } from '../../lib/errors.js';

export interface CurrencyInfo {
  code: string;
  issuer?: string;
  asset_type?: string;
  deposit_enabled?: boolean;
  withdraw_enabled?: boolean;
  deposit_min_amount?: string;
  deposit_max_amount?: string;
  withdraw_min_amount?: string;
  withdraw_max_amount?: string;
  fee_fixed?: string;
  fee_percent?: string;
}

export interface StellarToml {
  homeDomain: string;
  webAuthEndpoint?: string;
  transferServerSep6?: string;
  transferServerSep24?: string;
  signingKey?: string;
  kycServer?: string;
  currencies: CurrencyInfo[];
  raw: Record<string, unknown>;
}

function bool(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    return value.toLowerCase() === 'true';
  }
  return undefined;
}

/**
 * SEP-1 discovery: fetch `/.well-known/stellar.toml` from a home domain and
 * extract the service endpoints and supported assets. Endpoints are never
 * hard-coded — they always come from the anchor's published TOML.
 */
export interface StellarTomlService {
  discover(homeDomain: string): Promise<StellarToml>;
}

export function createStellarTomlService(): StellarTomlService {
  const env = loadEnv();
  const scheme = env.ALLOW_INSECURE_HTTP ? 'http' : 'https';

  return {
    async discover(homeDomain: string): Promise<StellarToml> {
      const domain = homeDomain.replace(/^https?:\/\//, '').replace(/\/$/, '');
      const url = `${scheme}://${domain}/.well-known/stellar.toml`;
      const body = await fetchText(url, { timeoutMs: 15_000 }).catch((e) => {
        throw upstream(`SEP-1 discovery failed for ${domain}: ${(e as Error).message}`);
      });

      let toml: Record<string, unknown>;
      try {
        toml = parse(body) as Record<string, unknown>;
      } catch (e) {
        throw upstream(`Invalid stellar.toml from ${domain}: ${(e as Error).message}`);
      }

      const currencies: CurrencyInfo[] = [];
      const rawCurrencies = toml.CURRENCIES;
      if (Array.isArray(rawCurrencies)) {
        for (const c of rawCurrencies) {
          if (c && typeof c === 'object' && typeof (c as CurrencyInfo).code === 'string') {
            currencies.push({
              code: (c as CurrencyInfo).code,
              issuer: (c as CurrencyInfo).issuer,
              asset_type: (c as CurrencyInfo).asset_type,
              deposit_enabled: bool((c as CurrencyInfo).deposit_enabled),
              withdraw_enabled: bool((c as CurrencyInfo).withdraw_enabled),
              deposit_min_amount: (c as CurrencyInfo).deposit_min_amount,
              deposit_max_amount: (c as CurrencyInfo).deposit_max_amount,
              withdraw_min_amount: (c as CurrencyInfo).withdraw_min_amount,
              withdraw_max_amount: (c as CurrencyInfo).withdraw_max_amount,
              fee_fixed: (c as CurrencyInfo).fee_fixed,
              fee_percent: (c as CurrencyInfo).fee_percent,
            });
          }
        }
      }

      return {
        homeDomain: domain,
        webAuthEndpoint: typeof toml.WEB_AUTH_ENDPOINT === 'string' ? toml.WEB_AUTH_ENDPOINT : undefined,
        transferServerSep6: typeof toml.TRANSFER_SERVER === 'string' ? toml.TRANSFER_SERVER : undefined,
        transferServerSep24:
          typeof toml.TRANSFER_SERVER_SEP0024 === 'string'
            ? toml.TRANSFER_SERVER_SEP0024
            : undefined,
        signingKey: typeof toml.SIGNING_KEY === 'string' ? toml.SIGNING_KEY : undefined,
        kycServer: typeof toml.KYC_SERVER === 'string' ? toml.KYC_SERVER : undefined,
        currencies,
        raw: toml,
      };
    },
  };
}