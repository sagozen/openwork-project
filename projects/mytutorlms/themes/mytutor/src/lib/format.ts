import type { Locale } from "@mytutor/plugin-mytutor-lms/model";

// Every date, number and price on student screens goes through these, so
// each locale gets its own conventions (21/10/2026 in VI, Oct 21, 2026 in EN).
export const SITE_TIME_ZONE = "Asia/Ho_Chi_Minh";

const TAGS: Record<Locale, string> = { vi: "vi-VN", en: "en-US", es: "es-ES" };
const tag = (locale: Locale) => TAGS[locale] ?? "en-US";

export function formatDate(
  value: number | string | Date,
  locale: Locale,
  timeZone = SITE_TIME_ZONE,
): string {
  return new Intl.DateTimeFormat(tag(locale), {
    day: locale === "en" ? "numeric" : "2-digit",
    month: locale === "vi" ? "2-digit" : "short",
    year: "numeric",
    timeZone,
  }).format(new Date(value));
}

export function formatDateTime(
  value: number | string | Date,
  locale: Locale,
  timeZone = SITE_TIME_ZONE,
): string {
  if (locale === "vi") {
    // Vietnamese reads date first: 21/10/2026 14:30 (GMT+7).
    const parts = new Intl.DateTimeFormat("vi-VN", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone,
      timeZoneName: "short",
    }).formatToParts(new Date(value));
    const part = (type: string) =>
      parts.find((item) => item.type === type)?.value ?? "";
    return `${formatDate(value, locale, timeZone)} ${part("hour")}:${part("minute")} (${part("timeZoneName")})`;
  }
  return new Intl.DateTimeFormat(tag(locale), {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: locale === "en",
    timeZone,
    timeZoneName: "short",
  }).format(new Date(value));
}

export function formatNumber(value: number, locale: Locale): string {
  return new Intl.NumberFormat(tag(locale)).format(value);
}

/** Prices show only in the offer's own currency, never converted. */
export function formatMoney(
  amount: number,
  currency: string,
  locale: Locale,
): string {
  return new Intl.NumberFormat(tag(locale), {
    style: "currency",
    currency,
  })
    .format(amount)
    .replace(/ /g, " ");
}

/** This browser's time zone, for times a student reads on their own device. */
export function viewerTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || SITE_TIME_ZONE;
  } catch {
    return SITE_TIME_ZONE;
  }
}

/** "sau 2 giờ nữa" / "in 2 hours": the nearest whole minute, hour or day. */
export function formatRelative(
  target: number,
  locale: Locale,
  now = Date.now(),
): string {
  const minutes = Math.max(1, Math.round((target - now) / 60_000));
  const format = new Intl.RelativeTimeFormat(tag(locale), { numeric: "auto" });
  if (minutes < 60) return format.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 48) return format.format(hours, "hour");
  return format.format(Math.round(hours / 24), "day");
}

/** "còn 5 ngày" / "5 days left" for a future instant, by whole days. */
export function formatDaysLeft(
  until: number | string | Date,
  locale: Locale,
  now = Date.now(),
): string {
  const days = Math.max(
    0,
    Math.ceil((new Date(until).getTime() - now) / 86_400_000),
  );
  const unit = new Intl.NumberFormat(tag(locale), {
    style: "unit",
    unit: "day",
    unitDisplay: "long",
  }).format(days);
  if (locale === "vi") return `còn ${unit}`;
  if (locale === "es") return `quedan ${unit}`;
  return `${unit} left`;
}
