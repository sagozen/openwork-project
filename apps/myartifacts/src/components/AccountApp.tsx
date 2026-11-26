import type { ApiKeyMetadata } from "@templatedesign/platform/keys";
import { Button, Field, InlineNotice, Select, TextInput } from "@templatedesign/ui";
import { useCallback, useEffect, useState } from "react";
import { errorMessage, formatBytes, when } from "../lib/account-format";
import { ConnectorUrl } from "./ConnectorUrl.js";
import { CopyButton } from "./CopyButton.js";
import { type FileRow, FilesPanel } from "./FilesPanel.js";
import { type ShareRow, SharesPanel } from "./SharesPanel.js";

interface Connection {
  id: string;
  name: string;
  scopes: string[];
  createdAt: string;
}

export interface AccountAppProps {
  email: string;
  mcpUrl: string;
  usage: { files: number; bytes: number };
  files: { items: FileRow[]; next_cursor: string | null };
  shares: { items: ShareRow[]; next_cursor: string | null };
  keys: ApiKeyMetadata[];
  csrfToken: string;
  isAdmin: boolean;
}

const READ_WRITE = "artifacts:read,artifacts:write";

export function AccountApp(props: AccountAppProps) {
  const headers = { "content-type": "application/json", "x-csrf-token": props.csrfToken };
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [keys, setKeys] = useState(props.keys);
  const [keyName, setKeyName] = useState("");
  const [access, setAccess] = useState(READ_WRITE);
  const [newKey, setNewKey] = useState<string>();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string>();

  const loadConnections = useCallback(async () => {
    const response = await fetch("/api/agents", { headers: { accept: "application/json" } });
    if (response.ok) setConnections(((await response.json()) as { connections: Connection[] }).connections);
    else setConnections([]);
  }, []);

  useEffect(() => {
    void loadConnections();
  }, [loadConnections]);

  const revokeConnection = async (id: string) => {
    setBusy(`connection:${id}`);
    setError(undefined);
    const response = await fetch("/api/agents/revoke", { method: "POST", headers, body: JSON.stringify({ id }) });
    if (response.ok) await loadConnections();
    else setError(await errorMessage(response, "Could not disconnect that app."));
    setBusy(null);
  };

  const createKey = async () => {
    setBusy("create-key");
    setError(undefined);
    setNewKey(undefined);
    const response = await fetch("/api/v1/api-keys", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: keyName, scopes: access.split(",") }),
    });
    if (response.ok) {
      const created = (await response.json()) as { key: string; metadata: ApiKeyMetadata };
      setNewKey(created.key);
      setKeys([created.metadata, ...keys]);
      setKeyName("");
    } else setError(await errorMessage(response, "Could not create the key."));
    setBusy(null);
  };

  const revokeKey = async (id: string) => {
    setBusy(`key:${id}`);
    setError(undefined);
    const response = await fetch(`/api/v1/api-keys/${id}`, { method: "DELETE", headers });
    if (response.ok) {
      const { key } = (await response.json()) as { key: ApiKeyMetadata };
      setKeys(keys.map((item) => (item.id === id ? key : item)));
    } else setError(await errorMessage(response, "Could not revoke the key."));
    setBusy(null);
  };

  return (
    <div className="w-account">
      {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}

      <section className="w-card" aria-labelledby="acct-usage">
        <h2 id="acct-usage">Storage</h2>
        <dl className="w-facts">
          <div>
            <dt>Files</dt>
            <dd>{props.usage.files}</dd>
          </div>
          <div>
            <dt>Used</dt>
            <dd>{formatBytes(props.usage.bytes)}</dd>
          </div>
        </dl>
        <p className="td-muted">
          Files are kept until you delete them or an expiry you set passes. There is no storage limit or charge here.
        </p>
      </section>

      <section className="w-card" aria-labelledby="acct-connector">
        <h2 id="acct-connector">Connector URL</h2>
        <p className="td-muted">
          Add this to Claude (Settings, Connectors, Add custom connector) or ChatGPT (developer mode, add MCP server),
          then sign in with {props.email}.
        </p>
        <ConnectorUrl url={props.mcpUrl} />
      </section>

      <FilesPanel initial={props.files.items} nextCursor={props.files.next_cursor} csrfToken={props.csrfToken} />
      <SharesPanel initial={props.shares.items} nextCursor={props.shares.next_cursor} csrfToken={props.csrfToken} />

      <section className="w-card" aria-labelledby="acct-apps">
        <h2 id="acct-apps">Connected apps</h2>
        <p className="td-muted">
          Disconnecting an app signs it out at once; its next request asks you to sign in again.
        </p>
        {connections === null ? <p className="td-muted">Loading…</p> : null}
        {connections?.length === 0 ? <p className="td-muted">No apps connected yet.</p> : null}
        {connections?.map((connection) => (
          <div className="w-row w-row--between" key={connection.id}>
            <span>
              <strong>{connection.name}</strong> <span className="td-muted">· {connection.scopes.join(", ")}</span>
              <br />
              <span className="td-muted">Connected {when(connection.createdAt)}</span>
            </span>
            <Button
              variant="danger-outline"
              size="sm"
              loading={busy === `connection:${connection.id}`}
              onClick={() => revokeConnection(connection.id)}
            >
              Disconnect
            </Button>
          </div>
        ))}
      </section>

      <section className="w-card" aria-labelledby="acct-keys">
        <h2 id="acct-keys">API keys</h2>
        <p className="td-muted">
          For n8n, scripts or any HTTP client: send <code>Authorization: Bearer &lt;key&gt;</code> to{" "}
          <code>/api/v1/files</code> or to <code>/mcp</code>. A key is shown once.
        </p>
        {newKey ? (
          <InlineNotice tone="success" title="Copy your new key now">
            <div className="w-copyrow">
              <code>{newKey}</code>
              <CopyButton value={newKey} label="Copy key" />
            </div>
          </InlineNotice>
        ) : null}
        <Field label="Key name" hint="For example n8n upload workflow.">
          {(fieldProps) => (
            <TextInput
              {...fieldProps}
              value={keyName}
              maxLength={80}
              onChange={(event) => setKeyName(event.target.value)}
            />
          )}
        </Field>
        <Field label="Access">
          {(fieldProps) => (
            <Select
              {...fieldProps}
              value={access}
              onChange={(event) => setAccess(event.target.value)}
              options={[
                { value: READ_WRITE, label: "Read and write: can save, delete and share files" },
                { value: "artifacts:read", label: "Read only: can list files and shares and make download links" },
              ]}
            />
          )}
        </Field>
        <Button variant="primary" loading={busy === "create-key"} disabled={!keyName.trim()} onClick={createKey}>
          Create key
        </Button>
        {keys.length > 0 ? (
          <div className="w-table-wrap">
            <table className="td-table td-table--dense">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Key</th>
                  <th scope="col">Access</th>
                  <th scope="col">Last used</th>
                  <th scope="col">
                    <span className="td-visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {keys.map((key) => (
                  <tr key={key.id}>
                    <th scope="row">{key.name}</th>
                    <td>
                      <code>{key.prefix}…</code>
                    </td>
                    <td>{key.scopes.includes("artifacts:write") ? "read and write" : "read only"}</td>
                    <td>{key.revokedAt ? "revoked" : when(key.lastUsedAt)}</td>
                    <td>
                      {key.revokedAt ? null : (
                        <Button
                          variant="danger-outline"
                          size="sm"
                          loading={busy === `key:${key.id}`}
                          onClick={() => revokeKey(key.id)}
                        >
                          Revoke
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      <p>
        {props.isAdmin ? (
          <>
            <a href="/admin/">Admin console</a> ·{" "}
          </>
        ) : null}
        <button
          type="button"
          className="td-btn td-btn--link"
          onClick={async () => {
            await fetch("/api/auth/sign-out", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: "{}",
            });
            window.location.href = "/";
          }}
        >
          Sign out
        </button>
      </p>
    </div>
  );
}
