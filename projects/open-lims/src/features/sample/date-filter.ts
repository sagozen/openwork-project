import { DISPLAY_TIME_ZONE } from "@/lib/format/date-time";

export type SampleDatePreset = "all" | "today" | "yesterday" | "3days" | "7days" | "custom";
type QuickDatePreset = Exclude<SampleDatePreset, "all" | "custom">;

const DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: DISPLAY_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Inclusive calendar dates in Vietnam; 3/7 days include today. */
export function sampleDateRange(preset: QuickDatePreset, now = new Date()) {
  const parts = DATE_FORMATTER.formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)!.value;
  const end = new Date(`${part("year")}-${part("month")}-${part("day")}T00:00:00Z`);
  if (preset === "yesterday") end.setUTCDate(end.getUTCDate() - 1);
  const start = new Date(end);
  const days = preset === "3days" ? 3 : preset === "7days" ? 7 : 1;
  start.setUTCDate(start.getUTCDate() - days + 1);
  return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
}
