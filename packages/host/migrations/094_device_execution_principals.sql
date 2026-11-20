-- migration:no-transaction
PRAGMA legacy_alter_table = 1;
PRAGMA foreign_keys = OFF;

BEGIN TRANSACTION;

CREATE TABLE remote_execution_exports_new (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  account_id TEXT,
  execution_principal TEXT,
  stream_id TEXT NOT NULL UNIQUE,
  sequence INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
INSERT INTO remote_execution_exports_new
  (session_id, account_id, execution_principal, stream_id, sequence, created_at)
SELECT session_id, account_id, NULL, stream_id, sequence, created_at FROM remote_execution_exports;
DROP TABLE remote_execution_exports;
ALTER TABLE remote_execution_exports_new RENAME TO remote_execution_exports;

CREATE TABLE remote_execution_bindings_new (
  local_session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  server_origin TEXT NOT NULL,
  server_identity_fingerprint TEXT NOT NULL,
  account_id TEXT,
  target_version INTEGER,
  device_id TEXT,
  device_public_key_json TEXT,
  crypto_connection_id TEXT,
  host_id TEXT NOT NULL,
  remote_session_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  execution_started_at INTEGER,
  created_at INTEGER NOT NULL
);
INSERT INTO remote_execution_bindings_new (
  local_session_id, server_origin, server_identity_fingerprint, account_id,
  target_version, device_id, device_public_key_json, crypto_connection_id,
  host_id, remote_session_id, revision, execution_started_at, created_at
)
SELECT local_session_id, server_origin, server_identity_fingerprint, account_id,
  NULL, NULL, NULL, NULL, host_id, remote_session_id, revision, execution_started_at, created_at
FROM remote_execution_bindings;
DROP TABLE remote_execution_bindings;
ALTER TABLE remote_execution_bindings_new RENAME TO remote_execution_bindings;
CREATE UNIQUE INDEX remote_execution_bindings_account_target ON remote_execution_bindings
  (server_origin, server_identity_fingerprint, account_id, host_id, remote_session_id);
CREATE UNIQUE INDEX remote_execution_bindings_device_target ON remote_execution_bindings
  (server_origin, server_identity_fingerprint, host_id, remote_session_id, device_id, crypto_connection_id);

ALTER TABLE remote_controller_environments ADD COLUMN device_public_key_json TEXT;

COMMIT;
PRAGMA legacy_alter_table = 0;
PRAGMA foreign_keys = ON;
PRAGMA foreign_key_check;
