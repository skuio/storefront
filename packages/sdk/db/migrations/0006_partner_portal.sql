-- Partner (affiliate) portal: visits through partner links, and passwordless partner sign-in.
-- No IP address is stored: `visitor` is a daily-rotating salted hash, enough to count uniques.
CREATE TABLE referral_visits (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  partner        TEXT NOT NULL,
  code           TEXT NOT NULL,
  visitor        TEXT NOT NULL,
  source         TEXT NULL,      -- utm_source, else the referring host, else 'direct'
  medium         TEXT NULL,
  campaign       TEXT NULL,
  landing_path   TEXT NULL,
  country        TEXT NULL,
  created_at     TEXT NOT NULL
);
CREATE INDEX referral_visits_partner ON referral_visits (partner, created_at);
CREATE INDEX referral_visits_dedupe ON referral_visits (partner, visitor, created_at);

CREATE TABLE partner_magic_links (
  token_hash  TEXT PRIMARY KEY,
  partner     TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  used_at     TEXT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE partner_sessions (
  token_hash   TEXT PRIMARY KEY,
  partner      TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
