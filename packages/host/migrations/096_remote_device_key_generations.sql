-- A removed device may pair again, but only through a new owner-confirmed
-- pairing. Each pairing is its own record: a revoked record stays revoked,
-- and at most one active record may hold a public key.
CREATE TABLE remote_devices_new (
  id TEXT PRIMARY KEY,
  public_key TEXT NOT NULL,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  role TEXT NOT NULL,
  grants_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  revoked_at TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  crypto_connection_id TEXT,
  revoke_synced_at TEXT,
  account_id TEXT,
  name_customized INTEGER NOT NULL DEFAULT 0
);
INSERT INTO remote_devices_new (
  id, public_key, name, platform, role, grants_json, created_at, last_seen_at, revoked_at, revision,
  crypto_connection_id, revoke_synced_at, account_id, name_customized
)
SELECT id, public_key, name, platform, role, grants_json, created_at, last_seen_at, revoked_at, revision,
  crypto_connection_id, revoke_synced_at, account_id, name_customized
FROM remote_devices;
DROP TABLE remote_devices;
ALTER TABLE remote_devices_new RENAME TO remote_devices;
CREATE INDEX idx_remote_devices_revoked ON remote_devices(revoked_at, last_seen_at);
CREATE UNIQUE INDEX idx_remote_devices_active_public_key ON remote_devices(public_key) WHERE revoked_at IS NULL;
