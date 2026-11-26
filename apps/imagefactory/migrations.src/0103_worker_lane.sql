-- Worker lane: an agent registered in admin pulls image jobs over HTTPS and fal.ai is the fallback.
-- `workers` is operations infrastructure shared by every tenant, so it carries no tenant_id; the job
-- columns below belong to the existing tenant-scoped `image_jobs` rows.

CREATE TABLE IF NOT EXISTS workers (
  id text NOT NULL PRIMARY KEY,
  name text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  previous_token_hash text,
  previous_token_expires_at text,
  capabilities_json text NOT NULL DEFAULT '{}',
  last_heartbeat_at text,
  version text,
  disabled integer NOT NULL DEFAULT 0,
  created_at text NOT NULL,
  updated_at text NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workers_heartbeat ON workers (disabled, last_heartbeat_at);

-- Reference images are stored as descriptors (a public URL or a brand asset id) because the signed
-- link for a private brand asset lasts ten minutes and is made when the worker leases the job.
ALTER TABLE image_jobs ADD COLUMN refs_json text;
ALTER TABLE image_jobs ADD COLUMN leased_by text;
ALTER TABLE image_jobs ADD COLUMN lease_token text;
ALTER TABLE image_jobs ADD COLUMN lease_expires_at text;
ALTER TABLE image_jobs ADD COLUMN attempts integer NOT NULL DEFAULT 0;
-- The generator that made the images, as reported by the worker (for example "openclaw:gpt-image").
ALTER TABLE image_jobs ADD COLUMN rendered_by text;

CREATE INDEX IF NOT EXISTS idx_image_jobs_lane ON image_jobs (provider, state, updated_at);
