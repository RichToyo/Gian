-- Remote Web translation sync (Issue #181):
-- 1. queue_entries.translation_id persists the explicit send intent through
--    busy-queue drain: a receipt id dispatches the prepared translation,
--    'original' keeps the deliberate untranslated bypass. Without it a queued
--    "send original" would be translated again at drain time.
-- 2. session_translation_preferences.revision is the monotonic per-session
--    switch revision: connected views (local pages and Remote clients) reject
--    stale toggle results instead of letting an old response overwrite a
--    newer persisted value.
ALTER TABLE queue_entries ADD COLUMN translation_id TEXT;
ALTER TABLE session_translation_preferences ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
