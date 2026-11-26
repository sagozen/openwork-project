import { useId } from "react";
import { Icon } from "@mytutor/plugin-mytutor-lms/ui";
import { LOCALE_COOKIE, translator, type UiLocale } from "../../i18n";
import { track } from "../../lib/analytics";
import { studentRequest } from "../../lib/student-client";

/**
 * Changes the interface language for this browser, keeps the current page,
 * and saves the choice to the profile when a student account is signed in.
 */
export default function LocaleSwitcher({
  locale,
  options,
  session,
}: {
  locale: UiLocale;
  options: Array<{ value: UiLocale; label: string }>;
  session: "account" | "invitation" | null;
}) {
  const t = translator(locale);
  const id = useId();
  async function choose(value: UiLocale) {
    track("locale_switched", { from: locale, to: value }, locale);
    const secure = window.location.protocol === "https:" ? "; Secure" : "";
    document.cookie = `${LOCALE_COOKIE}=${value}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
    if (session === "account") {
      // Best effort: the cookie already carries the choice for this browser.
      const me = await studentRequest<{ student: { name: string } }>(
        "me",
      ).catch(() => null);
      if (me)
        await studentRequest("me-update", {
          name: me.student.name,
          locale: value,
        }).catch(() => undefined);
    }
    window.location.reload();
  }
  return (
    <label className="locale-switcher" htmlFor={id}>
      <Icon name="globe" />
      <span className="mt-visually-hidden">{t("shell.language")}</span>
      <select
        id={id}
        value={locale}
        onChange={(event) => void choose(event.target.value as UiLocale)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value} lang={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
