import type { AccountSearchResult } from "@templatedesign/platform/admin";
import { Button, Field, InlineNotice, TextInput } from "@templatedesign/ui";
import { useState } from "react";

export function AdminAccountActions({
  account,
  role,
  csrfToken,
}: {
  account: AccountSearchResult;
  role: "admin" | "support";
  csrfToken: string;
}) {
  const [credits, setCredits] = useState("100");
  const [reason, setReason] = useState("");
  const [suspendReason, setSuspendReason] = useState("");
  const [overrideValue, setOverrideValue] = useState("50");
  const [overrideReason, setOverrideReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();

  const post = async (path: string, body: Record<string, unknown>) => {
    setBusy(true);
    setError(undefined);
    setMessage(undefined);
    try {
      const response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const problem = (await response.json().catch(() => ({}))) as { detail?: string };
        throw new Error(problem.detail ?? "The action failed.");
      }
      setMessage("Saved. Reloading…");
      window.setTimeout(() => window.location.reload(), 500);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The action failed.");
    } finally {
      setBusy(false);
    }
  };

  const breakGlass = async (outputId: string) => {
    const why = window.prompt("Break-glass reason (recorded in the audit log):");
    if (!why) return;
    setBusy(true);
    try {
      const response = await fetch("/api/v1/admin/break-glass", {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ transcriptionId: outputId, reason: why }),
      });
      if (!response.ok) throw new Error("Break-glass failed.");
      const body = (await response.json()) as { transcript?: unknown };
      const blob = new Blob([JSON.stringify(body.transcript, null, 2)], { type: "application/json" });
      window.open(URL.createObjectURL(blob), "_blank", "noopener,noreferrer");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Break-glass failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="w-admin__actions-wrap">
      {message ? <InlineNotice tone="success">{message}</InlineNotice> : null}
      {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}

      <fieldset className="td-fieldset">
        <legend className="td-field__label">
          Credit adjustment (cap {role === "support" ? "500" : "100,000"} per action)
        </legend>
        <Field label="Credits" hint="Positive grants purchased credits; negative reverses them.">
          {(props) => (
            <TextInput {...props} type="number" value={credits} onChange={(event) => setCredits(event.target.value)} />
          )}
        </Field>
        <Field label="Reason" required>
          {(props) => (
            <TextInput {...props} value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} />
          )}
        </Field>
        <Button
          variant="primary"
          size="sm"
          loading={busy}
          onClick={() =>
            post(`/api/v1/admin/accounts/${account.tenantId}/adjustments`, { credits: Number(credits), reason })
          }
        >
          Apply adjustment
        </Button>
      </fieldset>

      {role === "admin" ? (
        <fieldset className="td-fieldset">
          <legend className="td-field__label">Tenant test-mode cap override</legend>
          <Field label="Renders per day" hint="Leave blank to remove the override. Global value applies otherwise.">
            {(props) => (
              <TextInput
                {...props}
                type="number"
                min={0}
                value={overrideValue}
                onChange={(event) => setOverrideValue(event.target.value)}
              />
            )}
          </Field>
          <Field label="Reason" required>
            {(props) => (
              <TextInput
                {...props}
                value={overrideReason}
                onChange={(event) => setOverrideReason(event.target.value)}
              />
            )}
          </Field>
          <div className="w-admin__actions">
            <Button
              variant="secondary"
              size="sm"
              loading={busy}
              onClick={() =>
                post(`/api/v1/admin/accounts/${account.tenantId}/overrides`, {
                  key: "test_daily_cap",
                  value: overrideValue === "" ? null : Number(overrideValue),
                  reason: overrideReason,
                })
              }
            >
              Set override
            </Button>
            <Button
              variant="tertiary"
              size="sm"
              loading={busy}
              onClick={() =>
                post(`/api/v1/admin/accounts/${account.tenantId}/overrides`, {
                  key: "test_daily_cap",
                  value: null,
                  reason: overrideReason || "remove override",
                })
              }
            >
              Remove override
            </Button>
          </div>
        </fieldset>
      ) : null}

      <fieldset className="td-fieldset">
        <legend className="td-field__label">Suspension</legend>
        <Field label="Reason" hint="Suspension stops admission and revokes share links, API keys and webhooks.">
          {(props) => (
            <TextInput {...props} value={suspendReason} onChange={(event) => setSuspendReason(event.target.value)} />
          )}
        </Field>
        {role === "admin" ? (
          <div className="w-admin__actions">
            <Button
              variant="danger"
              size="sm"
              loading={busy}
              onClick={() =>
                post(`/api/v1/admin/accounts/${account.tenantId}/suspend`, {
                  reason: suspendReason,
                  action: account.suspendedAt ? "unsuspend" : "suspend",
                })
              }
            >
              {account.suspendedAt ? "Unsuspend account" : "Suspend account"}
            </Button>
            {account.suspendedAt ? <span className="td-field__hint">Suspended: {account.suspensionReason}</span> : null}
          </div>
        ) : (
          <p className="td-field__hint">Only an admin can suspend an account.</p>
        )}
      </fieldset>

      {role === "admin" ? (
        <fieldset className="td-fieldset">
          <legend className="td-field__label">Break-glass content access</legend>
          <p className="td-field__hint">
            Default is none. Every view requires a reason and is appended to the audit log. Support cannot use this
            path.
          </p>
          <div className="w-admin__actions">
            {account.jobs
              .filter((job) => job.resourceId)
              .map((job) => (
                <Button key={job.id} variant="danger-outline" size="sm" onClick={() => breakGlass(job.resourceId!)}>
                  View {job.label || job.id} transcript
                </Button>
              ))}
            {account.jobs.every((job) => !job.resourceId) ? (
              <span className="td-field__hint">No retained output.</span>
            ) : null}
          </div>
        </fieldset>
      ) : null}
    </div>
  );
}
