-- 0003_users_subject.sql — stable identity for SEP-10 sessions.
--
-- Why:
--   * Non-custodial SEP-10 sessions carry the user's Stellar public key as
--     the JWT subject (there is no account record until the user registers
--     one). Remittances, accounts and audit rows are all FK'd to users.id
--     (a UUID), so a subject key is needed to map a public-key subject back
--     to a real users row the first time the user registers.
--   * Custodial sessions already carry users.id as the subject, so their
--     subject stays NULL here (a unique index allows multiple NULLs).
--   * The unique index makes registration idempotent and prevents two
--     identities from ever claiming the same Stellar key.

ALTER TABLE users ADD COLUMN subject TEXT;
CREATE UNIQUE INDEX users_subject_idx ON users (subject);