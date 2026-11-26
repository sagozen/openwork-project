import { useEffect, useState, type SubmitEvent } from "react";
import type { Locale, StudentProfile } from "@mytutor/plugin-mytutor-lms/model";
import { isUiLocale, LOCALE_COOKIE, translator, type UiLocale } from "../i18n";
import { formatDateTime } from "../lib/format";
import {
  authRequest,
  LearningError,
  studentRequest,
} from "../lib/student-client";
import {
  Button,
  FormField,
  InlineAlert,
  Skeleton,
  StatusPill,
  useConfirmDialog,
} from "./ui";

interface Me {
  student: StudentProfile;
  sessions: {
    id: string;
    deviceLabel: string;
    lastSeenAt: string;
    current: boolean;
  }[];
}

const LANGUAGE_NAMES: Record<Locale, string> = {
  vi: "Tiếng Việt",
  en: "English",
  es: "Español",
};

export default function Account({
  locales,
  locale: uiLocale = "en",
}: {
  locales: Locale[];
  locale?: UiLocale;
}) {
  const t = translator(uiLocale);
  const [me, setMe] = useState<Me | null>(null);
  const [name, setName] = useState("");
  const [language, setLanguage] = useState<Locale>("vi");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [confirm, confirmDialog] = useConfirmDialog();
  const fail = (cause: unknown) => {
    if (cause instanceof LearningError && cause.code === "AUTH_REQUIRED")
      return window.location.replace("/sign-in");
    setError(
      cause instanceof LearningError ? cause.message : t("common.failed"),
    );
  };
  async function load() {
    try {
      const data = await studentRequest<Me>("me");
      setMe(data);
      setName(data.student.name);
      setLanguage(data.student.locale);
    } catch (cause) {
      fail(cause);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  async function save(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    setNotice("");
    try {
      await studentRequest("me-update", { name, locale: language });
      // The interface follows the profile language when it has one.
      if (isUiLocale(language) && language !== uiLocale) {
        const secure = window.location.protocol === "https:" ? "; Secure" : "";
        document.cookie = `${LOCALE_COOKIE}=${language}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
        window.location.reload();
        return;
      }
      setNotice(t("account.saved"));
      await load();
    } catch (cause) {
      fail(cause);
    } finally {
      setPending(false);
    }
  }
  if (!me)
    return (
      <div className="narrow">
        {error ? (
          <InlineAlert tone="danger">{error}</InlineAlert>
        ) : (
          <Skeleton lines={3} label={t("account.loading")} />
        )}
      </div>
    );
  return (
    <div className="narrow account-page">
      <p className="eyebrow">{t("account.eyebrow")}</p>
      <h1>{me.student.email}</h1>
      <div role="status" aria-live="polite">
        {notice && <InlineAlert tone="success">{notice}</InlineAlert>}
      </div>
      {error && <InlineAlert tone="danger">{error}</InlineAlert>}
      <form onSubmit={save} className="auth-form">
        <FormField label={t("account.name")}>
          {(control) => (
            <input
              {...control}
              required
              maxLength={160}
              autoComplete="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          )}
        </FormField>
        <FormField
          label={t("account.language")}
          hint={t("account.languageHint")}
        >
          {(control) => (
            <select
              {...control}
              value={language}
              onChange={(event) => setLanguage(event.target.value as Locale)}
            >
              {locales.map((item) => (
                <option key={item} value={item} lang={item}>
                  {LANGUAGE_NAMES[item]}
                </option>
              ))}
            </select>
          )}
        </FormField>
        <Button type="submit" busy={pending} busyLabel={t("common.saving")}>
          {t("common.save")}
        </Button>
      </form>
      <h2>{t("account.devices")}</h2>
      <ul className="device-list">
        {me.sessions.map((session) => (
          <li key={session.id}>
            <span>
              <strong>{session.deviceLabel}</strong>
              <small className="muted">
                {t("account.lastActive", {
                  time: formatDateTime(session.lastSeenAt, uiLocale),
                })}
              </small>
            </span>
            {session.current ? (
              <StatusPill tone="success">{t("account.thisDevice")}</StatusPill>
            ) : (
              <Button
                variant="secondary"
                small
                icon="log-out"
                onClick={async () => {
                  await studentRequest("me-revoke-session", {
                    sessionId: session.id,
                  }).catch(fail);
                  await load();
                }}
              >
                {t("account.signOutDevice")}
              </Button>
            )}
          </li>
        ))}
      </ul>
      <Button
        variant="secondary"
        icon="log-out"
        onClick={async () => {
          const go = await confirm({
            title: t("account.signOutAll.title"),
            body: <p>{t("account.signOutAll.body")}</p>,
            confirmLabel: t("account.signOutAll.confirm"),
            cancelLabel: t("common.cancel"),
            tone: "danger",
          });
          if (go === null) return;
          await authRequest("logout-all").catch(() => undefined);
          window.location.replace("/sign-in");
        }}
      >
        {t("account.signOutAll.confirm")}
      </Button>
      <p>
        <a className="text-link" href="/learn">
          {t("account.back")}
        </a>
      </p>
      {confirmDialog}
    </div>
  );
}
