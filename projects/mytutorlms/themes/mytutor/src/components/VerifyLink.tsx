import { useEffect, useState } from "react";
import { translator, type UiLocale } from "../i18n";
import { takeNext } from "../lib/safe-next";
import { authRequest, LearningError } from "../lib/student-client";
import AuthCard from "./auth/AuthCard";
import { Button, InlineAlert } from "./ui";

/** Completes sign-in from the emailed link; the token lives in the URL fragment and is removed at once. */
export default function VerifyLink({ locale = "en" }: { locale?: UiLocale }) {
  const t = translator(locale);
  const [token, setToken] = useState("");
  const [confirm, setConfirm] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(value: string, confirmed: boolean) {
    setPending(true);
    setError("");
    try {
      const data = await authRequest<{
        signedIn?: boolean;
        confirm?: { maskedEmail: string };
      }>("verify-link", {
        token: value,
        ...(confirmed ? { confirm: true } : {}),
      });
      if (data.confirm) {
        setConfirm(data.confirm.maskedEmail);
        setPending(false);
        return;
      }
      window.location.replace(takeNext());
    } catch (cause) {
      setError(
        cause instanceof LearningError ? cause.message : t("verify.failed"),
      );
      setPending(false);
    }
  }
  useEffect(() => {
    const match = /^#t=([a-f0-9]{64}\.[a-f0-9]{64})$/.exec(
      window.location.hash,
    );
    window.history.replaceState(null, "", window.location.pathname);
    if (!match) {
      setError(t("verify.incomplete"));
      return;
    }
    setToken(match[1]!);
    void submit(match[1]!, false);
  }, []);
  return (
    <AuthCard eyebrow={t("verify.eyebrow")} title={t("verify.title")}>
      {pending && <p role="status">{t("verify.checking")}</p>}
      {confirm && (
        <InlineAlert
          tone="warning"
          title={t("verify.otherBrowser.title")}
          action={
            <Button disabled={pending} onClick={() => void submit(token, true)}>
              {t("verify.otherBrowser.confirm")}
            </Button>
          }
        >
          <p>{t("verify.otherBrowser.body", { email: confirm })}</p>
        </InlineAlert>
      )}
      {error && (
        <InlineAlert
          tone="danger"
          action={
            <a className="text-link" href="/sign-in">
              {t("verify.requestNew")}
            </a>
          }
        >
          {error}
        </InlineAlert>
      )}
    </AuthCard>
  );
}
