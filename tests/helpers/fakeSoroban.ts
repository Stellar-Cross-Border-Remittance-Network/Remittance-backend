import type { ContractCommitment, Signer, SorobanService } from '../../src/modules/soroban/SorobanService.js';

/**
 * In-memory contract for integration tests. Mirrors the real contract's
 * monotonic id allocation and status transitions closely enough to exercise
 * the backend state machine.
 */
export function createFakeSoroban() {
  const records = new Map<string, { commitment: ContractCommitment; status: string }>();
  const calls: string[] = [];
  let count = 0;
  let txPending = true;

  const fake: SorobanService = {
    sacAddress(assetSpec) {
      return `C${assetSpec.replace(/[^A-Z0-9]/g, '').padEnd(55, 'A').slice(0, 55)}`;
    },
    roleSigner(role) {
      return { publicKey: `G${role.toUpperCase()}${'A'.repeat(52)}`, secret: `${role}-secret` };
    },
    async remittanceCount() {
      return count;
    },
    async createRemittance(commitment, _signer) {
      calls.push('create_remittance');
      const id = String(count++);
      records.set(id, { commitment, status: 'Created' });
      return { id };
    },
    async fundRemittance(id, _sender, _remittanceId) {
      calls.push(`fund_remittance:${id}`);
      const rec = records.get(id);
      if (rec) {
        rec.status = 'Funded';
      }
    },
    async beginProcessing(id, _oracle, _remittanceId) {
      calls.push(`begin_processing:${id}`);
      const rec = records.get(id);
      if (rec && rec.status === 'Funded') {
        rec.status = 'Processing';
      }
    },
    async authorizeSettlement(id, _commitment, _oracle, _remittanceId) {
      calls.push(`authorize_settlement:${id}`);
      const rec = records.get(id);
      if (rec) {
        rec.status = 'SettlementAuthorized';
      }
    },
    async release(id, _remittanceId) {
      calls.push(`release:${id}`);
      const rec = records.get(id);
      if (rec) {
        rec.status = 'Released';
      }
      return { recipient_amount: '10.0', platform_fee: '0.0', corridor_fee: '0.0', anchor_fee: '0.0' };
    },
    async refund(id, _signer, _remittanceId) {
      calls.push(`refund:${id}`);
      const rec = records.get(id);
      if (rec) {
        rec.status = 'Refunded';
      }
      return '10.0';
    },
    async getRemittance(id) {
      const rec = records.get(id);
      return rec
        ? {
            id,
            sender: rec.commitment.sender,
            status: rec.status,
            quote_hash: rec.commitment.quoteHash,
          }
        : {};
    },
    async statusOf(id) {
      return records.get(id)?.status ?? 'Unknown';
    },
    async waitForTransaction() {
      if (txPending) {
        throw new Error('transaction not confirmed');
      }
    },
    async prepareCreateRemittance(commitment, senderPublicKey) {
      // Models the app signing + submitting: the tx lands on-chain and the
      // contract allocates the next monotonic id.
      calls.push('prepare_create_remittance');
      const id = String(count++);
      records.set(id, { commitment: { ...commitment, sender: senderPublicKey }, status: 'Created' });
      return 'AAAAAgAAAABwcHJlcGFyZWRfdHh4';
    },
  };

  return {
    fake,
    records,
    calls,
    setTxConfirmed() {
      txPending = false;
    },
    setTxPending() {
      txPending = true;
    },
  };
}

export type FakeSoroban = ReturnType<typeof createFakeSoroban>;

export function dummySigner(role = 'sender'): Signer {
  return { publicKey: `G${role}${'B'.repeat(52)}`, secretEncrypted: 'v1:iv:tag:ct' };
}