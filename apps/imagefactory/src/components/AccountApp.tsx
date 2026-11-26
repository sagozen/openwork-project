import type { ApiKeyMetadata } from "@templatedesign/platform/keys";
import { Button, Field, InlineNotice, Select, TextInput } from "@templatedesign/ui";
import { useCallback, useEffect, useState } from "react";
import { ConnectorUrl } from "./ConnectorUrl.js";
import { CopyButton } from "./CopyButton.js";

export interface LedgerLine {
  id: string;
  kind: string;
  credits: number;
  job_id: string | null;
  created_at: string;
}

interface Connection {
  id: string;
  name: string;
  scopes: string[];
  createdAt: string;
}

export interface AccountAppProps {
  email: string;
  mcpUrl: string;
  available: number;
  reserved: number;
  ledger: LedgerLine[];
  keys: ApiKeyMetadata[];
  csrfToken: string;
  isAdmin: boolean;
}

const when = (iso: string | null) => (iso ? iso.slice(0, 16).replace("T", " ") : "never");

export function AccountApp(props: AccountAppProps) {
  const headers = { "content-type": "application/json", "x-csrf-token": props.csrfToken };
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [keys, setKeys] = useState(props.keys);
  const [keyName, setKeyName] = useState("");
  const [access, setAccess] = useState("images:read,images:write");
  const [newKey, setNewKey] = useState<string>();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const [confirmDelete, setConfirmDelete] = useState("");

  const loadConnections = useCallback(async () => {
    const response = await fetch("/api/agents", { headers: { accept: "application/json" } });
    if (response.ok) setConnections(((await response.json()) as { connections: Connection[] }).connections);
    else setConnections([]);
  }, []);

  useEffect(() => {
    void loadConnections();
  }, [loadConnections]);

  const fail = async (response: Response, fallback: string) => {
    const problem = (await response.json().catch(() => ({}))) as { detail?: string };
    setError(problem.detail ?? fallback);
  };

  const revokeConnection = async (id: string) => {
    setBusy(`connection:${id}`);
    setError(undefined);
    const response = await fetch("/api/agents/revoke", { method: "POST", headers, body: JSON.stringify({ id }) });
    if (response.ok) await loadConnections();
    else await fail(response, "Could not disconnect that app.");
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
    } else await fail(response, "Could not create the key.");
    setBusy(null);
  };

  const revokeKey = async (id: string) => {
    setBusy(`key:${id}`);
    setError(undefined);
    const response = await fetch(`/api/v1/api-keys/${id}`, { method: "DELETE", headers });
    if (response.ok) {
      const { key } = (await response.json()) as { key: ApiKeyMetadata };
      setKeys(keys.map((item) => (item.id === id ? key : item)));
    } else await fail(response, "Could not revoke the key.");
    setBusy(null);
  };

  const deleteAccount = async () => {
    setBusy("delete");
    setError(undefined);
    const response = await fetch("/api/v1/account/delete", { method: "POST", headers, body: "{}" });
    if (response.ok) window.location.href = "/";
    else {
      await fail(response, "Could not start the deletion.");
      setBusy(null);
    }
  };

  return (
    <div className="w-account">
      {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}

      <section className="w-card" aria-labelledby="acct-connector">
        <h2 id="acct-connector">Connector URL</h2>
        <p className="td-muted">
          Add this to Claude (Settings, Connectors, Add custom connector) or ChatGPT (developer mode, add MCP server),
          then sign in with {props.email}.
        </p>
        <ConnectorUrl url={props.mcpUrl} />
      </section>

      <section className="w-card" aria-labelledby="acct-credits">
        <h2 id="acct-credits">Credits</h2>
        <p>
          <strong>{props.available}</strong> available
          {props.reserved > 0 ? ` (${props.reserved} reserved for images in progress)` : ""}. One credit is one US cent.
        </p>
        <p className="td-muted">Credits are added by the account owner. Ask for a top-up when you run low.</p>
        {props.ledger.length === 0 ? (
          <p className="td-muted">No activity yet.</p>
        ) : (
          <table className="td-table td-table--dense">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Entry</th>
                <th scope="col" className="td-table__numeric">
                  Credits
                </th>
              </tr>
            </thead>
            <tbody>
              {props.ledger.map((line) => (
                <tr key={line.id}>
                  <td>{when(line.created_at)}</td>
                  <td>{line.kind}</td>
                  <td className="td-table__numeric">{line.credits}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

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
          For n8n, Make, Postiz or any HTTP client: send <code>Authorization: Bearer &lt;key&gt;</code> to{" "}
          <code>/api/v1/images/generate</code> or to <code>/mcp</code>. A key is shown once.
        </p>
        {newKey ? (
          <InlineNotice tone="success" title="Copy your new key now">
            <div className="w-copyrow">
              <code>{newKey}</code>
              <CopyButton value={newKey} label="Copy key" />
            </div>
          </InlineNotice>
        ) : null}
        <Field label="Key name" hint="For example n8n pins workflow.">
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
                { value: "images:read,images:write", label: "Read and write: can make images and spend credits" },
                { value: "images:read", label: "Read only: can list images, brands and the balance" },
              ]}
            />
          )}
        </Field>
        <Button variant="primary" loading={busy === "create-key"} disabled={!keyName.trim()} onClick={createKey}>
          Create key
        </Button>
        {keys.length > 0 ? (
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
                  <td>{key.scopes.includes("images:write") ? "read and write" : "read only"}</td>
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
        ) : null}
      </section>

      <section className="w-card w-card--danger" aria-labelledby="acct-delete">
        <h2 id="acct-delete">Delete account</h2>
        <p className="td-muted">
          Removes your brand kits, images and keys after a 30-day grace period. Type <code>delete</code> to confirm.
        </p>
        <Field label="Confirmation">
          {(fieldProps) => (
            <TextInput
              {...fieldProps}
              value={confirmDelete}
              onChange={(event) => setConfirmDelete(event.target.value)}
            />
          )}
        </Field>
        <Button
          variant="danger-outline"
          loading={busy === "delete"}
          disabled={confirmDelete.trim().toLowerCase() !== "delete"}
          onClick={deleteAccount}
        >
          Delete my account
        </Button>
      </section>

      <p>
        <a href="/legal/terms">Terms</a> · <a href="/legal/privacy">Privacy</a>
        {props.isAdmin ? (
          <>
            {" "}
            · <a href="/admin/">Admin console</a>
          </>
        ) : null}{" "}
        ·{" "}
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
