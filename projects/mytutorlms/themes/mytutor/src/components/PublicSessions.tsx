import { useEffect, useState } from "react";
import type { PublicLiveSession } from "@mytutor/plugin-mytutor-lms/model";
import { translator, type UiLocale } from "../i18n";
import { formatDateTime, SITE_TIME_ZONE, viewerTimeZone } from "../lib/format";

/**
 * Upcoming live sessions on the public course page: titles and times only.
 * The server renders the site's time zone; the browser then switches to the
 * visitor's own.
 */
export default function PublicSessions({
  sessions,
  locale = "en",
}: {
  sessions: PublicLiveSession[];
  locale?: UiLocale;
}) {
  const t = translator(locale);
  const [zone, setZone] = useState(SITE_TIME_ZONE);
  useEffect(() => setZone(viewerTimeZone()), []);
  if (!sessions.length) return null;
  return (
    <section
      className="public-sessions"
      aria-labelledby="public-sessions-title"
      lang={locale}
    >
      <h2 id="public-sessions-title">{t("live.publicTitle")}</h2>
      <ul>
        {sessions.map((session) => (
          <li key={session.id}>
            <strong>{session.title}</strong>
            <span className="muted">
              <time dateTime={session.startsAt}>
                {formatDateTime(session.startsAt, locale, zone)}
              </time>{" "}
              · {t("classroom.minutes", { count: session.durationMinutes })}
            </span>
          </li>
        ))}
      </ul>
      <p className="muted">{t("live.publicNote")}</p>
    </section>
  );
}
