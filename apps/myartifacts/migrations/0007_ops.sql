-- One row per hourly cleanup run: what it removed and how many storage calls failed. This is
-- operational history for the admin overview and the daily digest, not tenant data, so it carries
-- no tenant_id (the cleanup itself spans every tenant).

CREATE TABLE IF NOT EXISTS sweep_runs (
  id text NOT NULL PRIMARY KEY,
  ran_at text NOT NULL,
  expired_deleted integer NOT NULL DEFAULT 0,
  pending_deleted integer NOT NULL DEFAULT 0,
  bytes_freed integer NOT NULL DEFAULT 0,
  storage_errors integer NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_sweep_runs_ran_at ON sweep_runs (ran_at);
