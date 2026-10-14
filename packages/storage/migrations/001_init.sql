CREATE TABLE device (
  id TEXT PRIMARY KEY, provider TEXT NOT NULL, external_id TEXT NOT NULL,
  name TEXT NOT NULL, model TEXT, created_at INTEGER NOT NULL,
  UNIQUE (provider, external_id));

CREATE TABLE capability_snapshot (
  id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES device(id),
  profile_hash TEXT NOT NULL, normalized_json TEXT NOT NULL CHECK (json_valid(normalized_json)),
  seen_at INTEGER NOT NULL);
CREATE INDEX ix_cap_device_seen ON capability_snapshot(device_id, seen_at DESC);

CREATE TABLE reading (
  device_id TEXT NOT NULL REFERENCES device(id), ts INTEGER NOT NULL,
  power INTEGER, mode TEXT, target_temp REAL, current_temp REAL, fan TEXT, humidity REAL,
  source TEXT NOT NULL,
  PRIMARY KEY (device_id, ts)) WITHOUT ROWID;

CREATE TABLE event_raw (
  id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT, received_at INTEGER NOT NULL,
  source TEXT NOT NULL, payload_json TEXT NOT NULL);
CREATE INDEX ix_event_raw_time ON event_raw(received_at);

CREATE TABLE rule (
  id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES device(id), name TEXT NOT NULL,
  enabled INTEGER NOT NULL, priority INTEGER NOT NULL,
  definition_json TEXT NOT NULL CHECK (json_valid(definition_json)),
  version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);

CREATE TABLE command (
  id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES device(id),
  created_at INTEGER NOT NULL, origin TEXT NOT NULL,
  rule_id TEXT REFERENCES rule(id) ON DELETE SET NULL, idempotency_key TEXT,
  attributes_json TEXT NOT NULL, status TEXT NOT NULL,
  skip_reason TEXT, error_kind TEXT, error_code TEXT,
  sent_at INTEGER, confirmed_at INTEGER, latency_ms INTEGER);
CREATE INDEX ix_command_device_time ON command(device_id, created_at DESC);
CREATE UNIQUE INDEX ux_command_idem ON command(device_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE rule_state (
  rule_id TEXT PRIMARY KEY REFERENCES rule(id) ON DELETE CASCADE,
  state TEXT NOT NULL, since INTEGER NOT NULL, until_ts INTEGER, context_json TEXT);

CREATE TABLE rule_run (
  id TEXT PRIMARY KEY, rule_id TEXT NOT NULL REFERENCES rule(id) ON DELETE CASCADE,
  started_at INTEGER NOT NULL, ended_at INTEGER, outcome TEXT, reason TEXT);
CREATE INDEX ix_rule_run ON rule_run(rule_id, started_at DESC);

CREATE TABLE session (
  id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES device(id),
  start_ts INTEGER NOT NULL, end_ts INTEGER,
  temp_start REAL, temp_end REAL, target_temp REAL, mode TEXT, fan TEXT,
  origin TEXT, rule_id TEXT REFERENCES rule(id) ON DELETE SET NULL,
  closed_by TEXT, energy_wh_est REAL, cost_est REAL, estimate_method TEXT, estimate_basis_json TEXT);
CREATE INDEX ix_session_device_time ON session(device_id, start_ts DESC);
CREATE UNIQUE INDEX ux_session_open ON session(device_id) WHERE end_ts IS NULL;

CREATE TABLE energy_hourly (
  device_id TEXT NOT NULL REFERENCES device(id), hour_ts INTEGER NOT NULL,
  wh REAL NOT NULL, collected_at INTEGER NOT NULL, PRIMARY KEY (device_id, hour_ts)) WITHOUT ROWID;
CREATE TABLE energy_daily (
  device_id TEXT NOT NULL REFERENCES device(id), date TEXT NOT NULL,
  wh REAL NOT NULL, final INTEGER NOT NULL DEFAULT 0, collected_at INTEGER NOT NULL,
  raw_json TEXT, PRIMARY KEY (device_id, date)) WITHOUT ROWID;
CREATE TABLE energy_monthly (
  device_id TEXT NOT NULL REFERENCES device(id), month TEXT NOT NULL,
  wh REAL NOT NULL, collected_at INTEGER NOT NULL, PRIMARY KEY (device_id, month)) WITHOUT ROWID;

CREATE TABLE tariff (
  id TEXT PRIMARY KEY, valid_from TEXT NOT NULL UNIQUE,
  price_per_kwh_micro INTEGER NOT NULL, note TEXT, created_at INTEGER NOT NULL);
CREATE TABLE goal (month TEXT PRIMARY KEY, budget_cents INTEGER NOT NULL);

CREATE TABLE rollup_hourly (
  device_id TEXT NOT NULL REFERENCES device(id), hour_ts INTEGER NOT NULL,
  temp_avg REAL, temp_min REAL, temp_max REAL, target_avg REAL, minutes_on INTEGER NOT NULL,
  samples INTEGER NOT NULL, PRIMARY KEY (device_id, hour_ts)) WITHOUT ROWID;

CREATE TABLE setting (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
CREATE TABLE auth_session (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
