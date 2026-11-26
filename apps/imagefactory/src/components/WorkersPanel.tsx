import { Button, Field, InlineNotice, TextInput } from "@templatedesign/ui";
import { useState } from "react";

export interface WorkerRowView {
  id: string;
  name: string;
  version: string | null;
  engine: string | null;
  kinds: string;
  lastHeartbeatAt: string | null;
  disabled: boolean;
  online: boolean;
}

/** Admin-only: register a worker, rotate its token, switch it off. A token is shown once, then only its hash exists. */
export function WorkersPanel({ workers, csrfToken }: { workers: WorkerRowView[]; csrfToken: string }) {
  const [name, setName] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [token, setToken] = useState<{ label: string; value: string }>();

  const call = async (url: string, method: string, body: unknown) => {
    const response = await fetch(url, {
      method,
      headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
      body: JSON.stringify(body),
    });
    const payload = (await response.json().catch(() => ({}))) as { token?: string; error?: { message?: string } };
    if (!response.ok) throw new Error(payload.error?.message ?? "The request failed.");
    return payload;
  };

  const run = async (task: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await task();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The request failed.");
    } finally {
      setBusy(false);
    }
  };

  const register = () =>
    run(async () => {
      const payload = await call("/api/v1/admin/workers", "POST", { name });
      setToken({ label: name, value: payload.token ?? "" });
      setName("");
    });

  const act = (worker: WorkerRowView, action: "rotate" | "disable" | "enable") =>
    run(async () => {
      if (!reason.trim()) throw new Error("Write a reason first; it goes in the audit log.");
      const payload = await call(`/api/v1/admin/workers/${worker.id}`, "PATCH", { action, reason });
      if (payload.token) setToken({ label: worker.name, value: payload.token });
      else window.location.reload();
    });

  return (
    <div className="w-card">
      <h2>Workers</h2>
      <p className="td-muted">
        A worker pulls image jobs over HTTPS with its own token. While one is online, jobs go to it; fal.ai is the
        fallback.
      </p>
      {token ? (
        <InlineNotice tone="success">
          Token for {token.label}, shown once: <code>{token.value}</code>
        </InlineNotice>
      ) : null}
      {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}
      <table className="td-table td-table--dense">
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Status</th>
            <th scope="col">Version</th>
            <th scope="col">Can do</th>
            <th scope="col">Last heartbeat</th>
            <th scope="col">Actions</th>
          </tr>
        </thead>
        <tbody>
          {workers.map((worker) => (
            <tr key={worker.id}>
              <th scope="row">{worker.name}</th>
              <td>{worker.disabled ? "disabled" : worker.online ? "online" : "offline"}</td>
              <td>{worker.version ?? "—"}</td>
              <td>{worker.kinds}</td>
              <td>{worker.lastHeartbeatAt ?? "never"}</td>
              <td>
                <Button variant="secondary" disabled={busy} onClick={() => act(worker, "rotate")}>
                  Rotate token
                </Button>{" "}
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => act(worker, worker.disabled ? "enable" : "disable")}
                >
                  {worker.disabled ? "Enable" : "Disable"}
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {workers.length === 0 ? <p className="td-muted">No workers yet. Every job goes to fal.ai.</p> : null}
      <Field label="Reason for rotate, disable or enable" hint="Written to the audit log.">
        {(props) => (
          <TextInput {...props} value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} />
        )}
      </Field>
      <Field label="New worker name" hint="For example openclaw-mac-mini.">
        {(props) => (
          <TextInput {...props} value={name} onChange={(event) => setName(event.target.value)} maxLength={80} />
        )}
      </Field>
      <Button variant="primary" loading={busy} disabled={!name.trim()} onClick={register}>
        Register worker
      </Button>
    </div>
  );
}
