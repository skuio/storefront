-- Store owners (staff sign-in) and connections (per-consumer Store API keys
-- issued through the owner-approved connect flow). Only hashes are stored:
-- password hashes carry their own parameters, session and reset tokens are
-- HMACs, API keys and one-time codes are SHA-256.

CREATE TABLE owners (
  id                 TEXT PRIMARY KEY,
  email              TEXT NOT NULL UNIQUE,
  name               TEXT NULL,
  password_hash      TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  last_signed_in_at  TEXT NULL
);

CREATE TABLE owner_sessions (
  token_hash    TEXT PRIMARY KEY,
  owner_id      TEXT NOT NULL REFERENCES owners (id) ON DELETE CASCADE,
  expires_at    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL
);
CREATE INDEX owner_sessions_owner ON owner_sessions (owner_id);

-- Password-reset links. Shaped like magic_links, kept apart because that
-- table's customer_id is NOT NULL and an owner is not a customer.
CREATE TABLE owner_reset_links (
  token_hash  TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL REFERENCES owners (id) ON DELETE CASCADE,
  expires_at  TEXT NOT NULL,
  used_at     TEXT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX owner_reset_links_owner ON owner_reset_links (owner_id);

-- A consumer the owner approved. key_hash is NULL until the consumer
-- exchanges its one-time code; a connection that never exchanges is pruned.
CREATE TABLE connections (
  id                   TEXT PRIMARY KEY,
  name                 TEXT NOT NULL,
  tenant               TEXT NULL,
  redirect_host        TEXT NULL,
  scopes_json          TEXT NOT NULL DEFAULT '[]',
  key_hash             TEXT NULL UNIQUE,
  key_prefix           TEXT NULL,
  created_by_owner_id  TEXT NULL REFERENCES owners (id) ON DELETE SET NULL,
  created_at           TEXT NOT NULL,
  issued_at            TEXT NULL,
  last_used_at         TEXT NULL,
  revoked_at           TEXT NULL
);
CREATE INDEX connections_revoked ON connections (revoked_at);

CREATE TABLE connect_codes (
  code_hash      TEXT PRIMARY KEY,
  connection_id  TEXT NOT NULL REFERENCES connections (id) ON DELETE CASCADE,
  redirect_uri   TEXT NOT NULL,
  expires_at     TEXT NOT NULL,
  used_at        TEXT NULL,
  created_at     TEXT NOT NULL
);
CREATE INDEX connect_codes_connection ON connect_codes (connection_id);

-- Failure counters for sign-in and code exchange, keyed by subject|ip.
CREATE TABLE auth_attempts (
  key               TEXT PRIMARY KEY,
  failures          INTEGER NOT NULL DEFAULT 0,
  window_started_at TEXT NOT NULL,
  locked_until      TEXT NULL
);
