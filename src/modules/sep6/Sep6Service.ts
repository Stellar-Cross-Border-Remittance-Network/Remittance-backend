import { eq } from 'drizzle-orm';

import type { Db } from '../../db/client.js';
import { anchors, sepTransactions, type Anchor } from '../../db/schema.js';
import { notFound, unprocessable, upstream } from '../../lib/errors.js';
import { postForm } from '../../lib/http.js';

export type SepProtocolPreference = 'AUTO' | 'SEP24' | 'SEP6';

export interface Sep6Input {
  anchorId: string;
  assetCode: string;
  account: string;
  amount?: string;
  countryCode?: string;
  type?: string; // bank account type
  jwt: string;
  userId?: string;
  remittanceId?: string;
}

export interface SepTransferResult {
  id: string;
  protocol: 'sep24' | 'sep6';
  /** SEP-24 interactive URL (only when a SEP-24 flow was chosen). */
  url?: string;
  status: string;
  /** SEP-6 instructions payload when SEP-6 was chosen. */
  instructions?: Record<string, unknown>;
}

export interface Sep6Service {
  deposit(input: Sep6Input & { preference?: SepProtocolPreference }): Promise<SepTransferResult>;
  withdraw(input: Sep6Input & { preference?: SepProtocolPreference }): Promise<SepTransferResult>;
  transactionStatus(anchorId: string, anchorTxId: string, jwt: string): Promise<Record<string, unknown>>;
}

async function getAnchor(db: Db, anchorId: string): Promise<Anchor> {
  const rows = await db.select().from(anchors).where(eq(anchors.id, anchorId)).limit(1);
  if (rows.length === 0) {
    throw notFound('Anchor not found');
  }
  return rows[0]!;
}

export function createSep6Service(db: Db): Sep6Service {
  async function programmatic(
    kind: 'deposit' | 'withdraw',
    input: Sep6Input,
  ): Promise<SepTransferResult> {
    const anchor = await getAnchor(db, input.anchorId);
    const endpoint = anchor.transfer_server_sep6;
    if (!endpoint || !anchor.sep6_enabled) {
      throw unprocessable('Anchor does not support SEP-6');
    }
    const fields: Record<string, string | undefined> = {
      asset_code: input.assetCode,
      account: input.account,
      amount: input.amount,
      country_code: input.countryCode,
      type: input.type,
      lang: 'en',
      wallet_name: 'remittance-app',
      wallet_url: 'https://remittance.example.com',
    };
    let response: Record<string, unknown>;
    try {
      response = await postForm<Record<string, unknown>>(
        `${endpoint}/${kind}`,
        fields,
        { Authorization: `Bearer ${input.jwt}` },
      );
    } catch (e) {
      throw upstream(`SEP-6 ${kind} failed at anchor: ${(e as Error).message}`);
    }
    const id = typeof response.id === 'string' ? response.id : undefined;
    if (!id) {
      throw upstream(`SEP-6 ${kind} response missing transaction id`, response);
    }
    await db.insert(sepTransactions).values({
      remittance_id: input.remittanceId ?? null,
      anchor_id: input.anchorId,
      user_id: input.userId ?? null,
      kind,
      protocol: 'sep6',
      anchor_tx_id: id,
      anchor_tx_status: typeof response.status === 'string' ? response.status : 'pending',
      amount_in: kind === 'deposit' ? input.amount : undefined,
      amount_out: kind === 'withdraw' ? input.amount : undefined,
      asset_in: kind === 'deposit' ? input.assetCode : undefined,
      asset_out: kind === 'withdraw' ? input.assetCode : undefined,
      status: 'pending',
    });
    return { id, protocol: 'sep6', status: 'pending', instructions: response };
  }

  async function withFallback(
    kind: 'deposit' | 'withdraw',
    input: Sep6Input & { preference?: SepProtocolPreference },
  ): Promise<SepTransferResult> {
    const anchor = await getAnchor(db, input.anchorId);
    const preference = input.preference ?? 'AUTO';
    const trySep24 = preference !== 'SEP6' && Boolean(anchor.transfer_server_sep24) && anchor.sep24_enabled;
    const trySep6 = preference !== 'SEP24' && Boolean(anchor.transfer_server_sep6) && anchor.sep6_enabled;

    if (trySep24) {
      const { createSep24Service } = await import('../sep24/Sep24Service.js');
      const sep24 = createSep24Service(db);
      try {
        const res = await sep24[kind]({
          anchorId: input.anchorId,
          assetCode: input.assetCode,
          account: input.account,
          amount: input.amount,
          countryCode: input.countryCode,
          jwt: input.jwt,
          userId: input.userId,
          remittanceId: input.remittanceId,
        });
        return { id: res.id, protocol: 'sep24', url: res.url, status: res.status };
      } catch (e) {
        if (preference === 'SEP24') {
          throw e;
        }
        // AUTO: fall through to SEP-6 only when SEP-24 is genuinely
        // unavailable (anchor error), never on client validation.
        if (!trySep6) {
          throw e;
        }
      }
    }
    if (trySep6) {
      return programmatic(kind, input);
    }
    throw unprocessable('Anchor supports neither SEP-24 nor SEP-6 for this asset');
  }

  return {
    deposit(input) {
      return withFallback('deposit', input);
    },
    withdraw(input) {
      return withFallback('withdraw', input);
    },
    async transactionStatus(anchorId, anchorTxId, jwt) {
      const anchor = await getAnchor(db, anchorId);
      const endpoint = anchor.transfer_server_sep6;
      if (!endpoint) {
        throw unprocessable('Anchor does not support SEP-6');
      }
      const res = await fetch(`${endpoint}/transaction?id=${encodeURIComponent(anchorTxId)}`, {
        headers: { Authorization: `Bearer ${jwt}` },
      }).catch((e) => {
        throw upstream(`SEP-6 status lookup failed: ${(e as Error).message}`);
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        throw upstream(`SEP-6 status lookup responded ${res.status}`, body);
      }
      return body;
    },
  };
}