-- Ota: product tables only. Everything shared (tenants, wallets, ledger, API keys, webhooks,
-- admin, workspaces) comes from the platform baseline and the workspaces module. Every business
-- table carries workspace_id and an index that starts with it.
--
-- An app slug is unique per workspace, so two workspaces can both publish an app called "my-app".
-- Releases, the current-build pointer and tokens reference the app by (workspace_id, slug).

CREATE TABLE IF NOT EXISTS ota_apps (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  slug text NOT NULL,
  name text NOT NULL,
  enabled integer NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  version integer NOT NULL DEFAULT 1,
  created_at integer NOT NULL,
  updated_at integer NOT NULL,
  PRIMARY KEY (workspace_id, slug)
);

CREATE TABLE IF NOT EXISTS ota_releases (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id text NOT NULL,
  app text NOT NULL,
  platform text NOT NULL CHECK (platform IN ('android', 'ios')),
  channel text NOT NULL,
  binary text NOT NULL,
  release_id text NOT NULL,
  file text NOT NULL,
  sha256 text NOT NULL CHECK (length(sha256) = 64),
  size integer NOT NULL CHECK (size > 0),
  note text NOT NULL DEFAULT '',
  commit_sha text NOT NULL DEFAULT '',
  signature text NOT NULL DEFAULT '',
  mandatory integer NOT NULL DEFAULT 0 CHECK (mandatory IN (0, 1)),
  branch text NOT NULL DEFAULT '',
  created_at integer NOT NULL,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, app) REFERENCES ota_apps (workspace_id, slug) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ota_releases_file ON ota_releases (workspace_id, app, platform, file);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ota_releases_release_id
  ON ota_releases (workspace_id, app, platform, channel, binary, release_id);
CREATE INDEX IF NOT EXISTS idx_ota_releases_pair
  ON ota_releases (workspace_id, app, platform, channel, binary, created_at);
CREATE INDEX IF NOT EXISTS idx_ota_releases_ws_created ON ota_releases (workspace_id, created_at);

CREATE TABLE IF NOT EXISTS ota_current (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  app text NOT NULL,
  platform text NOT NULL,
  channel text NOT NULL,
  binary text NOT NULL,
  release_id text NOT NULL,
  updated_at integer NOT NULL,
  PRIMARY KEY (workspace_id, app, platform, channel, binary),
  FOREIGN KEY (workspace_id, release_id) REFERENCES ota_releases (workspace_id, id)
);

CREATE INDEX IF NOT EXISTS idx_ota_current_release ON ota_current (workspace_id, release_id);

CREATE TABLE IF NOT EXISTS ota_tokens (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id text NOT NULL,
  app text NOT NULL,
  name text NOT NULL,
  token_hash text NOT NULL,
  token_prefix text NOT NULL,
  created_at integer NOT NULL,
  last_used_at integer,
  revoked_at integer,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, app) REFERENCES ota_apps (workspace_id, slug) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ota_tokens_hash ON ota_tokens (workspace_id, token_hash);
CREATE INDEX IF NOT EXISTS idx_ota_tokens_app ON ota_tokens (workspace_id, app, created_at);

CREATE TABLE IF NOT EXISTS ota_settings (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  key text NOT NULL,
  value text NOT NULL CHECK (json_valid(value)),
  version integer NOT NULL DEFAULT 1,
  updated_at integer NOT NULL,
  PRIMARY KEY (workspace_id, key)
);

CREATE TABLE IF NOT EXISTS ota_audit (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id text NOT NULL,
  actor_id text,
  actor_kind text NOT NULL,
  action text NOT NULL,
  app text,
  platform text,
  channel text,
  binary text,
  detail_json text NOT NULL DEFAULT '{}' CHECK (json_valid(detail_json)),
  created_at integer NOT NULL,
  PRIMARY KEY (workspace_id, id)
);

CREATE INDEX IF NOT EXISTS idx_ota_audit_ws_created ON ota_audit (workspace_id, created_at);
