import { Button, Field, InlineNotice, Select, TextInput } from "@templatedesign/ui";
import { useState } from "react";

export function AdminRoleForm({ csrfToken }: { csrfToken: string }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"support" | "admin">("support");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();

  const save = async () => {
    setBusy(true);
    setError(undefined);
    setMessage(undefined);
    try {
      const response = await fetch("/api/v1/admin/roles", {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ email, role, reason }),
      });
      if (!response.ok) throw new Error("Could not update the role.");
      setMessage("Role saved.");
      window.setTimeout(() => window.location.reload(), 600);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not update the role.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="w-card">
      <Field label="Account email" required>
        {(props) => (
          <TextInput {...props} type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
        )}
      </Field>
      <Field label="Role" required>
        {(props) => (
          <Select
            {...props}
            value={role}
            onChange={(event) => setRole(event.target.value as "support" | "admin")}
            options={[
              { value: "support", label: "Support — lookup and adjustments up to 500 credits" },
              { value: "admin", label: "Admin — full console, moderation and break-glass" },
            ]}
          />
        )}
      </Field>
      <Field label="Reason" required>
        {(props) => (
          <TextInput {...props} value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} />
        )}
      </Field>
      {message ? <InlineNotice tone="success">{message}</InlineNotice> : null}
      {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}
      <Button variant="primary" loading={busy} onClick={save}>
        Save role
      </Button>
    </div>
  );
}
