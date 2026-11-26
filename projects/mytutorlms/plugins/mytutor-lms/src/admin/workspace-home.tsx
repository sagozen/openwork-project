import type { CourseRecord } from "../model.js";
import { EmptyState, Icon, StatusPill } from "../ui/index.js";
import { routeHash, type Route } from "./routes.js";
import { Failure } from "./shared.js";

/**
 * The workspace start page and the course list. Every action is a link, so
 * screens open in the URL and Back returns here.
 */
export function WorkspaceHome({
  view,
  courses,
  loading,
  error,
  can,
  onRefresh,
  headingRef,
}: {
  view: "home" | "courses" | "grading";
  courses: CourseRecord[] | null;
  loading: boolean;
  error: unknown;
  can: (permission: string) => boolean;
  onRefresh: () => void;
  headingRef: React.Ref<HTMLHeadingElement>;
}) {
  const href = (route: Route) => routeHash(route);
  const stale = Boolean(error);
  const title =
    view === "grading"
      ? "Grading"
      : view === "courses"
        ? "Courses"
        : "Course catalog";
  return (
    <section className="mt-panel" aria-labelledby="mt-courses-heading">
      <div className="mt-section-heading">
        <div>
          <p className="mt-eyebrow">
            {view === "grading" ? "Review student work" : "Courses"}
          </p>
          <h2 id="mt-courses-heading" ref={headingRef} tabIndex={-1}>
            {title}
          </h2>
          <p className="mt-muted">
            {view === "grading"
              ? "Choose a course to review submitted assignments."
              : "Create lessons, publish courses, and manage student enrollments."}
          </p>
        </div>
        <div className="mt-actions">
          <button type="button" disabled={loading} onClick={onRefresh}>
            Refresh courses
          </button>
          {view !== "grading" && can("course.create") && (
            <a
              className="mt-button mt-primary"
              href={href({ view: "editor", id: "new" })}
            >
              New course
            </a>
          )}
        </div>
      </div>
      {loading && <p role="status">Loading your courses…</p>}
      <Failure error={error} retry={onRefresh} retryLabel="Retry course list" />
      {stale && courses && (
        <p className="mt-warning">
          These are the last loaded courses. Refresh successfully before
          editing, managing students, or reviewing assignments.
        </p>
      )}
      {!loading && !error && courses?.length === 0 && (
        <EmptyState
          icon="file"
          headingLevel={3}
          title="No courses created yet"
          action={
            can("course.create") && (
              <a
                className="mt-button mt-primary"
                href={href({ view: "editor", id: "new" })}
              >
                Create your first course
              </a>
            )
          }
        >
          <p>
            Start with a title and a lesson. Save privately as a draft, then
            publish and invite students when you are ready.
          </p>
        </EmptyState>
      )}
      {courses && courses.length > 0 && (
        <div className="mt-course-grid" aria-busy={loading}>
          {courses.map((record) => {
            const name = record.value.title || "Untitled course";
            const published = record.value.status === "published";
            const links = [
              {
                route: { view: "editor", id: record.id } as Route,
                label: "Edit course",
                aria: `Edit ${name}`,
                show: view !== "grading",
              },
              {
                route: { view: "roster", id: record.id } as Route,
                label: "Students & invitations",
                aria: `Manage students for ${name}`,
                show: view !== "grading",
              },
              {
                route: { view: "assignments", id: record.id } as Route,
                label: "Assignments",
                aria: `Review assignments for ${name}`,
                show: true,
              },
              {
                route: { view: "media", id: record.id } as Route,
                label: "Lesson videos",
                aria: `Manage lesson videos for ${name}`,
                show: view !== "grading",
              },
              {
                route: { view: "live", id: record.id } as Route,
                label: "Live sessions",
                aria: `Manage live sessions for ${name}`,
                show: view !== "grading",
              },
            ];
            return (
              <article key={record.id} className="mt-course-card">
                <div className="mt-card-heading">
                  <StatusPill
                    tone={published ? "success" : "neutral"}
                    icon={published ? "circle-check" : "file"}
                  >
                    {published ? "Published" : "Draft"}
                  </StatusPill>
                  <span className="mt-muted">
                    {record.value.lessons.length}{" "}
                    {record.value.lessons.length === 1 ? "lesson" : "lessons"}
                  </span>
                </div>
                <h3>{name}</h3>
                <p>
                  {record.value.summary ||
                    "Add a summary to introduce this course."}
                </p>
                <p className="mt-muted">
                  {record.value.instructor
                    ? `Instructor: ${record.value.instructor}`
                    : "Instructor not set"}
                </p>
                <div className="mt-actions">
                  {links
                    .filter((link) => link.show)
                    .map((link) =>
                      stale || loading ? (
                        <span
                          key={link.label}
                          className="mt-button"
                          aria-disabled="true"
                        >
                          {link.label}
                        </span>
                      ) : (
                        <a
                          key={link.label}
                          className={`mt-button${view === "grading" ? " mt-primary" : ""}`}
                          href={href(link.route)}
                          aria-label={link.aria}
                        >
                          {link.label}
                          {view === "grading" && (
                            <Icon name="arrow-right" size={16} />
                          )}
                        </a>
                      ),
                    )}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
