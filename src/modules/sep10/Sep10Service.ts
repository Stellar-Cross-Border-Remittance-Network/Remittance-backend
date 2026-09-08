import { Keypair, Transaction, WebAuth } from '@stellar/stellar-sdk';

import type { JwtService } from '../../auth/jwt.js';
import { loadEnv } from '../../config/env.js';
import { decryptSecret } from '../../lib/crypto.js';
import { badRequest, forbidden, unauthorized } from '../../lib/errors.js';

export interface Sep10Challenge {
  transaction: string;
  network_passphrase: string;
}

export interface Sep10VerifyResult {
  token: string;
  account: string;
  custody: 'non_custodial' | 'custodial';
  memo?: string;
}

export interface Sep10Service {
  challenge(account: string, memo?: string): Sep10Challenge;
  /**
   * Verify a signed challenge. For custodial accounts the server signs the
   * challenge with the stored key before verification. Returns a session JWT.
   */
  verify(input: {
    transaction: string;
    account: string;
    custody?: 'non_custodial' | 'custodial';
    /** Encrypted client secret; required when custody === 'custodial'. */
    secretEncrypted?: string;
    userId?: string;
  }): Sep10VerifyResult;
}

let devKeypair: Keypair | undefined;

function serverKeypair(): Keypair {
  const env = loadEnv();
  const secret = env.SEP10_SIGNING_SECRET;
  if (secret) {
    return Keypair.fromSecret(secret);
  }
  if (env.NODE_ENV === 'production') {
    throw new Error('SEP10_SIGNING_SECRET is required in production');
  }
  // Dev/test: derive a stable keypair from the JWT secret so restarts don't
  // invalidate issued challenges.
  devKeypair ??= Keypair.fromRawEd25519Seed(
    Buffer.from(env.JWT_SECRET.padEnd(32, '0').slice(0, 32), 'utf8'),
  );
  return devKeypair;
}

function signChallenge(challengeXdr: string, signer: Keypair, networkPassphrase: string): string {
  const tx = new Transaction(challengeXdr, networkPassphrase);
  tx.sign(signer);
  return tx.toXDR();
}

export function createSep10Service(jwt: JwtService): Sep10Service {
  return {
    challenge(account, memo) {
      if (!account.startsWith('G')) {
        throw badRequest('SEP-10 requires a valid G-prefixed Stellar account');
      }
      const env = loadEnv();
      const server = serverKeypair();
      const transaction = WebAuth.buildChallengeTx(
        server,
        account,
        env.SERVER_HOME_DOMAIN,
        env.SEP10_CHALLENGE_TTL_SECONDS,
        env.NETWORK_PASSPHRASE,
        env.WEB_AUTH_DOMAIN,
        memo ?? null,
      );
      return { transaction, network_passphrase: env.NETWORK_PASSPHRASE };
    },

    verify({ transaction, account, custody = 'non_custodial', secretEncrypted, userId }) {
      const env = loadEnv();
      const server = serverKeypair();
      const homeDomains = [env.SERVER_HOME_DOMAIN];

      let signedTx = transaction;
      if (custody === 'custodial') {
        if (!secretEncrypted) {
          throw forbidden('Custodial verification requires the stored account secret');
        }
        const client = Keypair.fromSecret(decryptSecret(secretEncrypted));
        signedTx = signChallenge(signedTx, client, env.NETWORK_PASSPHRASE);
      }

      let clientAccount: string;
      try {
        const challenge = WebAuth.readChallengeTx(
          signedTx,
          server.publicKey(),
          env.NETWORK_PASSPHRASE,
          homeDomains,
          env.WEB_AUTH_DOMAIN,
        );
        clientAccount = challenge.clientAccountID;
      } catch (e) {
        throw unauthorized(`Invalid or expired SEP-10 challenge: ${(e as Error).message}`);
      }

      if (clientAccount !== account) {
        throw unauthorized('Challenge was issued to a different account');
      }
      try {
        WebAuth.verifyChallengeTxSigners(
          signedTx,
          server.publicKey(),
          env.NETWORK_PASSPHRASE,
          [account],
          homeDomains,
          env.WEB_AUTH_DOMAIN,
        );
      } catch (e) {
        throw unauthorized(`Challenge signature invalid: ${(e as Error).message}`);
      }

      const subject = userId ?? account;
      const token = jwt.sign(subject, 'user', { account, custody });
      return { token, account, custody };
    },
  };
}