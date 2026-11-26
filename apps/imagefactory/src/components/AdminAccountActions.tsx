import type { AccountSearchResult } from "@templatedesign/platform/admin";
import { Button, Field, InlineNotice, TextInput } from "@templatedesign/ui";
import { useState } from "react";

/** Credit adjustment and suspension for one account. Every action needs a reason and is audited. */
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
  const [creditReason, setCreditReason] = useState("");
  const [suspendReason, setSuspendReason] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();

  const post = async (name: string, path: string, body: unknown) => {
    setBusy(name);
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
      setMessage("Done.");
      window.setTimeout(() => window.location.reload(), 600);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The action failed.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="w-admin__actions-panel">
      <h3>Adjust credits</h3>
      <Field label="Credits" hint="Positive adds purchased credits; negative reverses them.">
        {(props) => (
          <TextInput {...props} type="number" value={credits} onChange={(event) => setCredits(event.target.value)} />
        )}
      </Field>
      <Field label="Reason" required>
        {(props) => (
          <TextInput
            {...props}
            value={creditReason}
            onChange={(event) => setCreditReason(event.target.value)}
            maxLength={500}
          />
        )}
      </Field>
      <Button
        variant="primary"
        loading={busy === "credits"}
        onClick={() =>
          post("credits", `/api/v1/admin/accounts/${account.tenantId}/adjustments`, {
            credits: Number(credits),
            reason: creditReason,
          })
        }
      >
        Apply adjustment
      </Button>

      {role === "admin" ? (
        <>
          <h3>Suspension</h3>
          <Field label="Reason" hint="A suspended account cannot call any tool or API.">
            {(props) => (
              <TextInput
                {...props}
                value={suspendReason}
                onChange={(event) => setSuspendReason(event.target.value)}
                maxLength={500}
              />
            )}
          </Field>
          <Button
            variant="danger-outline"
            loading={busy === "suspend"}
            onClick={() =>
              post("suspend", `/api/v1/admin/accounts/${account.tenantId}/suspend`, {
                reason: suspendReason,
                action: account.suspendedAt ? "unsuspend" : "suspend",
              })
            }
          >
            {account.suspendedAt ? "Unsuspend account" : "Suspend account"}
          </Button>
          {account.suspendedAt ? <p className="td-field__hint">Suspended: {account.suspensionReason}</p> : null}
        </>
      ) : null}
      {message ? <InlineNotice tone="success">{message}</InlineNotice> : null}
      {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}
    </div>
  );
}
