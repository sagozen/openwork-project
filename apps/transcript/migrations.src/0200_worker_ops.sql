-- Worker operability (phase 4): host metrics for email warnings, remote config, the release
-- channel used by auto-update, and per-metric alert state so warnings fire on transitions
-- instead of every cron tick.

ALTER TABLE workers ADD COLUMN config_json text NOT NULL DEFAULT '{}';
ALTER TABLE workers ADD COLUMN config_version integer NOT NULL DEFAULT 0;
ALTER TABLE workers ADD COLUMN applied_config_version integer NOT NULL DEFAULT 0;
ALTER TABLE workers ADD COLUMN metrics_json text;
ALTER TABLE workers ADD COLUMN update_json text;

-- One row per worker per minute. The heartbeat upserts the current minute, so a 20 s heartbeat
-- costs 1440 rows per worker per day; the daily cron trims beyond 14 days.
CREATE TABLE IF NOT EXISTS worker_metrics (
  worker_id text NOT NULL REFERENCES workers (id) ON DELETE CASCADE,
  sampled_at text NOT NULL,
  cpu_percent real,
  mem_used_bytes integer,
  mem_total_bytes integer,
  disk_free_bytes integer,
  disk_total_bytes integer,
  cpu_temp_c real,
  gpu_temp_c real,
  gpu_usage_percent real,
  active_jobs integer,
  PRIMARY KEY (worker_id, sampled_at)
);

CREATE INDEX IF NOT EXISTS worker_metrics_time_idx ON worker_metrics (worker_id, sampled_at DESC);

-- Last known state per metric. A warning email is sent when a metric enters "warn" and a recovery
-- email when it returns to "ok"; the row also supplies `since` for the admin view.
CREATE TABLE IF NOT EXISTS worker_alert_state (
  worker_id text NOT NULL REFERENCES workers (id) ON DELETE CASCADE,
  metric text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('ok', 'warn')),
  value real,
  threshold real,
  since text NOT NULL,
  updated_at text NOT NULL,
  PRIMARY KEY (worker_id, metric)
);

CREATE TABLE IF NOT EXISTS worker_releases (
  id text NOT NULL PRIMARY KEY,
  version text NOT NULL,
  platform text NOT NULL DEFAULT 'windows',
  arch text NOT NULL DEFAULT 'amd64',
  object_key text NOT NULL,
  sha256 text NOT NULL,
  size_bytes integer NOT NULL,
  notes text,
  active integer NOT NULL DEFAULT 1,
  created_by text,
  created_at text NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS worker_releases_version_uidx
  ON worker_releases (version, platform, arch);
CREATE INDEX IF NOT EXISTS worker_releases_active_idx
  ON worker_releases (platform, arch, active, created_at DESC);
