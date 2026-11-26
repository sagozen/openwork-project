import type { LearningState } from "@mytutor/plugin-mytutor-lms/model";
import { Icon, ProgressMeter } from "../ui";
import type { Translate } from "../../i18n";

type Lesson = LearningState["course"]["value"]["lessons"][number];

/** Progress and the lesson list; a column on large screens, a Sheet below. */
export default function CurriculumRail({
  t,
  lessons,
  completedIds,
  currentId,
  disabled,
  onOpen,
}: {
  t: Translate;
  lessons: Lesson[];
  completedIds: string[];
  currentId: string | undefined;
  disabled: boolean;
  onOpen: (id: string) => void;
}) {
  const completed = lessons.filter((lesson) =>
    completedIds.includes(lesson.id),
  ).length;
  return (
    <div className="curriculum-panel">
      <ProgressMeter
        value={completed}
        max={lessons.length}
        label={t("classroom.progress", {
          done: completed,
          total: lessons.length,
        })}
        detail={t("classroom.progressSaved")}
      />
      <nav className="lesson-nav" aria-label={t("classroom.lessons")}>
        {lessons.map((lesson, position) => {
          const done = completedIds.includes(lesson.id);
          const newModule =
            position === 0 || lessons[position - 1]?.module !== lesson.module;
          return (
            <div key={lesson.id}>
              {newModule && (
                <h3>{lesson.module || t("classroom.defaultModule")}</h3>
              )}
              <button
                type="button"
                aria-current={lesson.id === currentId ? "step" : undefined}
                disabled={disabled}
                onClick={() => onOpen(lesson.id)}
              >
                <span className={done ? "lesson-mark done" : "lesson-mark"}>
                  {done ? (
                    <>
                      <Icon name="check" size={16} />
                      <span className="mt-visually-hidden">
                        {t("classroom.completed")}
                      </span>
                    </>
                  ) : (
                    String(position + 1).padStart(2, "0")
                  )}
                </span>
                <span>
                  {lesson.title}
                  <small>
                    {t("classroom.minutes", { count: lesson.durationMinutes })}
                  </small>
                </span>
              </button>
            </div>
          );
        })}
      </nav>
    </div>
  );
}
