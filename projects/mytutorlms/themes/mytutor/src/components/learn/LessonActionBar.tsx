import { Button } from "../ui";
import type { Translate } from "../../i18n";

/**
 * Mark complete and Next lesson. Sticky at the bottom of phones so the next
 * step is always in reach; once the lesson is done, Next becomes primary.
 */
export default function LessonActionBar({
  t,
  done,
  hasNext,
  pending,
  onToggleComplete,
  onNext,
}: {
  t: Translate;
  done: boolean;
  hasNext: boolean;
  pending: boolean;
  onToggleComplete: () => void;
  onNext: () => void;
}) {
  return (
    <div className="lesson-actions">
      <Button
        variant={done ? "secondary" : "primary"}
        icon={done ? undefined : "check"}
        busy={pending}
        busyLabel={t("common.saving")}
        onClick={onToggleComplete}
      >
        {done ? t("classroom.markIncomplete") : t("classroom.markComplete")}
      </Button>
      {hasNext && (
        <Button
          variant={done ? "primary" : "secondary"}
          iconEnd="arrow-right"
          disabled={pending}
          onClick={onNext}
        >
          {t("classroom.nextLesson")}
        </Button>
      )}
    </div>
  );
}
