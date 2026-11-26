import { useEffect, useRef, useState } from "react";
import type { LearningState } from "@mytutor/plugin-mytutor-lms/model";
import { translator, type UiLocale } from "../i18n";
import { track } from "../lib/analytics";
import {
  LearningError,
  setCourseContext,
  studentRequest,
} from "../lib/student-client";
import AssignmentPanel, {
  hasAssignmentEdits,
  type AssignmentDraft,
} from "./learn/AssignmentPanel";
import CompletionMoment from "./learn/CompletionMoment";
import CurriculumRail from "./learn/CurriculumRail";
import LessonActionBar from "./learn/LessonActionBar";
import LessonHeader from "./learn/LessonHeader";
import LessonView from "./learn/LessonView";
import LiveSessionsPanel from "./learn/LiveSessionsPanel";
import { SIGN_OUT_EVENT } from "./shell/AccountMenu";
import {
  EmptyState,
  InlineAlert,
  Sheet,
  Skeleton,
  ToastRegion,
  showToast,
  useConfirmDialog,
  useUnsavedChangesGuard,
} from "./ui";

interface ScopedDraft {
  enrollmentId: string;
  lessonId: string;
  lessonTitle: string;
  draft: AssignmentDraft;
}

/**
 * The classroom: owns the course state, drafts and every leave guard. The
 * pieces under learn/ only render. The lesson comes first in the document;
 * the curriculum is a column on large screens and a Sheet below them.
 */
