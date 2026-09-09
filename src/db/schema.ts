import {
  bigint,
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  index,
} from 'drizzle-orm/pg-core';

/**
 * Central data model. Amounts are stored as integer stroops (bigint) —
 * never floats. Enums are stored as text so new states never require
 * schema migrations.
 */

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  // Stable identity for SEP-10 sessions whose JWT subject is a Stellar
  // public key (non-custodial). Custodial sessions carry users.id directly
  // and leave this NULL. Unique so one identity owns exactly one users row.
  subject: text('subject'),
  email: text('email'),
  phone: text('phone'),
  role: text('role').notNull().default('user'), // 'user' | 'admin'
  status: text('status').notNull().default('active'), // 'active' | 'suspended'
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('users_subject_idx').on(t.subject)]);

export const stellarAccounts = pgTable(
  'stellar_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    user_id: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    public_key: text('public_key').notNull(),
    // Encrypted with the service key; null for non-custodial accounts whose
    // keys never leave the client.
    secret_encrypted: text('secret_encrypted'),
    custody_model: text('custody_model').notNull().default('non_custodial'), // 'non_custodial' | 'custodial'
    network: text('network').notNull().default('testnet'),
    sequence: text('sequence'),
    is_default: boolean('is_default').notNull().default(false),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('stellar_accounts_user_key_idx').on(t.user_id, t.public_key)],
);

