import { useEffect, useState, type SubmitEvent } from "react";
import { translator, type UiLocale } from "../i18n";
import { authRequest } from "../lib/student-client";
import AuthCard from "./auth/AuthCard";
import { Button, FormField, InlineAlert } from "./ui";

export default function Join({ locale = "en" }: { locale?: UiLocale }) {
  const t = translator(locale);
  const [token, setToken] = useState("");
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    function receiveInvitation() {
      const fragment = window.location.hash.slice(1);
      if (fragment) {
        window.history.replaceState(null, "", window.location.pathname);
        setToken(fragment);
        setError("");
      }
    }
    receiveInvitation();
    window.addEventListener("hashchange", receiveInvitation);
    return () => window.removeEventListener("hashchange", receiveInvitation);
  }, []);
  async function accept(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    try {
      let value = token || input.trim();
      if (value.includes("#")) {
        const link = new URL(value);
        if (link.origin !== window.location.origin || link.pathname !== "/join")
          throw new Error(t("join.wrongSite"));
        value = link.hash.slice(1);
      }
      // The invitation becomes an account for the invited email.
      const data = await authRequest<{
        courseId: string | null;
        signInRequired?: boolean;
      }>("exchange-invitation", { token: value });
      setToken("");
      setInput("");
      const course = data.courseId
        ? `/learn/${encodeURIComponent(data.courseId)}`
        : "/learn";
      // An account that already verified its email signs in by code, not by link.
      window.location.replace(
        data.signInRequired
          ? `/sign-in?next=${encodeURIComponent(course)}&invited=1`
          : course,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("join.failed"));
      setPending(false);
    }
  }
  return (
    <AuthCard
      eyebrow={t("join.eyebrow")}
      title={t("join.title")}
      intro={t("join.intro")}
      footer={
        <p>
          {t("join.footer")} <a href="/sign-in">{t("join.signIn")}</a>
        </p>
      }
    >
      {error && <InlineAlert tone="danger">{error}</InlineAlert>}
      <form onSubmit={accept} className="auth-form">
        {token ? (
          <InlineAlert tone="success">{t("join.ready")}</InlineAlert>
        ) : (
          <FormField label={t("join.link")} hint={t("join.linkHint")}>
            {(control) => (
              <input
                {...control}
                type="password"
                autoComplete="off"
                required
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder={t("join.placeholder")}
                maxLength={2048}
              />
            )}
          </FormField>
        )}
        <Button
          type="submit"
          iconEnd="arrow-right"
          busy={pending}
          busyLabel={t("join.opening")}
        >
          {t("join.accept")}
        </Button>
      </form>
    </AuthCard>
  );
}
