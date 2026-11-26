import type {
  Dashboard,
  DashboardCourse,
  OpenCourseCard,
} from "@mytutor/plugin-mytutor-lms/model";
import type { MessageKey, Translate, UiLocale } from "../../i18n";
import { formatDate, formatDaysLeft } from "../../lib/format";
import {
  Button,
  EmptyState,
  Icon,
  InlineAlert,
  ProgressMeter,
  StatusPill,
} from "../ui";

const isOpen = (course: DashboardCourse) =>
  course.access.status === "active" || course.access.status === "ending_soon";

const classroomHref = (course: DashboardCourse) =>
  `/learn/${encodeURIComponent(course.courseId)}${
    course.nextLessonId
      ? `?lesson=${encodeURIComponent(course.nextLessonId)}`
      : ""
  }`;

/** Access status as text plus icon; never colour alone. */
export function EntitlementBadge({
  t,
  locale,
  access,
}: {
  t: Translate;
  locale: UiLocale;
  access: DashboardCourse["access"];
}) {
  const tone = {
    active: "success",
    ending_soon: "warning",
    ended: "neutral",
    revoked: "neutral",
  } as const;
  return (
    <StatusPill tone={tone[access.status]}>
      {access.expiresAt && access.status !== "revoked"
        ? t(`dashboard.access.${access.status}.until` as MessageKey, {
            date: formatDate(access.expiresAt, locale),
          })
        : t(`dashboard.access.${access.status}` as MessageKey)}
    </StatusPill>
  );
}

/** Warns once, at the top, about every course whose access ends soon. */
export function AccessExpiryBanner({
  t,
  locale,
  courses,
}: {
  t: Translate;
  locale: UiLocale;
  courses: DashboardCourse[];
}) {
  const ending = courses.filter(
    (course) =>
      course.access.status === "ending_soon" && course.access.expiresAt,
  );
  if (!ending.length) return null;
  return (
    <InlineAlert tone="warning" title={t("dashboard.ending.title")}>
      <ul className="plain-list">
        {ending.map((course) => (
          <li key={course.courseId}>
            {t("dashboard.ending.item", {
              course: course.title,
              date: formatDate(course.access.expiresAt!, locale),
              left: formatDaysLeft(course.access.expiresAt!, locale),
            })}
          </li>
        ))}
      </ul>
    </InlineAlert>
  );
}

/** The course to pick up again: the most recent open course with a next lesson. */
export function ResumeCard({
  t,
  course,
}: {
  t: Translate;
  course: DashboardCourse;
}) {
  return (
    <section className="resume-card" aria-labelledby="resume-heading">
      <p className="eyebrow">{t("dashboard.resume.eyebrow")}</p>
      <h2 id="resume-heading">{course.title}</h2>
      <ProgressMeter
        value={course.completedCount}
        max={course.lessonCount}
        label={t("dashboard.progress", {
          done: course.completedCount,
          total: course.lessonCount,
        })}
      />
      <a className="button" href={classroomHref(course)}>
        {t("dashboard.resume.action")}
        <Icon name="arrow-right" size={18} />
      </a>
    </section>
  );
}

export function CourseProgressCard({
  t,
  locale,
  course,
}: {
  t: Translate;
  locale: UiLocale;
  course: DashboardCourse;
}) {
  const open = isOpen(course);
  return (
    <article className="course-card dashboard-course">
      <div className="course-card-body">
        <EntitlementBadge t={t} locale={locale} access={course.access} />
        <h3>{course.title}</h3>
        {course.summary && <p>{course.summary}</p>}
        <ProgressMeter
          value={course.completedCount}
          max={course.lessonCount}
          label={t("dashboard.progress", {
            done: course.completedCount,
            total: course.lessonCount,
          })}
        />
        {open ? (
          <a className="button secondary" href={classroomHref(course)}>
            {course.completedCount
              ? t("dashboard.continue")
              : t("dashboard.start")}
            <Icon name="arrow-right" size={18} />
          </a>
        ) : (
          <p className="muted">{t("dashboard.closedNote")}</p>
        )}
      </div>
    </article>
  );
}

/** Published open courses the student has not started, each with "Start learning". */
export function OpenCourses({
  t,
  courses,
  starting,
  error,
  onStart,
}: {
  t: Translate;
  courses: OpenCourseCard[];
  starting: string | null;
  error: string;
  onStart: (courseId: string) => void;
}) {
  if (!courses.length) return null;
  return (
    <section aria-labelledby="open-courses-heading">
      <h2 id="open-courses-heading" className="dashboard-subhead">
        {t("dashboard.open.title")}
      </h2>
      {error && <InlineAlert tone="danger">{error}</InlineAlert>}
      <div className="course-grid">
        {courses.map((course) => (
          <article
            key={course.courseId}
            className="course-card dashboard-course"
          >
            <div className="course-card-body">
              <StatusPill tone="success">
                {t("dashboard.open.badge")}
              </StatusPill>
              <h3>{course.title}</h3>
              {course.summary && <p>{course.summary}</p>}
              <p className="muted">
                {course.instructor} ·{" "}
                {t("dashboard.open.lessons", { count: course.lessonCount })}
              </p>
              <Button
                iconEnd="arrow-right"
                busy={starting === course.courseId}
                busyLabel={t("openCourse.starting")}
                disabled={starting !== null}
                onClick={() => onStart(course.courseId)}
              >
                {t("openCourse.start")}
              </Button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

export default function StudentDashboard({
  t,
  locale,
  data,
  starting = null,
  startError = "",
  onStart = () => {},
}: {
  t: Translate;
  locale: UiLocale;
  data: Dashboard;
  starting?: string | null;
  startError?: string;
  onStart?: (courseId: string) => void;
}) {
  const openCourses = data.openCourses ?? [];
  const resume = data.courses
    .filter((course) => isOpen(course) && course.nextLessonId)
    .sort((a, b) =>
      (b.lastActiveAt ?? "").localeCompare(a.lastActiveAt ?? ""),
    )[0];
  return (
    <div className="container section student-dashboard">
      <div className="section-heading">
        <div>
          <p className="eyebrow">{t("dashboard.eyebrow")}</p>
          <h1>{t("dashboard.welcome", { name: data.student.name })}</h1>
        </div>
      </div>
      <AccessExpiryBanner t={t} locale={locale} courses={data.courses} />
      {data.courses.length === 0 ? (
        openCourses.length > 0 ? null : (
          <EmptyState
            title={t("dashboard.empty.title")}
            action={
              <a className="button secondary" href="/join">
                {t("dashboard.empty.action")}
              </a>
            }
          >
            <p>{t("dashboard.empty.body")}</p>
          </EmptyState>
        )
      ) : (
        <>
          {resume && <ResumeCard t={t} course={resume} />}
          <h2 className="dashboard-subhead">{t("dashboard.courses")}</h2>
          <div className="course-grid">
            {data.courses.map((course) => (
              <CourseProgressCard
                key={course.courseId}
                t={t}
                locale={locale}
                course={course}
              />
            ))}
          </div>
        </>
      )}
      <OpenCourses
        t={t}
        courses={openCourses}
        starting={starting}
        error={startError}
        onStart={onStart}
      />
    </div>
  );
}
