import type { StudentLiveSession } from "@mytutor/plugin-mytutor-lms/model";

// Live session timing and calendar exports, computed in the browser. Times
// are UTC instants; each viewer formats them in their own time zone.

const MINUTE = 60 * 1000;
/** "Join Zoom" opens this long before the start and stays open until the end. */
export const JOIN_OPENS_BEFORE_MS = 15 * MINUTE;

export type SessionPhase = "upcoming" | "joinable" | "ended";

export function sessionWindow(session: StudentLiveSession) {
  const start = Date.parse(session.startsAt);
  return { start, end: start + session.durationMinutes * MINUTE };
}

export function sessionPhase(
  session: StudentLiveSession,
  now: number,
): SessionPhase {
  const { start, end } = sessionWindow(session);
  if (now >= end) return "ended";
  return now >= start - JOIN_OPENS_BEFORE_MS ? "joinable" : "upcoming";
}

/** 20261126T093000Z */
export function icsTime(value: number): string {
  return new Date(value)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

/** RFC 5545 TEXT escaping: backslash, semicolon, comma and line breaks. */
export function escapeIcsText(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

/** Folds a content line at 75 octets (RFC 5545 section 3.1) without splitting a character. */
export function foldIcsLine(line: string): string {
  const encoder = new TextEncoder();
  const lines: string[] = [];
  let current = "";
  let size = 0;
  for (const char of line) {
    const bytes = encoder.encode(char).byteLength;
    const limit = lines.length === 0 ? 75 : 74;
    if (size + bytes > limit) {
      lines.push(current);
      current = "";
      size = 0;
    }
    current += char;
    size += bytes;
  }
  lines.push(current);
  return lines.join("\r\n ");
}

export interface CalendarLabels {
  join: string;
  passcode: string;
}

/** Notes, then the join link and passcode, as plain text. */
export function sessionDescription(
  session: StudentLiveSession,
  labels: CalendarLabels,
): string {
  return [
    session.notes.trim(),
    `${labels.join}: ${session.joinUrl}`,
    session.passcode ? `${labels.passcode}: ${session.passcode}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** A single-event iCalendar file with UTC times, the join link in LOCATION and DESCRIPTION. */
export function buildIcs(
  session: StudentLiveSession,
  options: { host: string; labels: CalendarLabels; now?: number },
): string {
  const { start, end } = sessionWindow(session);
  const host = options.host.replace(/[^A-Za-z0-9.-]/g, "") || "mytutor";
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//MyTutor LMS//Live sessions//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${session.id.replace(/[^A-Za-z0-9-]/g, "")}@${host}`,
    `DTSTAMP:${icsTime(options.now ?? Date.now())}`,
    `DTSTART:${icsTime(start)}`,
    `DTEND:${icsTime(end)}`,
    `SUMMARY:${escapeIcsText(session.title)}`,
    `DESCRIPTION:${escapeIcsText(sessionDescription(session, options.labels))}`,
    `LOCATION:${escapeIcsText(session.joinUrl)}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return `${lines.map(foldIcsLine).join("\r\n")}\r\n`;
}

/** Google Calendar "add event" link with UTC times. */
export function googleCalendarUrl(
  session: StudentLiveSession,
  labels: CalendarLabels,
): string {
  const { start, end } = sessionWindow(session);
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: session.title,
    dates: `${icsTime(start)}/${icsTime(end)}`,
    details: sessionDescription(session, labels),
    location: session.joinUrl,
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

/** A file name for the .ics download: ASCII letters, digits and dashes. */
export function icsFileName(session: StudentLiveSession): string {
  const slug = session.title
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${slug || "live-session"}.ics`;
}
