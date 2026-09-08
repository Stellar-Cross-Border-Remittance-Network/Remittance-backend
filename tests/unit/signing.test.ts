import { describe, expect, it } from 'vitest';

import { Account, Asset, Keypair, Operation, TransactionBuilder } from '@stellar/stellar-sdk';

import { createLocalSigningService } from '../../src/modules/signing/SigningService.js';

const PASSPHRASE = 'Test SDF Network ; September 2015';

function unsignedTx(kp: Keypair): string {
  return new TransactionBuilder(new Account(kp.publicKey(), '0'), {
    fee: '100',
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(
      Operation.payment({
        destination: kp.publicKey(),
        asset: new Asset('USDC', kp.publicKey()),
        amount: '1',
      }),
    )
    .setTimeout(300)
    .build()
    .toXDR();
}

describe('SigningService', () => {
  it('generates a keypair and returns the encrypted secret', async () => {
    const service = createLocalSigningService();
    const { publicKey, secretEncrypted } = await service.generate('account-1', 'custodial');
    expect(publicKey).toMatch(/^G[A-Z0-9]{55}$/);
    expect(secretEncrypted).toMatch(/^v\d+:/); // versioned ciphertext
    expect(secretEncrypted).not.toContain(publicKey);
  });

  it('imports a secret only when it matches the public key', async () => {
    const service = createLocalSigningService();
    const kp = Keypair.random();
    const encrypted = await service.importSecret(kp.publicKey(), kp.secret());
    expect(encrypted).toMatch(/^v\d+:/);
    await expect(service.importSecret(kp.publicKey(), Keypair.random().secret())).rejects.toThrow(
      /does not match/i,
    );
  });

  it('signs a transaction envelope with the decrypted secret', async () => {
    const service = createLocalSigningService();
    const kp = Keypair.random();
    const encrypted = await service.importSecret(kp.publicKey(), kp.secret());
    const xdr = unsignedTx(kp);
    const signed = await service.signTransaction(xdr, { publicKey: kp.publicKey(), secretEncrypted: encrypted }, PASSPHRASE);
    expect(signed).not.toBe(xdr);
    const tx = TransactionBuilder.fromXDR(signed, PASSPHRASE);
    expect(tx.signatures).toHaveLength(1);
  });
});