import { resetEnvCache } from '../src/config/env.js';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-jwt-secret-at-least-16-chars-long';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? 'test-encryption-key-0123456789abcdef0123456789abcdef';
process.env.CONTRACT_ID = process.env.CONTRACT_ID ?? 'CCONTRACT0000000000000000000000000000000000000000000000';
process.env.NETWORK = 'testnet';
process.env.HORIZON_URL = 'https://horizon-testnet.stellar.org';
process.env.RPC_URL = 'https://soroban-testnet.stellar.org';
process.env.NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';
process.env.QUOTE_TTL_SECONDS = '300';
process.env.STREAM_ENABLED = 'false';
process.env.CORRIDOR_RATES_JSON = JSON.stringify({ 'USDC:GBU/NGN': '1500', 'US/NG': '1500' });

resetEnvCache();