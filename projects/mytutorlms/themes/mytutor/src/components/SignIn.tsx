import { useState, type SubmitEvent } from "react";
import { translator, type UiLocale } from "../i18n";
import { track } from "../lib/analytics";
import { rememberNext, safeNext } from "../lib/safe-next";
import { authRequest, LearningError } from "../lib/student-client";
import AuthCard from "./auth/AuthCard";
import { Button, FormField, InlineAlert, OtpInput } from "./ui";

/** Email, then a 6-digit code (or the link in the same email). */
export default function SignIn({
  next = "/learn",
  locale = "en",
  invited = false,
}: {
  next?: string;
  locale?: UiLocale;
  invited?: boolean;
}) {
  const t = translator(locale);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"email" | "code">("email");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const message = (cause: unknown) =>
    cause instanceof LearningError ? cause.message : t("common.failed");

  async function send(event?: SubmitEvent<HTMLFormElement>) {
    event?.preventDefault();
    setPending(true);
    setError("");
    try {
      await authRequest("start", { email: email.trim(), locale });
      // The emailed link may open in another tab of this browser; it returns
      // to the same page for the next 30 minutes.
      rememberNext(next);
      track("sign_in_requested", { method: "email_code" }, locale);
      setStep("code");
    } catch (cause) {
      setError(message(cause));
    } finally {
      setPending(false);
    }
  }
  async function verify(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    try {
      await authRequest("verify-code", {
        email: email.trim(),
        code: code.trim(),
      });
      track("sign_in_completed", { method: "email_code" }, locale);
      window.location.replace(safeNext(next));
    } catch (cause) {
      track(
        "sign_in_failed",
        {
          method: "email_code",
          reason: cause instanceof LearningError ? cause.code : "UNKNOWN",
        },
        locale,
      );
      setError(message(cause));
      setPending(false);
    }
  }
  return (
    <AuthCard
      eyebrow={t("signIn.eyebrow")}
      title={step === "email" ? t("signIn.title") : t("signIn.codeTitle")}
      intro={step === "email" ? t("signIn.intro") : undefined}
      footer={
        <p>
          {t("signIn.invitation")}{" "}
          <a href="/join">{t("signIn.openInvitation")}</a>
        </p>
      }
    >
      {invited && step === "email" && (
        <InlineAlert tone="info">{t("signIn.invited")}</InlineAlert>
      )}
      {error && <InlineAlert tone="danger">{error}</InlineAlert>}
      {step === "email" ? (
        <form onSubmit={send} className="auth-form">
          <FormField label={t("signIn.email")}>
            {(control) => (
              <input
                {...control}
                type="email"
                autoComplete="email"
                inputMode="email"
                required
                maxLength={254}
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            )}
          </FormField>
          <Button
            type="submit"
            iconEnd="arrow-right"
            busy={pending}
            busyLabel={t("signIn.sending")}
          >
            {t("signIn.send")}
          </Button>
        </form>
      ) : (
        <form onSubmit={verify} className="auth-form">
          <InlineAlert tone="info">
            {t("signIn.sent", { email: email.trim() })}
          </InlineAlert>
          <FormField label={t("signIn.code")} hint={t("signIn.codeHint")}>
            {(control) => (
              <OtpInput {...control} required value={code} onValue={setCode} />
            )}
          </FormField>
          <Button
            type="submit"
            iconEnd="arrow-right"
            busy={pending}
            busyLabel={t("signIn.checking")}
          >
            {t("signIn.submit")}
          </Button>
          <p className="auth-links">
            <button
              type="button"
              className="text-link"
              disabled={pending}
              onClick={() => void send()}
            >
              {t("signIn.resend")}
            </button>
            <button
              type="button"
              className="text-link"
              disabled={pending}
              onClick={() => {
                setStep("email");
                setCode("");
                setError("");
              }}
            >
              {t("signIn.otherEmail")}
            </button>
          </p>
        </form>
      )}
    </AuthCard>
  );
}
