-- Removing an environment in Settings keeps its row: its sessions and create
-- requests reference it, and SQLite cannot relax those keys without
-- rebuilding the tables. A removed environment is never connected and never
-- offered for new work; its sessions stay as read-only history, and Restore
-- clears removed_at. Nothing is revoked on the Server or the Host, which
-- would keep this Mac from ever pairing that Host again.
ALTER TABLE remote_controller_environments ADD COLUMN removed_at INTEGER;
-- Last time this Mac held a live connection to the Host (epoch ms).
ALTER TABLE remote_controller_environments ADD COLUMN last_seen_at INTEGER;