export const anchors = pgTable('anchors', {
  id: uuid('id').primaryKey().defaultRandom(),
  home_domain: text('home_domain').notNull().unique(),
  name: text('name'),
  stellar_toml_url: text('stellar_toml_url'),
  web_auth_endpoint: text('web_auth_endpoint'),
  transfer_server_sep6: text('transfer_server_sep6'),
  transfer_server_sep24: text('transfer_server_sep24'),
  sep6_enabled: boolean('sep6_enabled').notNull().default(false),
  sep24_enabled: boolean('sep24_enabled').notNull().default(false),
  deposit_enabled: boolean('deposit_enabled').notNull().default(false),
  withdraw_enabled: boolean('withdraw_enabled').notNull().default(false),
  kyc_required: boolean('kyc_required').notNull().default(false),
  status: text('status').notNull().default('pending'), // 'pending' | 'active' | 'failed'
  last_discovered_at: timestamp('last_discovered_at', { withTimezone: true }),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const anchorAssets = pgTable(
  'anchor_assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    anchor_id: uuid('anchor_id')
      .notNull()
      .references(() => anchors.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    issuer: text('issuer'),
    asset_type: text('asset_type').notNull().default('credit_alphanum4'),
    deposit_enabled: boolean('deposit_enabled').notNull().default(false),
    withdraw_enabled: boolean('withdraw_enabled').notNull().default(false),
    deposit_min_amount: text('deposit_min_amount'),
    deposit_max_amount: text('deposit_max_amount'),
    withdraw_min_amount: text('withdraw_min_amount'),
    withdraw_max_amount: text('withdraw_max_amount'),
    fee_fixed: text('fee_fixed'),
    fee_percent: text('fee_percent'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('anchor_assets_anchor_code_issuer_idx').on(t.anchor_id, t.code, t.issuer)],
);

export const quotes = pgTable(
  'quotes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Quotes belong to the identity that requested them; identical terms from
    // two identities must not share a row. TEXT because the SEP-10 session
    // subject is a users.id UUID for custodial sessions but a Stellar public
    // key for non-custodial sessions.
    owner_id: text('owner_id'),
    source_asset: text('source_asset').notNull(), // 'USDC:G...' or 'native'
    destination_asset: text('destination_asset').notNull(),
    source_amount_stroops: bigint('source_amount_stroops', { mode: 'bigint' }).notNull(),
    destination_amount_stroops: bigint('destination_amount_stroops', { mode: 'bigint' }).notNull(),
    source_country: text('source_country'),
    destination_country: text('destination_country'),
    anchor_id: uuid('anchor_id').references(() => anchors.id),
    platform_fee_stroops: bigint('platform_fee_stroops', { mode: 'bigint' }).notNull().default(0n),
    corridor_fee_stroops: bigint('corridor_fee_stroops', { mode: 'bigint' }).notNull().default(0n),
    anchor_fee_stroops: bigint('anchor_fee_stroops', { mode: 'bigint' }).notNull().default(0n),
    route: text('route').notNull(),
    price_impact_bps: integer('price_impact_bps').notNull().default(0),
    quote_hash: text('quote_hash').notNull(),
    // The effective FX rate and its source, persisted so reads match the
    // create response and pricing is auditable.
    rate: text('rate'),
    rate_source: text('rate_source'),
    // Set when a remittance is created from this quote — a quote is single-use.
    used_at: timestamp('used_at', { withTimezone: true }),
    expires_at: timestamp('expires_at', { withTimezone: true }).notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('quotes_owner_hash_idx').on(t.owner_id, t.quote_hash)],
);

export const remittances = pgTable(
  'remittances',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    quote_id: uuid('quote_id').references(() => quotes.id),
    sender_user_id: uuid('sender_user_id').references(() => users.id),
    sender_account_id: uuid('sender_account_id').references(() => stellarAccounts.id),
    recipient_address: text('recipient_address').notNull(),
    recipient_stellar_account: text('recipient_stellar_account'),
    source_asset: text('source_asset').notNull(),
    source_amount_stroops: bigint('source_amount_stroops', { mode: 'bigint' }).notNull(),
    destination_asset: text('destination_asset').notNull(),
    expected_destination_amount_stroops: bigint('expected_destination_amount_stroops', {
      mode: 'bigint',
    }).notNull(),
    corridor: text('corridor').notNull(),
    quote_hash: text('quote_hash').notNull(),
    anchor_id: uuid('anchor_id').references(() => anchors.id),
    status: text('status').notNull().default('CREATED'),
    // Human-facing phase for the live-status feed. Mirrors status but adds
    // off-chain phases (anchor processing, stellar payment lifecycle).
    lifecycle: text('lifecycle').notNull().default('QUOTE_CREATED'),
    // On-chain identifiers once the Soroban escrow exists.
    contract_id: text('contract_id'),
    contract_remittance_id: text('contract_remittance_id'),
    expiry: timestamp('expiry', { withTimezone: true }).notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    settled_at: timestamp('settled_at', { withTimezone: true }),
  },
  (t) => [
    index('remittances_status_idx').on(t.status),
    index('remittances_sender_idx').on(t.sender_user_id),
  ],
);

export const sepTransactions = pgTable('sep_transactions', {
  id: uuid('id').primaryKey().defaultRandom(),
  remittance_id: uuid('remittance_id').references(() => remittances.id),
  anchor_id: uuid('anchor_id').references(() => anchors.id),
  user_id: uuid('user_id').references(() => users.id),
  kind: text('kind').notNull(), // 'deposit' | 'withdraw' | 'path_payment'
  protocol: text('protocol').notNull(), // 'sep24' | 'sep6'
  anchor_tx_id: text('anchor_tx_id'),
  anchor_tx_status: text('anchor_tx_status'),
  amount_in: text('amount_in'),
  amount_out: text('amount_out'),
  asset_in: text('asset_in'),
  asset_out: text('asset_out'),
  interactive_url: text('interactive_url'),
  more_info_url: text('more_info_url'),
  // SEP-10 anchor session token, encrypted at rest (needed for status polling).
  anchor_jwt_encrypted: text('anchor_jwt_encrypted'),
  status: text('status').notNull().default('pending'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const stellarTransactions = pgTable('stellar_transactions', {
  id: uuid('id').primaryKey().defaultRandom(),
  remittance_id: uuid('remittance_id').references(() => remittances.id),
  account: text('account').notNull(),
  operation_type: text('operation_type').notNull(), // 'path_payment_strict_send' | ...
  asset_in: text('asset_in'),
  amount_in: text('amount_in'),
  asset_out: text('asset_out'),
  amount_out: text('amount_out'),
  destination: text('destination'),
  path: jsonb('path'),
  envelope_xdr: text('envelope_xdr'),
  tx_hash: text('tx_hash'),
  sequence: bigint('sequence', { mode: 'bigint' }),
  status: text('status').notNull().default('pending'), // pending | submitted | confirmed | failed
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const sorobanTransactions = pgTable('soroban_transactions', {
  id: uuid('id').primaryKey().defaultRandom(),
  remittance_id: uuid('remittance_id').references(() => remittances.id),
  method: text('method').notNull(), // create_remittance | fund_remittance | authorize_settlement | release | refund
  contract_id: text('contract_id').notNull(),
  function_args: jsonb('function_args'),
  tx_hash: text('tx_hash'),
  status: text('status').notNull().default('pending'), // pending | submitted | confirmed | failed
  ledger: bigint('ledger', { mode: 'bigint' }),
  error: text('error'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const paymentEvents = pgTable(
  'payment_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    remittance_id: uuid('remittance_id').references(() => remittances.id),
    cursor: text('cursor').notNull(),
    account: text('account').notNull(),
    event_type: text('event_type').notNull(), // 'payment' | 'path_payment' | 'account_merge'
    amount: text('amount'),
    asset: text('asset'),
    from_addr: text('from_addr'),
    to_addr: text('to_addr'),
    tx_hash: text('tx_hash'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('payment_events_cursor_account_idx').on(t.cursor, t.account)],
);

export const streamCursors = pgTable('stream_cursors', {
  account: text('account').primaryKey(),
  cursor: text('cursor').notNull().default('now'),
  last_connected_at: timestamp('last_connected_at', { withTimezone: true }),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const auditEvents = pgTable('audit_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  actor_id: uuid('actor_id'),
  actor_role: text('actor_role'),
  action: text('action').notNull(),
  resource_type: text('resource_type'),
  resource_id: text('resource_id'),
  details: jsonb('details'),
  ip: text('ip'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type StellarAccount = typeof stellarAccounts.$inferSelect;
export type Anchor = typeof anchors.$inferSelect;
export type AnchorAsset = typeof anchorAssets.$inferSelect;
export type Quote = typeof quotes.$inferSelect;
export type Remittance = typeof remittances.$inferSelect;
export type SepTransaction = typeof sepTransactions.$inferSelect;
export type StellarTransaction = typeof stellarTransactions.$inferSelect;
export type SorobanTransaction = typeof sorobanTransactions.$inferSelect;
export type PaymentEvent = typeof paymentEvents.$inferSelect;
export type StreamCursor = typeof streamCursors.$inferSelect;
export type AuditEvent = typeof auditEvents.$inferSelect;