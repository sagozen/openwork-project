// The UX telemetry contract (phase 06, section 5.3), shared by the browser
// client and the /api/events route. Properties are identifiers, counts and
// fixed codes only: never names, emails, free text or submitted work.

export const EVENT_PROPS = {
  catalog_viewed: [],
  course_viewed: ["courseId"],
  preview_lesson_started: ["courseId", "lessonId"],
  sign_in_requested: ["method"],
  sign_in_completed: ["method"],
  sign_in_failed: ["method", "reason"],
  first_lesson_opened: ["courseId", "msSinceEntitlement"],
  lesson_opened: ["courseId", "lessonId"],
  lesson_completed: ["courseId", "lessonId"],
  lesson_uncompleted: ["courseId", "lessonId"],
  video_play_started: ["lessonId"],
  video_error: ["lessonId", "code"],
  assignment_submitted: ["courseId", "lessonId", "attempt"],
  locale_switched: ["from", "to"],
  ui_error_shown: ["componentId", "code"],
  grading_opened: [],
  grading_saved: ["msOpenToSave"],
} as const satisfies Record<string, readonly string[]>;

export type EventName = keyof typeof EVENT_PROPS;
export type EventProps = Record<string, string | number | boolean>;

export interface EventEnvelope {
  event: EventName;
  locale: string;
  device: "phone" | "tablet" | "desktop";
  route: string;
  ts: number;
  sessionId: string;
  props: EventProps;
}

const TOKEN = /^[A-Za-z0-9_.:-]{1,80}$/;

/** Returns the envelope if it matches the contract exactly, otherwise null. */
export function validEnvelope(value: unknown): EventEnvelope | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const allowed = EVENT_PROPS[item.event as EventName] as
    | readonly string[]
    | undefined;
  if (!allowed) return null;
  if (
    !["vi", "en", "es"].includes(item.locale as string) ||
    !["phone", "tablet", "desktop"].includes(item.device as string) ||
    typeof item.route !== "string" ||
    !/^\/[A-Za-z0-9/_-]{0,200}$/.test(item.route) ||
    typeof item.ts !== "number" ||
    !Number.isFinite(item.ts) ||
    typeof item.sessionId !== "string" ||
    !/^[a-f0-9]{32}$/.test(item.sessionId) ||
    !item.props ||
    typeof item.props !== "object"
  )
    return null;
  const props = item.props as Record<string, unknown>;
  for (const [key, prop] of Object.entries(props)) {
    if (!allowed.includes(key)) return null;
    const ok =
      typeof prop === "boolean" ||
      (typeof prop === "number" && Number.isFinite(prop)) ||
      (typeof prop === "string" && TOKEN.test(prop));
    if (!ok) return null;
  }
  return item as unknown as EventEnvelope;
}
