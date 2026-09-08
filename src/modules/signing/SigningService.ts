import { Keypair, TransactionBuilder } from '@stellar/stellar-sdk';

import { decryptSecret, encryptSecret } from '../../lib/crypto.js';
import { internal } from '../../lib/errors.js';

/**
 * Signing abstraction. All transaction signing flows through this interface
 * so a custodial HSM/KMS implementation can be swapped in without touching
 * callers. Secrets are stored encrypted at rest and only decrypted in memory
 * for the duration of a signature.
 */
export interface SigningService {
  /** Generate a new keypair. Returns the public key and the encrypted secret. */
  generate(accountId: string, custody: 'non_custodial' | 'custodial'): Promise<{
    publicKey: string;
    secretEncrypted: string;
  }>;
  /** Import an existing secret (e.g. custodial anchor key) and store it encrypted. */
  importSecret(publicKey: string, secret: string): Promise<string>;
  signTransaction(
    envelopeXdr: string,
    signer: { publicKey: string; secretEncrypted: string },
    networkPassphrase: string,
  ): Promise<string>;
}

export function createLocalSigningService(): SigningService {
  return {
    async generate(accountId, custody) {
      const kp = Keypair.random();
      const secretEncrypted = encryptSecret(kp.secret());
      void accountId;
      void custody;
      return { publicKey: kp.publicKey(), secretEncrypted };
    },

    async importSecret(publicKey, secret) {
      const kp = Keypair.fromSecret(secret);
      if (kp.publicKey() !== publicKey) {
        throw internal('Secret does not match the given public key');
      }
      return encryptSecret(secret);
    },

    async signTransaction(envelopeXdr, signer, networkPassphrase) {
      const tx = TransactionBuilder.fromXDR(envelopeXdr, networkPassphrase);
      tx.sign(Keypair.fromSecret(decryptSecret(signer.secretEncrypted)));
      return tx.toXDR();
    },
  };
}
