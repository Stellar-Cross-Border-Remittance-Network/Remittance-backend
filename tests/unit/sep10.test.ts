import { Keypair, Transaction, WebAuth } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';

import { createJwtService } from '../../src/auth/jwt.js';
import { encryptSecret } from '../../src/lib/crypto.js';
import { AppError } from '../../src/lib/errors.js';
import { createSep10Service } from '../../src/modules/sep10/Sep10Service.js';

const jwt = createJwtService();
const sep10 = createSep10Service(jwt);

function sign(challenge: string, kp: Keypair): string {
  const tx = new Transaction(challenge, 'Test SDF Network ; September 2015');
  tx.sign(kp);
  return tx.toXDR();
}

describe('SEP-10 challenge + verify', () => {
  const client = Keypair.random();

  it('issues a challenge for a valid G account', () => {
    const res = sep10.challenge(client.publicKey());
    expect(res.transaction).toBeTruthy();
    expect(res.network_passphrase).toBe('Test SDF Network ; September 2015');
    // The challenge must reference the client account (extractable via SEP-10).
    const tx = new Transaction(res.transaction, res.network_passphrase);
    const parsed = WebAuth.readChallengeTx(
      res.transaction,
      tx.source,
      res.network_passphrase,
      ['remittance.example.com'],
      'remittance.example.com',
    );
    expect(parsed.clientAccountID).toBe(client.publicKey());
  });

  it('rejects non-G accounts', () => {
    expect(() => sep10.challenge('M' + 'A'.repeat(55))).toThrow(AppError);
    expect(() => sep10.challenge('not-an-account')).toThrow(AppError);
  });

  it('verifies a properly signed challenge and returns a session JWT', () => {
    const challenge = sep10.challenge(client.publicKey());
    const signed = sign(challenge.transaction, client);
    const result = sep10.verify({
      transaction: signed,
      account: client.publicKey(),
      custody: 'non_custodial',
    });
    expect(result.token).toBeTruthy();
    expect(result.account).toBe(client.publicKey());
    // Token must verify against the same service secret.
    const claims = jwt.verify(result.token);
    expect(claims.sub).toBe(client.publicKey());
    expect(claims.account).toBe(client.publicKey());
  });

  it('rejects a challenge signed by the wrong account', () => {
    const challenge = sep10.challenge(client.publicKey());
    const attacker = Keypair.random();
    const signed = sign(challenge.transaction, attacker);
    expect(() =>
      sep10.verify({ transaction: signed, account: client.publicKey() }),
    ).toThrow(/signature invalid/i);
  });

  it('rejects verification against the wrong account', () => {
    const challenge = sep10.challenge(client.publicKey());
    const signed = sign(challenge.transaction, client);
    expect(() =>
      sep10.verify({ transaction: signed, account: Keypair.random().publicKey() }),
    ).toThrow(/different account/i);
  });

  it('rejects an unsigned challenge (non-custodial)', () => {
    const challenge = sep10.challenge(client.publicKey());
    expect(() =>
      sep10.verify({ transaction: challenge.transaction, account: client.publicKey() }),
    ).toThrow();
  });

  it('rejects a tampered challenge', () => {
    const challenge = sep10.challenge(client.publicKey());
    const tampered = challenge.transaction.slice(0, -8) + 'AAAAAAAA';
    expect(() =>
      sep10.verify({ transaction: tampered, account: client.publicKey() }),
    ).toThrow();
  });

  it('verifies a custodial challenge by signing with the stored secret', () => {
    const challenge = sep10.challenge(client.publicKey());
    const result = sep10.verify({
      transaction: challenge.transaction,
      account: client.publicKey(),
      custody: 'custodial',
      secretEncrypted: encryptSecret(client.secret()),
    });
    expect(result.custody).toBe('custodial');
    expect(result.token).toBeTruthy();
  });

  it('rejects custodial verification without the stored secret', () => {
    const challenge = sep10.challenge(client.publicKey());
    expect(() =>
      sep10.verify({ transaction: challenge.transaction, account: client.publicKey(), custody: 'custodial' }),
    ).toThrow();
  });

  it('includes the user id as the token subject when provided', () => {
    const challenge = sep10.challenge(client.publicKey());
    const signed = sign(challenge.transaction, client);
    const result = sep10.verify({
      transaction: signed,
      account: client.publicKey(),
      userId: 'user-123',
    });
    const claims = jwt.verify(result.token);
    expect(claims.sub).toBe('user-123');
  });
});