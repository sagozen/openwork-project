-- TranscriptAnything (phase 3): workers, the pull queue, quota bookkeeping, uploads and
-- LLM budget. Product tables only; everything shared (tenants, wallets, ledger, API keys,
-- webhooks, admin) comes from the platform baseline.

CREATE TABLE IF NOT EXISTS workers (
  id text NOT NULL PRIMARY KEY,
  name text NOT NULL,
  tier text NOT NULL CHECK (tier IN ('primary', 'fallback')),
  token_hash text NOT NULL UNIQUE,
  -- The previous token stays valid for a short overlap so a rotation never drops a job.
  previous_token_hash text,
  previous_token_expires_at text,
  capabilities_json text NOT NULL DEFAULT '{}',
  last_heartbeat_at text,
  version text,
  disabled integer NOT NULL DEFAULT 0,
  created_at text NOT NULL,
  updated_at text NOT NULL
);

CREATE INDEX IF NOT EXISTS workers_tier_idx ON workers (tier, disabled);

CREATE TABLE IF NOT EXISTS transcription_jobs (
  id text NOT NULL PRIMARY KEY,
  tenant_id text REFERENCES tenants (id) ON DELETE CASCADE,
  guest_id text,
  batch_id text,
  source_kind text NOT NULL,
  source_ref text NOT NULL,
  source_meta_json text NOT NULL DEFAULT '{}',
  stage text NOT NULL DEFAULT 'probe' CHECK (stage IN ('probe', 'transcribe', 'addons')),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'leased', 'preview_ready', 'awaiting_confirmation', 'succeeded', 'failed', 'cancelled', 'expired')),
  options_json text NOT NULL DEFAULT '{}',
  title text,
  preview integer NOT NULL DEFAULT 0,
  via_api integer NOT NULL DEFAULT 0,
  -- Above this many credits the job waits for the user's confirmation after the probe.
  confirm_above integer,
  duration_seconds integer,
  billable_minutes integer,
  free integer NOT NULL DEFAULT 0,
  pricing_state text NOT NULL DEFAULT 'pending'
    CHECK (pricing_state IN ('pending', 'free', 'reserved', 'addon_pending', 'settled', 'released')),
  reserved_credits integer NOT NULL DEFAULT 0,
  charged_credits integer NOT NULL DEFAULT 0,
  attempts integer NOT NULL DEFAULT 0,
  leased_by text,
  -- Random per-lease token: a completion from an earlier attempt cannot win, even if the same
  -- worker leases the job again after its previous lease expired.
  lease_token text,
  lease_expires_at text,
  queued_at text NOT NULL,
  started_at text,
  finished_at text,
  result_key text,
  result_formats_json text,
  addons_json text,
  error_code text,
  error_detail text,
  idempotency_key text,
  -- Random id for the completion that won; the settlement batch is keyed on it so a retried
  -- completion can never charge the same job twice.
  settlement_id text,
  created_at text NOT NULL,
  updated_at text NOT NULL
);

CREATE INDEX IF NOT EXISTS transcription_jobs_queue_idx ON transcription_jobs (status, free, queued_at);
CREATE INDEX IF NOT EXISTS transcription_jobs_tenant_idx ON transcription_jobs (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS transcription_jobs_guest_idx ON transcription_jobs (guest_id, created_at DESC);
CREATE INDEX IF NOT EXISTS transcription_jobs_batch_idx ON transcription_jobs (batch_id);
CREATE INDEX IF NOT EXISTS transcription_jobs_lease_idx ON transcription_jobs (status, lease_expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS transcription_jobs_idem_uidx
  ON transcription_jobs (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS minute_usage (
  tenant_id text NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  month text NOT NULL,
  minutes_used integer NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, month)
);

-- Free transcriptions per day per browser or account, and the caption allowance that does
-- not count against it. One table, one scope column.
CREATE TABLE IF NOT EXISTS free_job_usage (
  subject_id text NOT NULL,
  day text NOT NULL,
  scope text NOT NULL DEFAULT 'transcribe',
  jobs_used integer NOT NULL DEFAULT 0,
  PRIMARY KEY (subject_id, day, scope)
);

CREATE TABLE IF NOT EXISTS upload_sessions (
  id text NOT NULL PRIMARY KEY,
  tenant_id text REFERENCES tenants (id) ON DELETE CASCADE,
  guest_id text,
  r2_key text NOT NULL UNIQUE,
  upload_id text,
  filename text,
  content_type text,
  size_bytes integer,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'aborted')),
  created_at text NOT NULL,
  completed_at text,
  expires_at text NOT NULL
);

CREATE INDEX IF NOT EXISTS upload_sessions_expiry_idx ON upload_sessions (status, expires_at);

CREATE TABLE IF NOT EXISTS llm_usage (
  day text NOT NULL,
  model text NOT NULL,
  requests integer NOT NULL DEFAULT 0,
  PRIMARY KEY (day, model)
);
