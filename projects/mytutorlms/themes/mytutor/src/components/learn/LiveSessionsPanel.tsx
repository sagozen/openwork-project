import { useEffect, useState } from "react";
import type { StudentLiveSession } from "@mytutor/plugin-mytutor-lms/model";
import type { Translate, UiLocale } from "../../i18n";
import {
  buildIcs,
  googleCalendarUrl,
  icsFileName,
  JOIN_OPENS_BEFORE_MS,
  sessionPhase,
  sessionWindow,
  type CalendarLabels,
} from "../../lib/calendar";
import {
  formatDateTime,
  formatRelative,
  viewerTimeZone,
} from "../../lib/format";
import { Icon, StatusPill } from "../ui";

function downloadIcs(session: StudentLiveSession, labels: CalendarLabels) {
  const blob = new Blob(
    [buildIcs(session, { host: window.location.hostname, labels })],
    { type: "text/calendar;charset=utf-8" },
  );
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = icsFileName(session);
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Live classes of this course, in the viewer's own time zone. "Join Zoom"
 * opens 15 minutes before the start and closes at the end; the server only
 * sends these to students with access, and hides sessions two hours after
 * they end.
 */
export default function LiveSessionsPanel({
  t,
  locale,
  sessions,
}: {
  t: Translate;
  locale: UiLocale;
  sessions: StudentLiveSession[];
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  if (!sessions.length) return null;
  const zone = viewerTimeZone();
  const labels: CalendarLabels = {
    join: t("live.join"),
    passcode: t("live.passcode"),
  };
  return (
    <section className="live-sessions" aria-labelledby="live-sessions-heading">
      <h2 id="live-sessions-heading">{t("live.title")}</h2>
      <p className="muted">{t("live.timeZone", { zone })}</p>
      <ul>
        {sessions.map((session) => {
          const phase = sessionPhase(session, now);
          const { start } = sessionWindow(session);
          return (
            <li key={session.id} className="live-session">
              <div className="live-session-head">
                <StatusPill
                  tone={
                    phase === "joinable"
                      ? "success"
                      : phase === "ended"
                        ? "neutral"
                        : "info"
                  }
                >
                  {phase === "ended"
                    ? t("live.ended")
                    : phase === "joinable"
                      ? now >= start
                        ? t("live.inProgress")
                        : t("live.startingSoon")
                      : t("live.upcoming")}
                </StatusPill>
                <h3>{session.title}</h3>
                <p>
                  <Icon name="calendar" size={16} />{" "}
                  <time dateTime={session.startsAt}>
                    {formatDateTime(session.startsAt, locale, zone)}
                  </time>{" "}
                  · {t("classroom.minutes", { count: session.durationMinutes })}
                </p>
              </div>
              {session.notes && <p className="prose">{session.notes}</p>}
              {session.passcode && phase !== "ended" && (
                <p>
                  {t("live.passcode")}: <code>{session.passcode}</code>
                </p>
              )}
              {phase !== "ended" && (
                <div className="actions">
                  {phase === "joinable" ? (
                    <a
                      className="button"
                      href={session.joinUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {t("live.join")}
                      <Icon name="external-link" size={16} />
                      <span className="mt-visually-hidden">
                        {t("live.newTab")}
                      </span>
                    </a>
                  ) : (
                    <p className="live-countdown">
                      <Icon name="clock" size={16} />{" "}
                      {t("live.opensIn", {
                        relative: formatRelative(
                          start - JOIN_OPENS_BEFORE_MS,
                          locale,
                          now,
                        ),
                      })}
                    </p>
                  )}
                  <a
                    className="button secondary small"
                    href={googleCalendarUrl(session, labels)}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {t("live.googleCalendar")}
                    <span className="mt-visually-hidden">
                      {t("live.newTab")}
                    </span>
                  </a>
                  <button
                    type="button"
                    className="button secondary small"
                    onClick={() => downloadIcs(session, labels)}
                  >
                    {t("live.ics")}
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
