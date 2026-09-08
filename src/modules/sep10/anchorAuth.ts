import { Keypair, Transaction } from '@stellar/stellar-sdk';

import { loadEnv } from '../../config/env.js';
import { decryptSecret } from '../../lib/crypto.js';
import { upstream } from '../../lib/errors.js';
import { postForm } from '../../lib/http.js';
import type { Anchor } from '../../db/schema.js';

/**
 * SEP-10 against an anchor: fetch the anchor's challenge, sign it with the
 * user's key, and exchange it for the anchor's JWT. Used so the backend can
 * drive SEP-24/SEP-6 flows for custodial accounts; non-custodial clients may
 * pass their own anchor JWT instead.
 */
export async function getAnchorJwt(input: {
  anchor: Anchor;
  account: string;
  secretEncrypted?: string;
  memo?: string;
}): Promise<string> {
  const env = loadEnv();
  const endpoint = input.anchor.web_auth_endpoint;
  if (!endpoint) {
    throw upstream('Anchor has no SEP-10 web auth endpoint');
  }
  if (!input.secretEncrypted) {
    throw upstream('Custodial account secret required to authenticate with the anchor');
  }
  const signer = Keypair.fromSecret(decryptSecret(input.secretEncrypted));

  // 1. Request the challenge.
  const challenge = await postForm<{ transaction: string; network_passphrase: string }>(
    endpoint,
    { account: input.account, memo: input.memo },
  );
  const networkPassphrase = challenge.network_passphrase ?? env.NETWORK_PASSPHRASE;

  // 2. Sign the challenge and exchange it for a token.
  const tx = new Transaction(challenge.transaction, networkPassphrase);
  tx.sign(signer);
  const res = await postForm<{ token: string }>(endpoint, {
    transaction: tx.toXDR(),
  });
  if (!res.token) {
    throw upstream('Anchor SEP-10 verification returned no token');
  }
  // The token came from the anchor's own WEB_AUTH_ENDPOINT; the anchor's
  // SIGNING_KEY from SEP-1 could additionally verify its signature if the
  // flow is used against a different origin.
  return res.token;
}