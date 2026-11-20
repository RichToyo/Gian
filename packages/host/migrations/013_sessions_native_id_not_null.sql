-- migration:no-transaction
-- (marker tells the runner to skip its automatic transaction wrap; we
-- toggle pragmas + manage the transaction ourselves below.)
--
-- Migration 012 already deleted rows whose native_session_id IS NULL. This
-- migration makes native_session_id NOT NULL and replaces the partial unique
-- index (WHERE native_session_id IS NOT NULL) with an unconditional UNIQUE.
--
-- SQLite cannot ALTER COLUMN. The usual rebuild is rename, create, copy,
-- drop, then recreate indexes. By default, ALTER TABLE RENAME rewrites other
-- tables' FOREIGN KEY references to the new name (sessions -> sessions_old).
-- After DROP sessions_old, the events / turns / queue / approvals foreign
-- keys would dangle at a missing sessions_old and later INSERTs would fail
-- with SQLITE_ERROR.
--
-- Fix: legacy_alter_table=1 so RENAME does not rewrite other tables' foreign
-- keys. Also turn foreign_keys OFF so DROP sessions_old does not run a
-- foreign-key check (references are by name, and parent rows already live in
-- the new sessions table by then). Neither PRAGMA can change inside a
-- transaction, so both run before BEGIN.

PRAGMA legacy_alter_table = 1;
PRAGMA foreign_keys = OFF;

BEGIN TRANSACTION;

DROP INDEX IF EXISTS idx_sessions_native_unique;

ALTER TABLE sessions RENAME TO sessions_old;

CREATE TABLE sessions (
  id                TEXT PRIMARY KEY,
  name              TEXT,
  type              TEXT NOT NULL DEFAULT 'coding',
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id),
  executor          TEXT NOT NULL,
  model             TEXT,
  approval_mode     TEXT NOT NULL DEFAULT 'auto',
  turns             INTEGER NOT NULL DEFAULT 1,
  active_channel    TEXT DEFAULT 'web',
  status            TEXT NOT NULL DEFAULT 'new',
  archived          INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  worktree_path     TEXT,
  branch            TEXT,
  base_branch       TEXT,
  worktree_outcome  TEXT
    CHECK (worktree_outcome IS NULL OR worktree_outcome IN ('merged', 'discarded')),
  thinking_effort   TEXT
    CHECK (thinking_effort IS NULL OR thinking_effort IN
      ('off','minimal','low','medium','high','max','xhigh')),
  native_session_id TEXT NOT NULL
);

INSERT INTO sessions (
  id, name, type, workspace_id, executor, model, approval_mode, turns,
  active_channel, status, archived, created_at, updated_at,
  worktree_path, branch, base_branch, worktree_outcome,
  thinking_effort, native_session_id
)
SELECT
  id, name, type, workspace_id, executor, model, approval_mode, turns,
  active_channel, status, archived, created_at, updated_at,
  worktree_path, branch, base_branch, worktree_outcome,
  thinking_effort, native_session_id
FROM sessions_old;

DROP TABLE sessions_old;

CREATE INDEX idx_sessions_status    ON sessions(status);
CREATE INDEX idx_sessions_workspace ON sessions(workspace_id);
CREATE INDEX idx_sessions_updated   ON sessions(updated_at DESC);

CREATE UNIQUE INDEX idx_sessions_native_unique
  ON sessions(executor, native_session_id);

COMMIT;

PRAGMA legacy_alter_table = 0;
PRAGMA foreign_keys = ON;
PRAGMA foreign_key_check;
