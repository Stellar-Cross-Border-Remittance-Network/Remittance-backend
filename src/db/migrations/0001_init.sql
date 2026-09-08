-- 0001_init.sql — initial schema for remittance-backend.
-- Amounts are stored as BIGINT stroops. Enums are TEXT to allow additive state changes.

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT,
  phone TEXT,
  role TEXT NOT NULL DEFAULT 'user',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE stellar_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL,
  secret_encrypted TEXT,
  custody_model TEXT NOT NULL DEFAULT 'non_custodial',
  network TEXT NOT NULL DEFAULT 'testnet',
  sequence TEXT,
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, public_key)
);

CREATE TABLE anchors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  home_domain TEXT NOT NULL UNIQUE,
  name TEXT,
  stellar_toml_url TEXT,
  web_auth_endpoint TEXT,
  transfer_server_sep6 TEXT,
  transfer_server_sep24 TEXT,
  sep6_enabled BOOLEAN NOT NULL DEFAULT false,
  sep24_enabled BOOLEAN NOT NULL DEFAULT false,
  deposit_enabled BOOLEAN NOT NULL DEFAULT false,
  withdraw_enabled BOOLEAN NOT NULL DEFAULT false,
  kyc_required BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'pending',
  last_discovered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE anchor_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  anchor_id UUID NOT NULL REFERENCES anchors(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  issuer TEXT,
  asset_type TEXT NOT NULL DEFAULT 'credit_alphanum4',
  deposit_enabled BOOLEAN NOT NULL DEFAULT false,
  withdraw_enabled BOOLEAN NOT NULL DEFAULT false,
  deposit_min_amount TEXT,
  deposit_max_amount TEXT,
  withdraw_min_amount TEXT,
  withdraw_max_amount TEXT,
  fee_fixed TEXT,
  fee_percent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (anchor_id, code, issuer)
);

CREATE TABLE quotes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_asset TEXT NOT NULL,
  destination_asset TEXT NOT NULL,
  source_amount_stroops BIGINT NOT NULL,
  destination_amount_stroops BIGINT NOT NULL,
  source_country TEXT,
  destination_country TEXT,
  anchor_id UUID REFERENCES anchors(id),
  platform_fee_stroops BIGINT NOT NULL DEFAULT 0,
  corridor_fee_stroops BIGINT NOT NULL DEFAULT 0,
  anchor_fee_stroops BIGINT NOT NULL DEFAULT 0,
  route TEXT NOT NULL,
  price_impact_bps INTEGER NOT NULL DEFAULT 0,
  quote_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE remittances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id UUID REFERENCES quotes(id),
  sender_user_id UUID REFERENCES users(id),
  sender_account_id UUID REFERENCES stellar_accounts(id),
  recipient_address TEXT NOT NULL,
  recipient_stellar_account TEXT,
  source_asset TEXT NOT NULL,
  source_amount_stroops BIGINT NOT NULL,
  destination_asset TEXT NOT NULL,
  expected_destination_amount_stroops BIGINT NOT NULL,
  corridor TEXT NOT NULL,
  quote_hash TEXT NOT NULL,
  anchor_id UUID REFERENCES anchors(id),
  status TEXT NOT NULL DEFAULT 'CREATED',
  lifecycle TEXT NOT NULL DEFAULT 'QUOTE_CREATED',
  contract_id TEXT,
  contract_remittance_id TEXT,
  expiry TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at TIMESTAMPTZ
);

CREATE INDEX remittances_status_idx ON remittances (status);
CREATE INDEX remittances_sender_idx ON remittances (sender_user_id);

CREATE TABLE sep_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  remittance_id UUID REFERENCES remittances(id),
  anchor_id UUID REFERENCES anchors(id),
  user_id UUID REFERENCES users(id),
  kind TEXT NOT NULL,
  protocol TEXT NOT NULL,
  anchor_tx_id TEXT,
  anchor_tx_status TEXT,
  amount_in TEXT,
  amount_out TEXT,
  asset_in TEXT,
  asset_out TEXT,
  interactive_url TEXT,
  more_info_url TEXT,
  anchor_jwt_encrypted TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE stellar_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  remittance_id UUID REFERENCES remittances(id),
  account TEXT NOT NULL,
  operation_type TEXT NOT NULL,
  asset_in TEXT,
  amount_in TEXT,
  asset_out TEXT,
  amount_out TEXT,
  destination TEXT,
  path JSONB,
  envelope_xdr TEXT,
  tx_hash TEXT,
  sequence BIGINT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE soroban_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  remittance_id UUID REFERENCES remittances(id),
  method TEXT NOT NULL,
  contract_id TEXT NOT NULL,
  function_args JSONB,
  tx_hash TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  ledger BIGINT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE payment_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  remittance_id UUID REFERENCES remittances(id),
  cursor TEXT NOT NULL,
  account TEXT NOT NULL,
  event_type TEXT NOT NULL,
  amount TEXT,
  asset TEXT,
  from_addr TEXT,
  to_addr TEXT,
  tx_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (cursor, account)
);

CREATE TABLE stream_cursors (
  account TEXT PRIMARY KEY,
  cursor TEXT NOT NULL DEFAULT 'now',
  last_connected_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id UUID,
  actor_role TEXT,
  action TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  details JSONB,
  ip TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX audit_events_resource_idx ON audit_events (resource_type, resource_id);