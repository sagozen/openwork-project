import { Button, Checkbox, Field, InlineNotice, TextInput } from "@templatedesign/ui";
import { useState } from "react";

export interface ImageSettingsValues {
  enabled: boolean;
  maxImages: number;
  ratePerMinute: number;
  workerWaitSeconds: number;
  generateCreditsPerMp: number;
  editCreditsPerMp: number;
  freeMonthlyCredits: number;
}

/** Admin-only form: the kill switch, the price per megapixel and the per-account limits. */
export function ImageSettingsForm({ values, csrfToken }: { values: ImageSettingsValues; csrfToken: string }) {
  const [enabled, setEnabled] = useState(values.enabled);
  const [maxImages, setMaxImages] = useState(String(values.maxImages));
  const [rate, setRate] = useState(String(values.ratePerMinute));
  const [workerWait, setWorkerWait] = useState(String(values.workerWaitSeconds));
  const [generate, setGenerate] = useState(String(values.generateCreditsPerMp));
  const [edit, setEdit] = useState(String(values.editCreditsPerMp));
  const [free, setFree] = useState(String(values.freeMonthlyCredits));
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();

  const save = async () => {
    if (!reason.trim()) {
      setError("A reason is required; it is written to the append-only audit log.");
      return;
    }
    setBusy(true);
    setError(undefined);
    setMessage(undefined);
    const pairs: Array<[string, unknown]> = [
      ["generation.enabled", enabled],
      ["generation.max_images_per_call", Number(maxImages)],
      ["generation.rate_per_minute", Number(rate)],
      ["generation.worker_wait_seconds", Number(workerWait)],
      ["pricing.qwen-image.credits_per_mp", Number(generate)],
      ["pricing.qwen-edit.credits_per_mp", Number(edit)],
      ["free_monthly_credits", Number(free)],
    ];
    try {
      for (const [key, value] of pairs) {
        const response = await fetch("/api/v1/admin/settings", {
          method: "PATCH",
          headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
          body: JSON.stringify({ key, value, reason }),
        });
        if (!response.ok) throw new Error(`Could not update ${key}.`);
      }
      setMessage("Saved. The next request uses these values.");
      window.setTimeout(() => window.location.reload(), 800);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Save failed.");
    } finally {
      setBusy(false);
    }
  };

  const numberField = (label: string, hint: string, value: string, set: (next: string) => void, min = 0) => (
    <Field label={label} hint={hint}>
      {(props) => (
        <TextInput {...props} type="number" min={min} value={value} onChange={(event) => set(event.target.value)} />
      )}
    </Field>
  );

  return (
    <div className="w-card">
      <Checkbox
        label="Generation is on (turn off to refuse every generate and edit call)"
        checked={enabled}
        onChange={(event) => setEnabled(event.target.checked)}
      />
      {numberField(
        "Credits per megapixel: text to image",
        "Each started megapixel is charged. 1 credit is 1 US cent.",
        generate,
        setGenerate,
        1,
      )}
      {numberField("Credits per megapixel: edit with references", "Edit costs fal 50% more.", edit, setEdit, 1)}
      {numberField("Most images per call", "1 to 4.", maxImages, setMaxImages, 1)}
      {numberField("Image calls per account per minute", "Applies to generate and edit.", rate, setRate, 1)}
      {numberField(
        "Seconds a job waits for a worker",
        "After this the job goes to fal.ai. 1 to 600.",
        workerWait,
        setWorkerWait,
        1,
      )}
      {numberField("Free credits per account per month", "New wallets and monthly resets.", free, setFree)}
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
