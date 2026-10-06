CREATE TABLE IF NOT EXISTS staff (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  rank TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS staff_name_unique ON staff(lower(name));

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  staff_id TEXT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  reference TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  qr_token_hash TEXT UNIQUE,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT REFERENCES staff(id),
  checked_in_at TEXT,
  checked_in_by TEXT REFERENCES staff(id)
);
CREATE INDEX IF NOT EXISTS requests_status_created ON requests(status, created_at DESC);
CREATE INDEX IF NOT EXISTS requests_history ON requests(status, decided_at DESC);
