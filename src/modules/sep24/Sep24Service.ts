import { eq } from 'drizzle-orm';

import type { Db } from '../../db/client.js';
import { anchors, sepTransactions } from '../../db/schema.js';
import { notFound, unprocessable, upstream } from '../../lib/errors.js';
import { postForm } from '../../lib/http.js';
import type { Anchor } from '../../db/schema.js';

export interface Sep24DepositInput {
  anchorId: string;
  assetCode: string;
  account: string;
  amount?: string;
  lang?: string;
  countryCode?: string;
  onChangeCallback?: string;
  jwt: string;
  userId?: string;
  remittanceId?: string;
}

export interface Sep24Result {
  id: string;
  url?: string;
  status: string;
}

export interface Sep24Service {
  deposit(input: Sep24DepositInput): Promise<Sep24Result>;
  withdraw(input: Omit<Sep24DepositInput, 'amount'> & { amount?: string }): Promise<Sep24Result>;
  transactionStatus(anchorId: string, anchorTxId: string, jwt: string): Promise<Record<string, unknown>>;
}

async function getAnchor(db: Db, anchorId: string): Promise<Anchor> {
  const rows = await db.select().from(anchors).where(eq(anchors.id, anchorId)).limit(1);
  if (rows.length === 0) {
    throw notFound('Anchor not found');
  }
  return rows[0]!;
}

export function createSep24Service(db: Db): Sep24Service {
  async function interactive(kind: 'deposit' | 'withdraw', input: Sep24DepositInput) {
    const anchor = await getAnchor(db, input.anchorId);
    const endpoint = anchor.transfer_server_sep24;
    if (!endpoint || !anchor.sep24_enabled) {
      throw unprocessable('Anchor does not support SEP-24');
    }
    const fields: Record<string, string | undefined> = {
      asset_code: input.assetCode,
      account: input.account,
      amount: input.amount,
      lang: input.lang,
      country_code: input.countryCode,
      on_change_callback: input.onChangeCallback,
      // SDF test anchor uses wallet_* fields; harmless to send on others.
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
      throw upstream(`SEP-24 ${kind} failed at anchor: ${(e as Error).message}`);
    }
    const id = typeof response.id === 'string' ? response.id : undefined;
    const url = typeof response.url === 'string' ? response.url : undefined;
    if (!id) {
      throw upstream(`SEP-24 ${kind} response missing transaction id`, response);
    }

    const inserted = await db
      .insert(sepTransactions)
      .values({
        remittance_id: input.remittanceId ?? null,
        anchor_id: input.anchorId,
        user_id: input.userId ?? null,
        kind,
        protocol: 'sep24',
        anchor_tx_id: id,
        anchor_tx_status: 'pending',
        amount_in: kind === 'deposit' ? input.amount : undefined,
        amount_out: kind === 'withdraw' ? input.amount : undefined,
        asset_in: kind === 'deposit' ? input.assetCode : undefined,
        asset_out: kind === 'withdraw' ? input.assetCode : undefined,
        interactive_url: url ?? null,
        more_info_url: typeof response.more_info_url === 'string' ? response.more_info_url : null,
        status: 'pending',
      })
      .returning({ id: sepTransactions.id });
    return { id: inserted[0]!.id, url, status: 'pending' };
  }

  return {
    deposit(input) {
      return interactive('deposit', input);
    },
    withdraw(input) {
      return interactive('withdraw', input);
    },
    async transactionStatus(anchorId, anchorTxId, jwt) {
      const anchor = await getAnchor(db, anchorId);
      const endpoint = anchor.transfer_server_sep24;
      if (!endpoint) {
        throw unprocessable('Anchor does not support SEP-24');
      }
      const url = `${endpoint}/transaction?id=${encodeURIComponent(anchorTxId)}`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${jwt}` },
      }).catch((e) => {
        throw upstream(`SEP-24 status lookup failed: ${(e as Error).message}`);
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        throw upstream(`SEP-24 status lookup responded ${res.status}`, body);
      }
      return body;
    },
  };
}