import type { AdminSettings } from "@templatedesign/platform/admin";
import { Button, Checkbox, Field, InlineNotice, TextInput } from "@templatedesign/ui";
import { useState } from "react";

export function AdminSettingsForm({
  mode,
  settings,
  csrfToken,
}: {
  mode: "quotas" | "incidents";
  settings: AdminSettings;
  csrfToken: string;
}) {
  const [freeMonthly, setFreeMonthly] = useState(String(settings.freeMonthlyCredits));
  const [testDaily, setTestDaily] = useState(String(settings.testDailyCap));
  const [pauseAdmission, setPauseAdmission] = useState(settings.pauseAdmission);
  const [pausePreview, setPausePreview] = useState(settings.pausePreview);
  const [pauseCheckout, setPauseCheckout] = useState(settings.pauseCheckout);
  const [pauseWebhooks, setPauseWebhooks] = useState(settings.pauseWebhooks);
  const [adsEnabled, setAdsEnabled] = useState(settings.adsEnabled);
  const [incidentActive, setIncidentActive] = useState(settings.incidentActive);
  const [bannerEn, setBannerEn] = useState(settings.incidentBannerEn);
  const [bannerVi, setBannerVi] = useState(settings.incidentBannerVi);
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
    const pairs: Array<[string, unknown]> =
      mode === "quotas"
        ? [
            ["free_monthly_credits", Number(freeMonthly)],
            ["test_daily_cap", Number(testDaily)],
          ]
        : [
            ["pause.admission", pauseAdmission],
            ["pause.preview", pausePreview],
            ["pause.checkout", pauseCheckout],
            ["pause.webhooks", pauseWebhooks],
            ["ads.enabled", adsEnabled],
            ["incident.active", incidentActive],
            ["incident.banner_en", bannerEn],
            ["incident.banner_vi", bannerVi],
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
      setMessage("Saved. The next admission or page load uses these values.");
      window.setTimeout(() => window.location.reload(), 800);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Save failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="w-card">
      {mode === "quotas" ? (
        <>
          <Field
            label="Free credits per account per month"
            hint="Applies to new wallets and monthly resets. Overrides can be set per account."
          >
            {(props) => (
              <TextInput
                {...props}
                type="number"
                min={0}
                value={freeMonthly}
                onChange={(event) => setFreeMonthly(event.target.value)}
              />
            )}
          </Field>
          <Field
            label="Test-mode renders per key per day"
            hint="A tenant override wins over this global value until it expires."
          >
            {(props) => (
              <TextInput
                {...props}
                type="number"
                min={0}
                value={testDaily}
                onChange={(event) => setTestDaily(event.target.value)}
              />
            )}
          </Field>
        </>
      ) : (
        <>
          <Checkbox
            label="Pause all new job admission (downloads and shares stay available)"
            checked={pauseAdmission}
            onChange={(event) => setPauseAdmission(event.target.checked)}
          />
          <Checkbox
            label="Pause previews"
            checked={pausePreview}
            onChange={(event) => setPausePreview(event.target.checked)}
          />
          <Checkbox
            label="Pause checkout"
            checked={pauseCheckout}
            onChange={(event) => setPauseCheckout(event.target.checked)}
          />
          <Checkbox
            label="Pause webhook delivery (events remain recoverable by API)"
            checked={pauseWebhooks}
            onChange={(event) => setPauseWebhooks(event.target.checked)}
          />
          <Checkbox
            label="Enable public ads"
            checked={adsEnabled}
            onChange={(event) => setAdsEnabled(event.target.checked)}
          />
          <Checkbox
            label="Show the incident banner"
            checked={incidentActive}
            onChange={(event) => setIncidentActive(event.target.checked)}
          />
          <Field label="Banner text (English)">
            {(props) => (
              <TextInput
                {...props}
                value={bannerEn}
                onChange={(event) => setBannerEn(event.target.value)}
                maxLength={240}
              />
            )}
          </Field>
          <Field label="Banner text (Vietnamese)">
            {(props) => (
              <TextInput
                {...props}
                value={bannerVi}
                onChange={(event) => setBannerVi(event.target.value)}
                maxLength={240}
              />
            )}
          </Field>
        </>
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
