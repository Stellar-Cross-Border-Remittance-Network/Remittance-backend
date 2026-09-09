/* Live Testnet smoke: SEP-10 -> register -> quote -> create -> fund.
 * Exercises the real deployed contract through the running backend. */
import { Keypair, Transaction } from '@stellar/stellar-sdk';

const BASE = 'http://localhost:8080';
const PASSPHRASE = 'Test SDF Network ; September 2015';

async function post(path, body, token) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${JSON.stringify(json)}`);
  return json;
}
async function get(path, token) {
  const res = await fetch(BASE + path, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${JSON.stringify(json)}`);
  return json;
}

const sender = Keypair.random();
const recipient = Keypair.random();

console.log('== funding sender + recipient via friendbot ==');
await fetch(`https://friendbot.stellar.org/?addr=${sender.publicKey()}`).then((r) => r.json());
await fetch(`https://friendbot.stellar.org/?addr=${recipient.publicKey()}`).then((r) => r.json());
console.log('sender   ', sender.publicKey());
console.log('recipient', recipient.publicKey());

console.log('\n== SEP-10 challenge ==');
const { transaction, network_passphrase } = await post('/v1/sep10/challenge', { account: sender.publicKey() });
if (network_passphrase !== PASSPHRASE) throw new Error('unexpected passphrase');
const tx = new Transaction(transaction, network_passphrase);
tx.sign(sender);
const { token } = await post('/v1/sep10/verify', {
  transaction: tx.toXDR(),
  account: sender.publicKey(),
  custody: 'non_custodial',
});
console.log('JWT acquired');

console.log('\n== register non-custodial account ==');
const reg = await post('/v1/accounts', { custody: 'non_custodial', public_key: sender.publicKey() }, token);
console.log('registered account id:', reg.id);

console.log('\n== quote (XLM -> XLM, US/NG) ==');
const quote = await post(
  '/v1/remittances/quote',
  {
    source_asset: 'XLM',
    destination_asset: 'XLM',
    source_amount: '10',
    source_country: 'US',
    destination_country: 'NG',
  },
  token,
);
console.log('quote id:', quote.id, 'dest:', quote.destinationAmount, 'hash:', quote.quoteHash);

console.log('\n== create remittance (prepared envelope) ==');
const created = await post(
  '/v1/remittances',
  {
    quote_id: quote.id,
    recipient_address: 'recipient',
    recipient_stellar_account: recipient.publicKey(),
    corridor: 'US/NG',
  },
  token,
);
console.log('remittance id:', created.id, 'approval:', JSON.stringify(created.approval));
if (!created.approval?.transactionXdr) throw new Error('expected approval envelope');

console.log('\n== sign create envelope on-device and relay ==');
const createTx = new Transaction(created.approval.transactionXdr, PASSPHRASE);
createTx.sign(sender);
await post(`/v1/remittances/${created.id}/relay`, {
  signed_xdr: createTx.toXDR(),
  method: 'create_remittance',
}, token);
console.log('create relayed + verified on-chain');

console.log('\n== prepare fund, sign, relay ==');
const prepared = await post(`/v1/remittances/${created.id}/prepare-fund`, {}, token);
const fundTx = new Transaction(prepared.transactionXdr, PASSPHRASE);
fundTx.sign(sender);
await post(`/v1/remittances/${created.id}/relay`, {
  signed_xdr: fundTx.toXDR(),
  method: 'fund_remittance',
}, token);
console.log('fund relayed + verified on-chain');

console.log('\n== live status ==');
const rem = await get(`/v1/remittances/${created.id}`, token);
console.log('status:', rem.status, '| lifecycle:', rem.lifecycle, '| on-chain:', rem.contract_status, '| contract id:', rem.contract_remittance_id);
console.log('SMOKE PASSED');