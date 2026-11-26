import { useState, type ReactNode, type Ref } from "react";
import type { LearningState } from "@mytutor/plugin-mytutor-lms/model";
import type { Translate, UiLocale } from "../../i18n";
import LessonVideo from "../player/LessonVideo";
import { lessonResources } from "../../lib/resources";
import { InlineAlert } from "../ui";
import LessonNotes from "./LessonNotes";
import ResourceList from "./ResourceList";

type Lesson = LearningState["course"]["value"]["lessons"][number];

/**
 * One lesson, video first: the title, the video (protected or plain), the
 * notes and resources. The assignment and action bar arrive as children so
 * the classroom keeps their state.
 */
export default function LessonView({
  t,
  locale,
  lesson,
  position,
  courseId,
  enrollmentId,
  protectedVideo,
  headingRef,
  onAccessLost,
  children,
}: {
  t: Translate;
  locale: UiLocale;
  lesson: Lesson;
  position: number;
  courseId: string;
  enrollmentId: string;
  protectedVideo: boolean;
  headingRef: Ref<HTMLHeadingElement>;
  onAccessLost: (message: string) => void;
  children: ReactNode;
}) {
  const [mediaError, setMediaError] = useState("");
  return (
    <>
      <p className="eyebrow">
        {lesson.module || t("classroom.defaultModuleLesson")} /{" "}
        {String(position + 1).padStart(2, "0")}
      </p>
      <h2 id="lesson-heading" tabIndex={-1} ref={headingRef}>
        {lesson.title}
      </h2>
      {protectedVideo ? (
        <LessonVideo
          key={lesson.id}
          courseId={courseId}
          lessonId={lesson.id}
          enrollmentId={enrollmentId}
          title={lesson.title}
          locale={locale}
          t={t}
          onAccessLost={onAccessLost}
        />
      ) : (
        lesson.videoUrl && (
          <>
            <video
              key={lesson.videoUrl}
              controls
              preload="metadata"
              playsInline
              onError={() => setMediaError(lesson.videoUrl)}
              onLoadedData={() => setMediaError("")}
              aria-label={t("video.label", { title: lesson.title })}
              src={lesson.videoUrl}
            >
              {t("video.unsupportedPlain")}
            </video>
            {mediaError === lesson.videoUrl && (
              <InlineAlert tone="danger">{t("video.loadFailed")}</InlineAlert>
            )}
          </>
        )
      )}
      {lesson.body.trim() && (
        <div className="lesson-text">
          <p className="eyebrow">{t("classroom.notes")}</p>
          <LessonNotes text={lesson.body} />
        </div>
      )}
      <ResourceList t={t} resources={lessonResources(lesson)} />
      {children}
    </>
  );
}
