import { useState, type SubmitEvent } from "react";
import { translator, type UiLocale } from "../i18n";
import { authRequest, LearningError } from "../lib/student-client";
import { Button, FormField, InlineAlert, OtpInput } from "./ui";

/** Offered on 0.2 invitation sessions: move to an account that works on any device. */
export default function UpgradeBanner({
  locale = "en",
}: {
  locale?: UiLocale;
}) {
  const t = translator(locale);
  const [maskedEmail, setMaskedEmail] = useState("");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const fail = (cause: unknown) =>
    setError(
      cause instanceof LearningError ? cause.message : t("common.failed"),
    );
  async function start() {
    setPending(true);
    setError("");
    try {
      const data = await authRequest<{ maskedEmail: string }>("upgrade");
      setMaskedEmail(data.maskedEmail);
    } catch (cause) {
      fail(cause);
    } finally {
      setPending(false);
    }
  }
  async function verify(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    try {
      await authRequest("verify-code", { email: email.trim(), code });
      window.location.replace("/learn");
    } catch (cause) {
      fail(cause);
      setPending(false);
    }
  }
  return (
    <section className="upgrade-banner" aria-labelledby="upgrade-title">
      <InlineAlert
        tone="info"
        title={<span id="upgrade-title">{t("upgrade.title")}</span>}
      >
        <p>{t("upgrade.body")}</p>
        {error && <InlineAlert tone="danger">{error}</InlineAlert>}
        {!maskedEmail ? (
          <Button
            small
            busy={pending}
            busyLabel={t("signIn.sending")}
            onClick={() => void start()}
          >
            {t("upgrade.send")}
          </Button>
        ) : (
          <form onSubmit={verify} className="auth-form">
            <p>{t("upgrade.sent", { email: maskedEmail })}</p>
            <FormField label={t("signIn.email")}>
              {(control) => (
                <input
                  {...control}
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              )}
            </FormField>
            <FormField label={t("signIn.code")}>
              {(control) => (
                <OtpInput
                  {...control}
                  required
                  value={code}
                  onValue={setCode}
                />
              )}
            </FormField>
            <Button type="submit" small busy={pending}>
              {t("common.continue")}
            </Button>
          </form>
        )}
      </InlineAlert>
    </section>
  );
}
