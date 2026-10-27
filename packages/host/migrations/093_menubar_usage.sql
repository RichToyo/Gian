-- Numeric local execution facts only. No cascading session/Agent foreign keys.
CREATE TABLE usage_tracking_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  generation INTEGER NOT NULL DEFAULT 1,
  revision INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  cleared_at INTEGER
);
CREATE TABLE usage_sources (
  source_key TEXT PRIMARY KEY,
  epoch TEXT NOT NULL DEFAULT 'initial',
  agent_id TEXT,
  agent_label TEXT NOT NULL,
  plugin_id TEXT,
  partial INTEGER NOT NULL DEFAULT 1,
  anchor_required INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE usage_origins (
  source_key TEXT PRIMARY KEY,
  baseline TEXT NOT NULL CHECK(baseline IN ('zero', 'anchor')),
  bound_at INTEGER NOT NULL
);
CREATE TABLE usage_cursors (
  source_key TEXT NOT NULL REFERENCES usage_sources(source_key),
  epoch TEXT NOT NULL,
  model_key TEXT NOT NULL,
  counters_json TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  host_turn TEXT NOT NULL,
  PRIMARY KEY(source_key, epoch, model_key)
);
CREATE TABLE usage_receipts (
  source_key TEXT NOT NULL REFERENCES usage_sources(source_key),
  epoch TEXT NOT NULL,
  sample_key TEXT NOT NULL,
  model_key TEXT NOT NULL,
  PRIMARY KEY(source_key, sample_key, model_key)
);
CREATE TABLE usage_samples (
  source_key TEXT NOT NULL REFERENCES usage_sources(source_key),
  epoch TEXT NOT NULL,
  sample_key TEXT NOT NULL,
  model_key TEXT NOT NULL,
  model_id TEXT,
  generation INTEGER NOT NULL,
  occurred_at INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  time_basis TEXT NOT NULL CHECK(time_basis IN ('provider', 'observed')),
  total_tokens INTEGER NOT NULL CHECK(total_tokens >= 0),
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  reasoning_tokens INTEGER,
  PRIMARY KEY(source_key, epoch, sample_key, model_key)
);
CREATE INDEX idx_usage_samples_range ON usage_samples(generation, occurred_at);
CREATE TABLE usage_clear_requests (
  request_key TEXT PRIMARY KEY,
  expected_generation INTEGER NOT NULL,
  result_generation INTEGER NOT NULL
);
