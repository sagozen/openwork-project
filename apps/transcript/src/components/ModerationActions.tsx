import { Button, Field, InlineNotice, TextInput } from "@templatedesign/ui";
import { useState } from "react";

export function ModerationActions({ reportId, csrfToken }: { reportId: string; csrfToken: string }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const resolve = async (action: "revoke_link" | "suspend_account" | "dismiss") => {
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch(`/api/v1/admin/abuse-reports/${reportId}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ action, note }),
      });
      if (!response.ok) throw new Error("Could not resolve the report.");
      window.location.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not resolve the report.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <Field label="Resolution note">
        {(props) => (
          <TextInput {...props} value={note} onChange={(event) => setNote(event.target.value)} maxLength={500} />
        )}
      </Field>
      {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}
      <div className="w-admin__actions">
        <Button variant="secondary" size="sm" loading={busy} onClick={() => resolve("revoke_link")}>
          Revoke link
        </Button>
        <Button variant="danger" size="sm" loading={busy} onClick={() => resolve("suspend_account")}>
          Suspend account
        </Button>
        <Button variant="tertiary" size="sm" loading={busy} onClick={() => resolve("dismiss")}>
          Dismiss
        </Button>
      </div>
    </div>
  );
}
