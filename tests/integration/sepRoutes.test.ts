import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { Keypair, Transaction, WebAuth } from '@stellar/stellar-sdk';

const PASSPHRASE = 'Test SDF Network ; September 2015';

/** A real SEP-10 challenge issued by a fake anchor, for the given client. */
function anchorChallenge(clientAccount: string, serverKp: Keypair): string {
  return WebAuth.buildChallengeTx(
    serverKp,
    clientAccount,
    'anchor.example.com',
    300,
    PASSPHRASE,
    'anchor.example.com',
  );
}

import { encryptSecret } from '../../src/lib/crypto.js';
import { buildApp } from '../../src/server/app.js';
import { buildContainer, type Container } from '../../src/server/container.js';
import { createTestDb } from '../helpers/testDb.js';

let app: Awaited<ReturnType<typeof buildApp>>;
let container: Container;

beforeAll(async () => {
  const db = await createTestDb();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
  container = buildContainer(db, logger as never);
  app = await buildApp(container);
});

afterAll(async () => {
  await app.close();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Seed a custodial user + account + anchor; return a session token. */
async function custodialSession() {
  const { users, stellarAccounts, anchors } = await import('../../src/db/schema.js');
  const kp = Keypair.random();
  const user = await container.db.insert(users).values({ email: `cust-${Date.now()}@example.com` }).returning({ id: users.id });
  await container.db.insert(stellarAccounts).values({
    user_id: user[0]!.id,
    public_key: kp.publicKey(),
    secret_encrypted: encryptSecret(kp.secret()),
    custody_model: 'custodial',
  });
  const anchor = await container.db
    .insert(anchors)
    .values({
      home_domain: `anchor-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.example.com`,
      transfer_server_sep24: 'https://anchor.example.com/sep24',
      transfer_server_sep6: 'https://anchor.example.com/sep6',
      web_auth_endpoint: 'https://anchor.example.com/auth',
      sep24_enabled: true,
      sep6_enabled: true,
    })
    .returning({ id: anchors.id });

  // SEP-10 with custody=custodial: the server signs on the user's behalf.
  const challenge = await app.inject({
    method: 'POST',
    url: '/v1/sep10/challenge',
    payload: { account: kp.publicKey() },
  });
  const { transaction, network_passphrase } = challenge.json();
  const verify = await app.inject({
    method: 'POST',
    url: '/v1/sep10/verify',
    payload: { transaction, account: kp.publicKey(), custody: 'custodial' },
  });
  return {
    token: verify.json().token as string,
    account: kp.publicKey(),
    anchorId: anchor[0]!.id,
  };
}

describe('SEP-24/SEP-6 route handlers over HTTP', () => {
  it('starts a SEP-24 deposit and returns the interactive URL', async () => {
    const { token, account, anchorId } = await custodialSession();
    const anchorKp = Keypair.random();
    // Anchor SEP-10 challenge + token + deposit, all served by the same fake.
    vi.stubGlobal(
      'fetch',
      vi.fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ transaction: anchorChallenge(account, anchorKp), network_passphrase: PASSPHRASE }),
            { status: 200 },
          ),
        )
        .mockResolvedValueOnce(new Response(JSON.stringify({ token: 'anchor-jwt' }), { status: 200 }))
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ id: 'atx-1', url: 'https://anchor.example.com/interactive?token=x', more_info_url: 'https://anchor.example.com/more' }),
            { status: 200 },
          ),
        ),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/v1/sep24/deposit',
      headers: { authorization: `Bearer ${token}` },
      payload: { anchor_id: anchorId, asset_code: 'USDC', account, amount: '100' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.url).toContain('interactive');
    expect(body.id).toBeTruthy();
  });

  it('falls back to SEP-6 when the SEP-24 anchor call fails', async () => {
    const { token, account, anchorId } = await custodialSession();
    const anchorKp = Keypair.random();
    vi.stubGlobal(
      'fetch',
      vi.fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ transaction: anchorChallenge(account, anchorKp), network_passphrase: PASSPHRASE }), { status: 200 }),
        )
        .mockResolvedValueOnce(new Response(JSON.stringify({ token: 'anchor-jwt' }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'interactive down' }), { status: 400 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'sep6-tx', status: 'pending' }), { status: 200 })),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/v1/sep6/deposit',
      headers: { authorization: `Bearer ${token}` },
      payload: { anchor_id: anchorId, asset_code: 'USDC', account, amount: '100', preference: 'AUTO' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.protocol).toBe('sep6');
    // The id is the internal transaction row id (like SEP-24); the anchor's
    // own transaction id is retained in the stored row.
    expect(typeof body.id).toBe('string');
    expect(body.id.length).toBeGreaterThan(0);
    expect(body.instructions?.id).toBe('sep6-tx');
  });

  it('rejects an unregistered custodial account for an anchor deposit', async () => {
    const { token, anchorId } = await custodialSession();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/sep24/deposit',
      headers: { authorization: `Bearer ${token}` },
      payload: { anchor_id: anchorId, asset_code: 'USDC', account: Keypair.random().publicKey(), amount: '10' },
    });
    // Unregistered account -> 404 with a clear message (non-custodial users
    // must pass their own anchor JWT).
    expect(res.statusCode).toBe(404);
  });

  it('looks up a SEP-24 transaction status with the stored anchor session', async () => {
    const { token, account, anchorId } = await custodialSession();
    const anchorKp = Keypair.random();
    vi.stubGlobal(
      'fetch',
      vi.fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ transaction: anchorChallenge(account, anchorKp), network_passphrase: PASSPHRASE }), { status: 200 }),
        )
        .mockResolvedValueOnce(new Response(JSON.stringify({ token: 'anchor-jwt' }), { status: 200 }))
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ id: 'atx-1', url: 'https://anchor.example.com/interactive?token=x', more_info_url: 'https://anchor.example.com/more' }),
            { status: 200 },
          ),
        ),
    );
    const deposit = await app.inject({
      method: 'POST',
      url: '/v1/sep24/deposit',
      headers: { authorization: `Bearer ${token}` },
      payload: { anchor_id: anchorId, asset_code: 'USDC', account, amount: '100' },
    });
    const sepTxId = deposit.json().id as string;

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ transaction: { id: 'atx-1', status: 'completed' } }), { status: 200 }),
      ),
    );
    const statusRes = await app.inject({
      method: 'GET',
      url: `/v1/sep24/transactions/${sepTxId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(statusRes.statusCode).toBe(200);
    expect(statusRes.json().transaction.status).toBe('completed');
  });
});