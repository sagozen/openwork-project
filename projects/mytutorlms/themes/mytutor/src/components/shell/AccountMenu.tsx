import { useEffect, useId, useRef, useState } from "react";
import { Icon, type IconName } from "@mytutor/plugin-mytutor-lms/ui";
import { translator, type MessageKey, type UiLocale } from "../../i18n";
import { applyScheme, currentScheme, type Scheme } from "../../lib/scheme";
import { authRequest, studentRequest } from "../../lib/student-client";

/** Fired before signing out; the classroom cancels it to protect drafts. */
export const SIGN_OUT_EVENT = "mytutor:sign-out";

const SCHEMES: Array<{ value: Scheme; icon: IconName }> = [
  { value: "auto", icon: "monitor" },
  { value: "light", icon: "sun" },
  { value: "dark", icon: "moon" },
];

export default function AccountMenu({
  locale,
  session,
}: {
  locale: UiLocale;
  session: "account" | "invitation" | null;
}) {
  const t = translator(locale);
  const id = useId();
  const [open, setOpen] = useState(false);
  const [scheme, setScheme] = useState<Scheme>("auto");
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  useEffect(() => setScheme(currentScheme()), []);
  useEffect(() => {
    if (!open) return;
    function outside(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    function escape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setOpen(false);
      toggle.current?.focus();
    }
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  async function signOut() {
    const proceed = window.dispatchEvent(
      new CustomEvent(SIGN_OUT_EVENT, { cancelable: true }),
    );
    setOpen(false);
    if (!proceed) return;
    setPending(true);
    setFailed(false);
    try {
      if (session === "account") await authRequest("logout");
      else await studentRequest("logout");
      window.location.replace(session === "account" ? "/sign-in" : "/join");
    } catch {
      // Never pretend a session ended when it did not.
      setFailed(true);
      setPending(false);
      setOpen(true);
    }
  }
  return (
    <div className="account-menu" ref={root}>
      <button
        ref={toggle}
        type="button"
        className="account-menu-toggle"
        aria-expanded={open}
        aria-controls={`${id}-menu`}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name={session ? "user" : "settings"} />
        <span className="account-menu-label">
          {session ? t("shell.account") : t("shell.display")}
        </span>
        <Icon name="chevron-down" size={16} className="account-menu-chevron" />
      </button>
      <div id={`${id}-menu`} className="account-menu-panel" hidden={!open}>
        {session && (
          <a href="/learn">
            <Icon name="layout-grid" />
            {t("shell.myLearning")}
          </a>
        )}
        {session === "account" && (
          <a href="/account">
            <Icon name="user" />
            {t("shell.accountSettings")}
          </a>
        )}
        {!session && (
          <a href="/sign-in">
            <Icon name="arrow-right" />
            {t("shell.signIn")}
          </a>
        )}
        <fieldset>
          <legend>{t("shell.scheme")}</legend>
          {SCHEMES.map((option) => (
            <label key={option.value}>
              <input
                type="radio"
                name={`${id}-scheme`}
                value={option.value}
                checked={scheme === option.value}
                onChange={() => {
                  applyScheme(option.value);
                  setScheme(option.value);
                }}
              />
              <Icon name={option.icon} />
              {t(`shell.scheme.${option.value}` as MessageKey)}
            </label>
          ))}
        </fieldset>
        {session && (
          <button
            type="button"
            disabled={pending}
            onClick={() => void signOut()}
          >
            <Icon name="log-out" />
            {pending ? t("shell.signingOut") : t("shell.signOut")}
          </button>
        )}
        {failed && (
          <p className="account-menu-error" role="alert">
            {t("shell.signOutFailed")}
          </p>
        )}
      </div>
    </div>
  );
}
