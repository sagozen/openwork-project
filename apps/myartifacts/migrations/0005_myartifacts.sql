-- MyArtifacts: product tables only. Tenants, API keys, OAuth and admin settings come from the
-- platform baseline. Every table carries tenant_id and an index that starts with it. Files live in
-- the object store; these rows are metadata.

CREATE TABLE IF NOT EXISTS artifacts (
  id text NOT NULL PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  object_key text NOT NULL,
  name text NOT NULL,
  mime text NOT NULL,
  -- Size announced when the upload was created; for inline and URL uploads it equals size.
  declared_size integer,
  -- Real size as stored: the object's HEAD for presigned uploads, the byte count otherwise.
  size integer,
  sha256 text,
  status text NOT NULL CHECK (status IN ('pending', 'ready', 'deleted')),
  source text NOT NULL CHECK (source IN ('presigned', 'inline', 'url')),
  note text,
  -- Null keeps the file until it is deleted.
  expires_at text,
  created_at text NOT NULL,
  completed_at text,
  deleted_at text
);

CREATE INDEX IF NOT EXISTS idx_artifacts_tenant_status ON artifacts (tenant_id, status, created_at);
-- The hourly cleanup finds expired files by (status, expires_at) and abandoned uploads by (status, created_at).
CREATE INDEX IF NOT EXISTS idx_artifacts_status_expires ON artifacts (status, expires_at);
CREATE INDEX IF NOT EXISTS idx_artifacts_status_created ON artifacts (status, created_at);
