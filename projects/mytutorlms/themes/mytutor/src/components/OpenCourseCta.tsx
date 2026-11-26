import { useState } from "react";
import {
  translator,
  type MessageKey,
  type Translate,
  type UiLocale,
} from "../i18n";
import { LearningError, startOpenCourse } from "../lib/student-client";
import { Button, InlineAlert } from "./ui";

const JOIN_ERRORS: Record<string, MessageKey> = {
  NOT_OPEN: "openCourse.error.notOpen",
  ACCESS_ENDED: "openCourse.error.accessEnded",
  RATE_LIMITED: "openCourse.error.rateLimited",
};
/** A failed "Start learning" in the visitor's language, not the server's English. */
export function openCourseError(t: Translate, cause: unknown): string {
  const key =
    cause instanceof LearningError ? JOIN_ERRORS[cause.code] : undefined;
  if (key) return t(key);
  return cause instanceof LearningError && cause.code === "NETWORK"
    ? cause.message
    : t("openCourse.failed");
}

/**
 * The call to action of an open course page. Visitors sign in and come back
 * here; a signed-in student starts the course and lands in its classroom.
 * Where self sign-up is off, the copy says an existing account is needed.
 */
export default function OpenCourseCta({
  courseId,
  locale = "en",
  signedIn,
  selfSignup,
}: {
  courseId: string;
  locale?: UiLocale;
  signedIn: boolean;
  selfSignup: boolean;
}) {
  const t = translator(locale);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const returnTo = `/courses/${courseId}`;
  async function start() {
    setPending(true);
    setError("");
    try {
      await startOpenCourse(courseId, returnTo);
    } catch (cause) {
      setError(openCourseError(t, cause));
      setPending(false);
    }
  }
  return (
    <aside className="empty open-course-cta" lang={locale}>
      <h3>{t("openCourse.title")}</h3>
      <p>
        {signedIn
          ? t("openCourse.signedIn")
          : selfSignup
            ? t("openCourse.body")
            : t("openCourse.bodyAccountsOnly")}
      </p>
      {error && <InlineAlert tone="danger">{error}</InlineAlert>}
      <div className="actions">
        {signedIn ? (
          <Button
            iconEnd="arrow-right"
            busy={pending}
            busyLabel={t("openCourse.starting")}
            onClick={() => void start()}
          >
            {t("openCourse.start")}
          </Button>
        ) : (
          <a
            className="button"
            href={`/sign-in?next=${encodeURIComponent(returnTo)}`}
          >
            {t("openCourse.signIn")}
          </a>
        )}
      </div>
    </aside>
  );
}
