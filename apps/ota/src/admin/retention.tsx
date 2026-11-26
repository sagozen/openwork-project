/**
 * Retention window: how long a build stays before it expires. The plan decides the longest window a
 * workspace may choose.
 */

import type { SyntheticEvent } from "react";
import { useEffect, useState } from "react";
import type { OtaRetention } from "../domain/types.js";
import { api, post } from "./client.js";
import { Failure, Section, useAsync } from "./shared.js";
import { Button, Input } from "./ui.js";

export function RetentionSection({ onChanged }: { onChanged: () => void }) {
  const view = useAsync<OtaRetention>((signal) => api.retention(signal), []);
  const [days, setDays] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (view.data) setDays(String(view.data.days));
  }, [view.data]);

  async function submit(event: SyntheticEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setNotice("");
    try {
      const saved = await post<OtaRetention>("retention-save", { days: Number(days) });
      setNotice(`Builds are now kept for ${saved.days} days.`);
      view.reload();
      onChanged();
    } catch (cause) {
      setError(cause);
    } finally {
      setPending(false);
    }
  }

  const current = view.data;
  const limit = current ? (current.planLimit < 0 ? "no limit" : `up to ${current.planLimit} days`) : "";

  return (
    <Section
      title="Retention"
      description="A build expires this many days after it was pushed, including the current one. Lowering your plan never shortens a window you already chose."
    >
      <Failure error={view.error} onRetry={view.reload} />
      {current ? (
        <form className="ota-token-form" onSubmit={(event) => void submit(event)}>
          <Input
            label={`Days to keep builds (your plan allows ${limit})`}
            required
            value={days}
            onChange={(event) => setDays(event.target.value)}
            maxLength={4}
          />
          <Button type="submit" disabled={pending || !/^\d+$/.test(days.trim()) || Number(days) < 1}>
            {pending ? "Saving…" : "Save retention"}
          </Button>
        </form>
      ) : null}
      <Failure error={error} />
      {notice === "" ? null : (
        <p className="ota-notice" role="status">
          {notice}
        </p>
      )}
    </Section>
  );
}
