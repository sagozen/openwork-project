import { useEffect, useState } from "react";
import type { Dashboard as DashboardData } from "@mytutor/plugin-mytutor-lms/model";
import { translator, type UiLocale } from "../i18n";
import {
  LearningError,
  startOpenCourse,
  studentRequest,
} from "../lib/student-client";
import { openCourseError } from "./OpenCourseCta";
import StudentDashboard from "./learn/StudentDashboard";
import { InlineAlert, Skeleton } from "./ui";

/** Loads the signed-in student's courses; StudentDashboard draws them. */
export default function Dashboard({ locale = "en" }: { locale?: UiLocale }) {
  const t = translator(locale);
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState("");
  const [starting, setStarting] = useState<string | null>(null);
  const [startError, setStartError] = useState("");
  async function start(courseId: string) {
    setStarting(courseId);
    setStartError("");
    try {
      await startOpenCourse(courseId, "/learn");
    } catch (cause) {
      setStartError(openCourseError(t, cause));
      setStarting(null);
    }
  }
  useEffect(() => {
    studentRequest<DashboardData>("dashboard").then(
      setData,
      (cause: unknown) => {
        if (cause instanceof LearningError && cause.code === "AUTH_REQUIRED")
          window.location.replace("/sign-in");
        else
          setError(
            cause instanceof LearningError
              ? cause.message
              : t("dashboard.loadFailed"),
          );
      },
    );
  }, []);
  if (error)
    return (
      <div className="narrow">
        <InlineAlert
          tone="danger"
          action={
            <a className="text-link" href="/learn">
              {t("common.tryAgain")}
            </a>
          }
        >
          {error}
        </InlineAlert>
      </div>
    );
  if (!data)
    return (
      <div className="container section">
        <Skeleton lines={4} label={t("dashboard.loading")} />
      </div>
    );
  return (
    <StudentDashboard
      t={t}
      locale={locale}
      data={data}
      starting={starting}
      startError={startError}
      onStart={(courseId) => void start(courseId)}
    />
  );
}
