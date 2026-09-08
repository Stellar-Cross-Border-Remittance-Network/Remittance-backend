-- 0002_quotes_scope.sql — per-user, single-use quotes with the persisted rate.
--
-- Why:
--   * Quotes were global: two users quoting identical terms shared one row,
--     and a quote could back any number of remittances. A remittance is a
--     commitment to ONE accepted quote, so a quote must be consumed once.
--     Identical terms from different identities must produce different quote
--     rows (and different ids), so hashes are unique per (owner_id, quote_hash).
--   * `owner_id` is the SEP-10 session subject — a users.id UUID for custodial
--     sessions, the Stellar public key for non-custodial sessions. It is TEXT
--     because non-custodial identities have no users row.
--   * The effective FX rate was never persisted — GET returned a hardcoded
--     "1.0", which contradicted the create response and broke auditability.
--   * `used_at` records when a quote was consumed, which is auditable and
--     lets callers distinguish "expired" from "already used".

ALTER TABLE quotes ADD COLUMN owner_id TEXT;
ALTER TABLE quotes ADD COLUMN used_at TIMESTAMPTZ;
ALTER TABLE quotes ADD COLUMN rate TEXT;
ALTER TABLE quotes ADD COLUMN rate_source TEXT;

-- Quote hashes are only unique per identity now.
ALTER TABLE quotes DROP CONSTRAINT quotes_quote_hash_key;
CREATE UNIQUE INDEX quotes_owner_hash_idx ON quotes (owner_id, quote_hash);