export default function Learning({
  courseId,
  locale = "en",
}: { courseId?: string; locale?: UiLocale } = {}) {
  // Account classrooms (`/learn/[courseId]`) name their course on every request.
  setCourseContext(courseId ?? null);
  const t = translator(locale);
  const [state, setState] = useState<LearningState | null>(null);
  const [selected, setSelected] = useState("");
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [railOpen, setRailOpen] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, ScopedDraft>>({});
  const [confirm, confirmDialog] = useConfirmDialog();
  const hasDrafts = Object.values(drafts).some(({ draft }) =>
    hasAssignmentEdits(draft),
  );
  const heading = useRef<HTMLHeadingElement>(null);
  // While a save is in flight nothing may leave; with drafts, ask first.
  const guard = useUnsavedChangesGuard(hasDrafts || pending, async () =>
    pending
      ? false
      : (await confirm({
          title: t("classroom.leave.title"),
          body: <p>{t("classroom.leave.body")}</p>,
          confirmLabel: t("classroom.leave.confirm"),
          cancelLabel: t("classroom.leave.stay"),
          tone: "danger",
        })) !== null,
  );
  function adoptCourse(data: LearningState, preferred: string | null) {
    const lessons = data.course.value.lessons;
    const nextLesson =
      lessons.find((lesson) => !data.completedLessonIds.includes(lesson.id)) ??
      lessons[0];
    const id =
      lessons.find((lesson) => lesson.id === preferred)?.id ??
      nextLesson?.id ??
      "";
    if (state && state.enrollmentId !== data.enrollmentId)
      setError(t("classroom.sessionChanged"));
    setState(data);
    setSelected(id);
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("lesson", id);
    else url.searchParams.delete("lesson");
    window.history.replaceState(null, "", url);
  }
  function accessLost(message: string) {
    setError(message);
    setState(null);
  }
  function preservedDrafts(
    enrollmentId: string | null,
    currentLessonIds: string[],
  ) {
    const preserved = Object.entries(drafts).filter(
      ([, entry]) =>
        (entry.enrollmentId !== enrollmentId ||
          !currentLessonIds.includes(entry.lessonId)) &&
        hasAssignmentEdits(entry.draft),
    );
    if (!preserved.length) return null;
    return (
      <section
        className="assignment draft-recovery"
        aria-labelledby="draft-recovery-heading"
      >
        <h2 id="draft-recovery-heading">{t("classroom.drafts.title")}</h2>
        <p>{t("classroom.drafts.body")}</p>
        {preserved.map(([id, entry]) => (
          <label className="field" key={id}>
            <span>
              {t(
                entry.draft.kind === "url"
                  ? "classroom.drafts.link"
                  : "classroom.drafts.text",
                { lesson: entry.lessonTitle },
              )}
            </span>
            <textarea readOnly rows={6} value={entry.draft.content} />
          </label>
        ))}
      </section>
    );
  }
  async function load() {
    setLoading(state === null);
    setError("");
    try {
      const data = await studentRequest<LearningState>("library");
      adoptCourse(
        data,
        new URL(window.location.href).searchParams.get("lesson"),
      );
    } catch (cause) {
      if (
        cause instanceof LearningError &&
        ["ACCESS_DENIED", "AUTH_REQUIRED"].includes(cause.code)
      )
        setState(null);
      setError(
        cause instanceof Error ? cause.message : t("classroom.loadFailed"),
      );
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  // The account menu signs out from the header. The classroom does it: it
  // knows the enrollment an invitation session must name, and it protects
  // drafts and saves first.
  useEffect(() => {
    function beforeSignOut(event: Event) {
      event.preventDefault();
      if (!pending) void signOut();
    }
    window.addEventListener(SIGN_OUT_EVENT, beforeSignOut);
    return () => window.removeEventListener(SIGN_OUT_EVENT, beforeSignOut);
  });
  async function signOut() {
    if (!(await guard.allowLeaving())) return;
    setPending(true);
    setError("");
    try {
      await studentRequest("logout", {}, state?.enrollmentId);
      guard.markLeaving();
      window.location.replace(courseId ? "/sign-in" : "/join");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : t("classroom.signOutFailed"),
      );
      setPending(false);
    }
  }
  async function complete(lessonId: string, completed: boolean) {
    if (pending) return;
    setPending(true);
    setError("");
    setNotice("");
    try {
      const data = await studentRequest<LearningState>(
        "complete",
        { lessonId, completed },
        state?.enrollmentId,
      );
      adoptCourse(data, selected);
      track(
        completed ? "lesson_completed" : "lesson_uncompleted",
        { courseId: data.course.id, lessonId },
        locale,
      );
      showToast(
        completed
          ? t("classroom.completedToast")
          : t("classroom.reopenedToast"),
      );
    } catch (cause) {
      if (cause instanceof LearningError && cause.code === "NOT_FOUND") {
        await load();
        setNotice(t("classroom.curriculumChanged"));
      } else {
        setError(
          cause instanceof Error ? cause.message : t("classroom.saveFailed"),
        );
        if (
          cause instanceof LearningError &&
          ["ACCESS_DENIED", "AUTH_REQUIRED"].includes(cause.code)
        )
          setState(null);
      }
    } finally {
      setPending(false);
    }
  }
  async function openLesson(id: string) {
    if (pending || id === selected) return;
    const draft = state
      ? drafts[`${state.enrollmentId}:${selected}`]?.draft
      : undefined;
    if (
      draft &&
      hasAssignmentEdits(draft) &&
      (await confirm({
        title: t("classroom.switch.title"),
        body: <p>{t("classroom.switch.body")}</p>,
        confirmLabel: t("classroom.switch.confirm"),
        cancelLabel: t("classroom.switch.stay"),
      })) === null
    )
      return;
    setSelected(id);
    setNotice("");
    setRailOpen(false);
    if (state)
      track(
        "lesson_opened",
        { courseId: state.course.id, lessonId: id },
        locale,
      );
    const url = new URL(window.location.href);
    url.searchParams.set("lesson", id);
    window.history.replaceState(null, "", url);
    window.requestAnimationFrame(() => heading.current?.focus());
  }
  const activeCourse = state?.course.value;
  const activeLessonTitle = (
    activeCourse?.lessons.find((item) => item.id === selected) ??
    activeCourse?.lessons[0]
  )?.title;
  const activeCourseTitle = activeCourse?.title;
  useEffect(() => {
    if (!activeLessonTitle) return;
    document.title = [activeLessonTitle, activeCourseTitle, "MyTutor"]
      .filter(Boolean)
      .join(" · ");
  }, [activeLessonTitle, activeCourseTitle]);
  if (loading)
    return (
      <div className="container learn-root">
        <Skeleton lines={4} label={t("classroom.loading")} />
      </div>
    );
  if (!state)
    return (
      <div className="narrow">
        <p className="eyebrow">{t("classroom.closed.eyebrow")}</p>
        <h1>{t("classroom.closed.title")}</h1>
        <InlineAlert tone="danger">
          {error || t("classroom.closed.default")}
        </InlineAlert>
        <p className="muted">
          {courseId
            ? t("classroom.closed.account")
            : t("classroom.closed.invitation")}
        </p>
        <div className="actions">
          <a className="button" href={courseId ? "/learn" : "/join"}>
            {courseId
              ? t("classroom.closed.dashboard")
              : t("classroom.closed.open")}
          </a>
          <button className="button secondary" onClick={() => void load()}>
            {t("common.tryAgain")}
          </button>
        </div>
        {preservedDrafts(null, [])}
        {confirmDialog}
      </div>
    );
  const course = state.course.value;
  const index = Math.max(
    0,
    course.lessons.findIndex((lesson) => lesson.id === selected),
  );
  const lesson = course.lessons[index];
  const completed = course.lessons.filter((item) =>
    state.completedLessonIds.includes(item.id),
  ).length;
  const allDone =
    course.lessons.length > 0 && completed === course.lessons.length;
  const isDone = lesson ? state.completedLessonIds.includes(lesson.id) : false;
  const next = course.lessons[index + 1];
  const rail = (
    <CurriculumRail
      t={t}
      lessons={course.lessons}
      completedIds={state.completedLessonIds}
      currentId={lesson?.id}
      disabled={pending}
      onOpen={(id) => void openLesson(id)}
    />
  );
  return (
    <div className="container learn-root classroom">
      <LessonHeader
        t={t}
        courseTitle={course.title}
        studentName={state.student.name}
        completed={completed}
        total={course.lessons.length}
        backHref={courseId ? "/learn" : undefined}
        onOpenCurriculum={() => setRailOpen(true)}
      />
      {error && <InlineAlert tone="danger">{error}</InlineAlert>}
      {preservedDrafts(
        state.enrollmentId,
        course.lessons.map((item) => item.id),
      )}
      <LiveSessionsPanel
        t={t}
        locale={locale}
        sessions={state.liveSessions ?? []}
      />
      <div className="classroom-shell">
        <article className="lesson-content" aria-labelledby="lesson-heading">
          {allDone && <CompletionMoment t={t} />}
          {lesson ? (
            <LessonView
              t={t}
              locale={locale}
              lesson={lesson}
              position={index}
              courseId={state.course.id}
              enrollmentId={state.enrollmentId}
              protectedVideo={(state.videoLessonIds ?? []).includes(lesson.id)}
              headingRef={heading}
              onAccessLost={accessLost}
            >
              <AssignmentPanel
                key={`${state.enrollmentId}:${lesson.id}`}
                t={t}
                locale={locale}
                enrollmentId={state.enrollmentId}
                lessonId={lesson.id}
                submission={
                  state.submissions.find(
                    (item) => item.lessonId === lesson.id,
                  ) ?? null
                }
                draft={drafts[`${state.enrollmentId}:${lesson.id}`]?.draft}
                pending={pending}
                onDraft={(draft) =>
                  setDrafts((current) => ({
                    ...current,
                    [`${state.enrollmentId}:${lesson.id}`]: {
                      enrollmentId: state.enrollmentId,
                      lessonId: lesson.id,
                      lessonTitle: lesson.title,
                      draft,
                    },
                  }))
                }
                onPending={setPending}
                onState={(data) => adoptCourse(data, lesson.id)}
                onAccessLost={accessLost}
              />
              <div role="status" aria-live="polite">
                {notice && <InlineAlert tone="info">{notice}</InlineAlert>}
              </div>
              <p className="muted completion-note">
                {t("classroom.completionNote")}
              </p>
              <LessonActionBar
                t={t}
                done={isDone}
                hasNext={!!next}
                pending={pending}
                onToggleComplete={() => void complete(lesson.id, !isDone)}
                onNext={() => next && void openLesson(next.id)}
              />
            </LessonView>
          ) : (
            <EmptyState title={t("classroom.empty.title")}>
              <p>{t("classroom.empty.body")}</p>
            </EmptyState>
          )}
        </article>
        <aside
          className="curriculum-rail"
          aria-label={t("classroom.curriculum")}
        >
          {rail}
        </aside>
      </div>
      <Sheet
        open={railOpen}
        onClose={() => setRailOpen(false)}
        title={t("classroom.curriculum")}
        closeLabel={t("common.close")}
      >
        {rail}
      </Sheet>
      <ToastRegion dismissLabel={t("common.dismiss")} />
      {confirmDialog}
    </div>
  );
}
