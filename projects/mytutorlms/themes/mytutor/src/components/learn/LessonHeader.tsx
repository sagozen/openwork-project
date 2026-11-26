import { Icon } from "../ui";
import type { Translate } from "../../i18n";

/**
 * The course bar above the lesson: course title, short progress and, below
 * the large breakpoint, the button that opens the curriculum.
 */
export default function LessonHeader({
  t,
  courseTitle,
  studentName,
  completed,
  total,
  backHref,
  onOpenCurriculum,
}: {
  t: Translate;
  courseTitle: string;
  studentName: string;
  completed: number;
  total: number;
  /** Account classrooms link back to the dashboard in place of the greeting. */
  backHref?: string;
  onOpenCurriculum: () => void;
}) {
  return (
    <header className="classroom-bar">
      <div>
        {backHref ? (
          <a className="text-link back-link" href={backHref}>
            <Icon name="arrow-left" size={16} />
            {t("classroom.allCourses")}
          </a>
        ) : (
          <p className="eyebrow">
            {t("classroom.welcome", { name: studentName })}
          </p>
        )}
        <h1>{courseTitle}</h1>
      </div>
      <button
        type="button"
        className="button secondary small curriculum-toggle"
        onClick={onOpenCurriculum}
      >
        <Icon name="list" size={18} />
        {t("classroom.openCurriculum", { done: completed, total })}
      </button>
    </header>
  );
}
