import { Button, Checkbox, Field, InlineNotice, TextInput } from "@templatedesign/ui";
import { useState } from "react";
import { errorMessage } from "../lib/account-format";

export interface UploadSettingsValues {
  enabled: boolean;
  maxInlineBytes: number;
  maxImportBytes: number;
}

const MB = 1024 * 1024;
/** The same ceilings the server enforces; the form only keeps people from typing a number it will refuse. */
const MAX_INLINE_MB = 4;
const MAX_IMPORT_MB = 500;

const toMb = (bytes: number) => String(Math.round((bytes / MB) * 100) / 100);

/** Admin-only form: the uploads kill switch and the two size limits. */
export function UploadSettingsForm({ values, csrfToken }: { values: UploadSettingsValues; csrfToken: string }) {
  const [enabled, setEnabled] = useState(values.enabled);
  const [inline, setInline] = useState(toMb(values.maxInlineBytes));
  const [imported, setImported] = useState(toMb(values.maxImportBytes));
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();

  const save = async () => {
    if (!reason.trim()) {
      setError("A reason is required; it is written to the append-only audit log.");
      return;
    }
    const inlineMb = Number(inline);
    const importMb = Number(imported);
    if (!(inlineMb > 0 && inlineMb <= MAX_INLINE_MB)) {
      setError(`The inline limit must be more than 0 and at most ${MAX_INLINE_MB} MB.`);
      return;
    }
    if (!(importMb > 0 && importMb <= MAX_IMPORT_MB)) {
      setError(`The import limit must be more than 0 and at most ${MAX_IMPORT_MB} MB.`);
      return;
    }
    setBusy(true);
    setError(undefined);
    setMessage(undefined);
    const pairs: Array<[string, unknown]> = [
      ["uploads.enabled", enabled],
      ["uploads.max_inline_bytes", Math.round(inlineMb * MB)],
      ["uploads.max_import_bytes", Math.round(importMb * MB)],
    ];
    try {
      for (const [key, value] of pairs) {
        const response = await fetch("/api/v1/admin/settings", {
          method: "PATCH",
          headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
          body: JSON.stringify({ key, value, reason }),
        });
        if (!response.ok) throw new Error(await errorMessage(response, `Could not update ${key}.`));
      }
      setMessage("Saved. The next request uses these values.");
      window.setTimeout(() => window.location.reload(), 800);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Save failed.");
    } finally {
      setBusy(false);
    }
  };

  const numberField = (label: string, hint: string, value: string, set: (next: string) => void) => (
    <Field label={label} hint={hint}>
      {(props) => (
        <TextInput
          {...props}
          type="number"
          min={0}
          step="any"
          value={value}
          onChange={(event) => set(event.target.value)}
        />
      )}
    </Field>
  );

  return (
    <div className="w-card">
      <Checkbox
        label="Uploads are on (turn off to refuse every new upload, inline save and import; reading and sharing keep working)"
        checked={enabled}
        onChange={(event) => setEnabled(event.target.checked)}
      />
      {numberField(
        "Inline upload limit (MB)",
        `Content sent inside one request. At most ${MAX_INLINE_MB} MB, which is what one MCP request carries.`,
        inline,
        setInline,
      )}
      {numberField(
        "Import limit (MB)",
        `Files fetched from a public URL. At most ${MAX_IMPORT_MB} MB. Sources that do not report a size are held in memory and capped at 32 MB.`,
        imported,
        setImported,
      )}
      <Field label="Reason for this change" required>
        {(props) => (
          <TextInput {...props} value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} />
        )}
      </Field>
      {message ? <InlineNotice tone="success">{message}</InlineNotice> : null}
      {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}
      <Button variant="primary" loading={busy} onClick={save}>
        Save changes
      </Button>
    </div>
  );
}
