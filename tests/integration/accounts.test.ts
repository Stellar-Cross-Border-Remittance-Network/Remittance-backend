import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Keypair, Transaction } from '@stellar/stellar-sdk';
import { eq } from 'drizzle-orm';

import { decryptSecret } from '../../src/lib/crypto.js';
import { quotes, remittances, stellarAccounts, users } from '../../src/db/schema.js';
import { buildApp } from '../../src/server/app.js';
import { buildContainer, type Container } from '../../src/server/container.js';
import { createTestDb } from '../helpers/testDb.js';

let app: Awaited<ReturnType<typeof buildApp>>;
let container: Container;

beforeAll(async () => {
  const db = await createTestDb();
  const logger = { info: () => undefined, warn: () => undefined, error: () => undefined } as never;
  container = buildContainer(db, logger as never);
  app = await buildApp(container);
});

afterAll(async () => {
  await app.close();
});

/** SEP-10 verify a fresh non-custodial keypair; returns the session token. */
async function nonCustodialSession() {
  const kp = Keypair.random();
  const challenge = await app.inject({
    method: 'POST',
    url: '/v1/sep10/challenge',
    payload: { account: kp.publicKey() },
  });
  const { transaction, network_passphrase } = challenge.json() as {
    transaction: string;
    network_passphrase: string;
  };
  const signed = new Transaction(transaction, network_passphrase);
  signed.sign(kp);
  const verify = await app.inject({
    method: 'POST',
    url: '/v1/sep10/verify',
    payload: { transaction: signed.toXDR(), account: kp.publicKey(), custody: 'non_custodial' },
  });
  return { token: (verify.json() as { token: string }).token, account: kp.publicKey() };
}

describe('account registration', () => {
  it('registers a non-custodial account against the session identity', async () => {
    const { token, account } = await nonCustodialSession();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/accounts',
      headers: { authorization: `Bearer ${token}` },
      payload: { custody: 'non_custodial', public_key: account },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { id: string; public_key: string; custody: string; is_default: boolean };
    expect(body.public_key).toBe(account);
    expect(body.custody).toBe('non_custodial');
    expect(body.is_default).toBe(true);

    // The account row is owned by a users row whose subject is the session's
    // public key — this is what lets a non-custodial session reach its data.
    const stored = await container.db
      .select({ user_id: stellarAccounts.user_id, custody: stellarAccounts.custody_model })
      .from(stellarAccounts)
      .where(eq(stellarAccounts.public_key, account))
      .limit(1);
    expect(stored[0]?.custody).toBe('non_custodial');
    const owner = await container.db
      .select({ subject: users.subject })
      .from(users)
      .where(eq(users.id, stored[0]!.user_id))
      .limit(1);
    expect(owner[0]?.subject).toBe(account);
  });

  it('is idempotent for the same subject + key', async () => {
    const { token, account } = await nonCustodialSession();
    const first = await app.inject({
      method: 'POST',
      url: '/v1/accounts',
      headers: { authorization: `Bearer ${token}` },
      payload: { custody: 'non_custodial', public_key: account },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/v1/accounts',
      headers: { authorization: `Bearer ${token}` },
      payload: { custody: 'non_custodial', public_key: account },
    });
    expect(second.statusCode).toBe(200);
    expect((second.json() as { id: string }).id).toBe((first.json() as { id: string }).id);
  });

  it('rejects registration without a session token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/accounts',
      payload: { custody: 'non_custodial', public_key: Keypair.random().publicKey() },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects an invalid public key', async () => {
    const { token } = await nonCustodialSession();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/accounts',
      headers: { authorization: `Bearer ${token}` },
      payload: { custody: 'non_custodial', public_key: 'not-a-key' },
    });
    expect(res.statusCode).toBe(422);
  });

  it('issues a custodial account with a server-held secret, returned once', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/accounts/custodial',
      payload: { network: 'testnet' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      user_id: string;
      account_id: string;
      public_key: string;
      secret: string;
      network: string;
    };
    expect(body.public_key.startsWith('G')).toBe(true);
    expect(body.secret.startsWith('S')).toBe(true);

    // The stored secret is the encrypted form of what was returned.
    const stored = await container.db
      .select({ secret_encrypted: stellarAccounts.secret_encrypted, user_id: stellarAccounts.user_id })
      .from(stellarAccounts)
      .where(eq(stellarAccounts.id, body.account_id))
      .limit(1);
    expect(stored[0]?.user_id).toBe(body.user_id);
    expect(decryptSecret(stored[0]!.secret_encrypted!)).toBe(body.secret);

    // SEP-10 custodial verification must succeed with the issued account.
    const challenge = await app.inject({
      method: 'POST',
      url: '/v1/sep10/challenge',
      payload: { account: body.public_key },
    });
    const { transaction, network_passphrase } = challenge.json() as {
      transaction: string;
      network_passphrase: string;
    };
    const verify = await app.inject({
      method: 'POST',
      url: '/v1/sep10/verify',
      payload: { transaction, account: body.public_key, custody: 'custodial' },
    });
    expect(verify.statusCode).toBe(200);
    expect((verify.json() as { custody: string }).custody).toBe('custodial');
  });

  it('refuses custodial issuance on mainnet', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/accounts/custodial',
      payload: { network: 'mainnet' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('lets a non-custodial session read its own remittance (subject resolution)', async () => {
    const { token, account } = await nonCustodialSession();
    const reg = await app.inject({
      method: 'POST',
      url: '/v1/accounts',
      headers: { authorization: `Bearer ${token}` },
      payload: { custody: 'non_custodial', public_key: account },
    });
    const accountId = (reg.json() as { id: string }).id;

    // The user row created by registration owns this remittance (as the
    // create flow would set sender_user_id).
    const userRow = await container.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.subject, account))
      .limit(1);
    const quote = await container.db
      .insert(quotes)
      .values({
        owner_id: account,
        source_asset: 'XLM',
        destination_asset: 'XLM',
        source_amount_stroops: 100_000_000n,
        destination_amount_stroops: 100_000_000n,
        source_country: 'US',
        destination_country: 'NG',
        route: 'XLM->XLM',
        quote_hash: 'hash-1',
        expires_at: new Date(Date.now() + 60_000),
      })
      .returning({ id: quotes.id });
    const rem = await container.db
      .insert(remittances)
      .values({
        quote_id: quote[0]!.id,
        sender_user_id: userRow[0]!.id,
        sender_account_id: accountId,
        recipient_address: 'recipient',
        recipient_stellar_account: Keypair.random().publicKey(),
        source_asset: 'XLM',
        source_amount_stroops: 100_000_000n,
        destination_asset: 'XLM',
        expected_destination_amount_stroops: 100_000_000n,
        corridor: 'US/NG',
        quote_hash: 'hash-1',
        status: 'CREATED',
        lifecycle: 'QUOTE_CREATED',
        expiry: new Date(Date.now() + 60_000),
      })
      .returning({ id: remittances.id });

    const get = await app.inject({
      method: 'GET',
      url: `/v1/remittances/${rem[0]!.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(get.statusCode).toBe(200);
    expect((get.json() as { id: string }).id).toBe(rem[0]!.id);

    // And another identity must NOT see it.
    const other = await nonCustodialSession();
    const denied = await app.inject({
      method: 'GET',
      url: `/v1/remittances/${rem[0]!.id}`,
      headers: { authorization: `Bearer ${other.token}` },
    });
    expect(denied.statusCode).toBe(403);
  });
});