import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import type { Course, CourseRecord, Lesson, LessonResource } from "../model.js";
import { api, isConflict, RequestError } from "./api.js";
import { Failure, useBlock } from "./shared.js";
import type { OnBlock } from "./shared.js";
import { useConfirm } from "./ui/confirm.js";

type Errors = Record<string, string>;
const emptyCourse: Course = {
  title: "",
  summary: "",
  description: "",
  instructor: "",
  status: "draft",
  lessons: [],
  access: "invite",
};
export const MAX_LESSON_RESOURCES = 10;
/** Typed in the confirmation dialog before a course is opened to everyone. */
const OPEN_PHRASE = "OPEN";
const courseTextFields = [
  ["title", 160],
  ["instructor", 160],
  ["summary", 500],
  ["description", 5000],
] as const;
const lessonTextFields = [
  ["title", "title", 160],
  ["module", "module", 160],
  ["body", "body", 20000],
  ["videoUrl", "video", 2048],
  ["resourceUrl", "resource", 2048],
  ["resourceLabel", "label", 160],
] as const;

function parseHttpsUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      ? url
      : null;
  } catch {
    return null;
  }
}

export function validateCourse(course: Course): Errors {
  const errors: Errors = {};
  for (const [field, limit] of courseTextFields) {
    if (course[field].length > limit)
      errors[field] = `Use no more than ${limit} characters.`;
  }
  if (course.lessons.length > 100)
    errors.lessons = "A course can contain at most 100 lessons.";
  if (course.status === "published") {
    if (!course.title.trim()) errors.title = "Add a title before publishing.";
    if (!course.summary.trim())
      errors.summary = "Add a summary before publishing.";
    if (!course.instructor.trim())
      errors.instructor = "Name the instructor before publishing.";
    if (!course.lessons.length)
      errors.lessons = "Add at least one complete lesson before publishing.";
  }
  for (const lesson of course.lessons) {
    const key = `lesson-${lesson.id}`;
    for (const [field, suffix, limit] of lessonTextFields) {
      if (lesson[field].length > limit)
        errors[`${key}-${suffix}`] = `Use no more than ${limit} characters.`;
    }
    if (course.status === "published") {
      if (!lesson.module.trim())
        errors[`${key}-module`] = "Name this module before publishing.";
      if (!lesson.title.trim())
        errors[`${key}-title`] = "Name this lesson before publishing.";
    }
    if (
      !Number.isSafeInteger(lesson.durationMinutes) ||
      lesson.durationMinutes < 0 ||
      lesson.durationMinutes > 1440
    )
      errors[`${key}-duration`] =
        "Enter a whole number of minutes from 0 to 1440.";
    const videoUrl = lesson.videoUrl.trim();
    const resourceUrl = lesson.resourceUrl.trim();
    const resourceLabel = lesson.resourceLabel.trim();
    if (videoUrl) {
      const parsed = parseHttpsUrl(videoUrl);
      if (!parsed || !/\.(mp4|webm|ogg|ogv|m4v)$/i.test(parsed.pathname)) {
        errors[`${key}-video`] =
          "Use a direct HTTPS video URL ending in .mp4, .webm, .ogg, .ogv, or .m4v, without embedded credentials.";
      }
    }
    if (resourceUrl && !parseHttpsUrl(resourceUrl))
      errors[`${key}-resource`] =
        "Use an HTTPS resource URL without embedded credentials.";
    if (resourceUrl && !resourceLabel)
      errors[`${key}-label`] = "Give this resource a descriptive label.";
    if (resourceLabel && !resourceUrl)
      errors[`${key}-resource`] =
        "Add a URL for this resource, or remove its label.";
    const resources = lesson.resources ?? [];
    if (resources.length > MAX_LESSON_RESOURCES)
      errors[`${key}-resources`] =
        `A lesson can have at most ${MAX_LESSON_RESOURCES} more resources.`;
    resources.forEach((resource, position) => {
      const label = resource.label.trim();
      const url = resource.url;
      if (!label || label.length > 120 || /[\r\n\t]/.test(label))
        errors[`${key}-res-${position}-label`] =
          "Give this resource a label of 1 to 120 characters on one line.";
      if (
        !url ||
        url.length > 2048 ||
        url.trim() !== url ||
        /\s/.test(url) ||
        !parseHttpsUrl(url)
      )
        errors[`${key}-res-${position}-url`] =
          "Use an HTTPS link without spaces or embedded credentials (at most 2,048 characters).";
    });
  }
  return errors;
}

export function TextField({
  id,
  label,
  value,
  onChange,
  error,
  multiline = false,
  hint,
  required = false,
  maxLength,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  multiline?: boolean;
  hint?: string;
  required?: boolean;
  maxLength?: number;
}) {
  const attributes = {
    id: `mt-${id}`,
    value,
    required,
    maxLength,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": error
      ? `mt-${id}-error`
      : hint
        ? `mt-${id}-hint`
        : undefined,
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      onChange(event.target.value),
  };
  return (
    <div className="mt-field">
      <label htmlFor={`mt-${id}`}>
        {label}
        {required && <span className="mt-required"> (required)</span>}
      </label>
      {multiline ? (
        <textarea {...attributes} rows={id.endsWith("-body") ? 8 : 3} />
      ) : (
        <input {...attributes} type="text" />
      )}
      {hint && <small id={`mt-${id}-hint`}>{hint}</small>}
      {error && (
        <p id={`mt-${id}-error`} className="mt-field-error">
          {error}
        </p>
      )}
    </div>
  );
}

/** The extra resources of one lesson: add, edit, reorder and remove rows. */
function ResourceRows({
  lessonKey,
  lessonNumber,
  resources,
  errors,
  onChange,
  onNotice,
}: {
  lessonKey: string;
  lessonNumber: number;
  resources: LessonResource[];
  errors: Errors;
  onChange: (resources: LessonResource[]) => void;
  onNotice: (message: string) => void;
}) {
  function update(position: number, patch: Partial<LessonResource>) {
    onChange(
      resources.map((resource, index) =>
        index === position ? { ...resource, ...patch } : resource,
      ),
    );
  }
  function move(position: number, direction: -1 | 1) {
    const next = [...resources];
    const current = next[position];
    const other = next[position + direction];
    if (!current || !other) return;
    next[position] = other;
    next[position + direction] = current;
    onChange(next);
    onNotice(
      `Moved ${current.label || "untitled resource"} to position ${position + direction + 1}.`,
    );
  }
  return (
    <fieldset className="mt-unframed mt-resources">
      <legend>More resources (optional)</legend>
      <p className="mt-muted">
        Up to {MAX_LESSON_RESOURCES} HTTPS links, shown after the resource
        above. Links to files such as .pdf or .zip are offered as downloads.
      </p>
      {errors[`${lessonKey}-resources`] && (
        <p className="mt-field-error">{errors[`${lessonKey}-resources`]}</p>
      )}
      {resources.length > 0 && (
        <ol className="mt-resource-rows">
          {resources.map((resource, position) => (
            <li key={position} className="mt-resource-row">
              <div className="mt-grid">
                <TextField
                  id={`${lessonKey}-res-${position}-label`}
                  label={`Resource ${position + 1} label`}
                  value={resource.label}
                  onChange={(label) => update(position, { label })}
                  error={errors[`${lessonKey}-res-${position}-label`]}
                  required
                  maxLength={120}
                />
                <TextField
                  id={`${lessonKey}-res-${position}-url`}
                  label={`Resource ${position + 1} URL`}
                  value={resource.url}
                  onChange={(url) => update(position, { url })}
                  error={errors[`${lessonKey}-res-${position}-url`]}
                  required
                  maxLength={2048}
                />
              </div>
              <div className="mt-actions">
                <button
                  type="button"
                  disabled={position === 0}
                  aria-label={`Move resource ${position + 1} of lesson ${lessonNumber} up`}
                  onClick={() => move(position, -1)}
                >
                  Move up
                </button>
                <button
                  type="button"
                  disabled={position === resources.length - 1}
                  aria-label={`Move resource ${position + 1} of lesson ${lessonNumber} down`}
                  onClick={() => move(position, 1)}
                >
                  Move down
                </button>
                <button
                  type="button"
                  className="mt-danger"
                  onClick={() => {
                    onChange(
                      resources.filter((_, index) => index !== position),
                    );
                    onNotice(
                      `Removed resource ${position + 1}. Save to apply this change.`,
                    );
                  }}
                >
                  Remove
                  <span className="mt-sr-only">
                    {" "}
                    resource {position + 1} of lesson {lessonNumber}
                  </span>
                </button>
              </div>
            </li>
          ))}
        </ol>
      )}
      <button
        type="button"
        disabled={resources.length >= MAX_LESSON_RESOURCES}
        onClick={() => {
          const position = resources.length;
          onChange([...resources, { label: "", url: "" }]);
          requestAnimationFrame(() =>
            document
              .getElementById(`mt-${lessonKey}-res-${position}-label`)
              ?.focus(),
          );
        }}
      >
        Add resource
      </button>
    </fieldset>
  );
}

export function CourseEditor({
  id,
  record,
  onSaved,
  onBlock,
  onClose,
}: {
  id: string;
  record?: CourseRecord;
  onSaved: (record: CourseRecord) => void;
  onBlock: OnBlock;
  onClose: () => void;
}) {
  const { ask, action } = useConfirm();
  const [value, setValue] = useState<Course>(record?.value ?? emptyCourse);
  const [baseline, setBaseline] = useState<Course>(
    record?.value ?? emptyCourse,
  );
  const [revision, setRevision] = useState<string | null>(
    record?.revision ?? null,
  );
  const [errors, setErrors] = useState<Errors>({});
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState<"save" | "reload" | null>(null);
  const [lastAction, setLastAction] = useState<"save" | "reload">("save");
  const busy = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const dirty = JSON.stringify(value) !== JSON.stringify(baseline);
  useBlock(dirty, pending !== null, onBlock);
  useEffect(() => {
    heading.current?.focus();
  }, []);

  function change(next: Course) {
    setValue(next);
    setNotice("");
  }
  function changeLesson(index: number, patch: Partial<Lesson>) {
    change({
      ...value,
      lessons: value.lessons.map((lesson, position) =>
        position === index ? { ...lesson, ...patch } : lesson,
      ),
    });
  }
  function moveLesson(index: number, direction: -1 | 1) {
    const lessons = [...value.lessons];
    const next = index + direction;
    const current = lessons[index];
    const other = lessons[next];
    if (!current || !other) return;
    lessons[index] = other;
    lessons[next] = current;
    change({ ...value, lessons });
    setNotice(
      `Moved ${current.title || "untitled lesson"} to position ${next + 1}.`,
    );
  }
  function accept(saved: CourseRecord) {
    setValue(saved.value);
    setBaseline(saved.value);
    setRevision(saved.revision);
    setErrors({});
    onSaved(saved);
  }
  async function save(event?: FormEvent) {
    event?.preventDefault();
    if (busy.current) return;
    const nextErrors = validateCourse(value);
    setErrors(nextErrors);
    setError(null);
    setNotice("");
    if (Object.keys(nextErrors).length) {
      requestAnimationFrame(() =>
        form.current
          ?.querySelector<HTMLElement>('[aria-invalid="true"], .mt-validation')
          ?.focus(),
      );
      return;
    }
    if (
      value.status === "published" &&
      baseline.status !== "published" &&
      !(await ask({
        title: `Publish “${value.title.trim()}”?`,
        body: "Its overview will appear in the catalog and invited students can access its lessons.",
        confirmLabel: "Publish",
      }))
    )
      return;
    if (
      value.status === "draft" &&
      baseline.status === "published" &&
      !(await ask({
        title: `Move “${value.title.trim()}” to draft?`,
        body: "Students will lose access to its lessons until you publish it again.",
        confirmLabel: "Move to draft",
        danger: true,
      }))
    )
      return;
    let confirmed: { confirmation: string; reason: string } | undefined;
    if (value.access === "open" && (baseline.access ?? "invite") !== "open") {
      const answer = await action(
        `Every signed-in student will be able to start “${value.title.trim() || "this course"}” for free${value.status === "published" ? "" : " once it is published"}. Students who start it keep their access if you switch back to invite-only; remove it under Students if needed.`,
        OPEN_PHRASE,
      );
      if (!answer) return;
      confirmed = answer;
    }
    busy.current = true;
    setPending("save");
    setLastAction("save");
    try {
      const saved = await api.save(id, revision, value, confirmed);
      accept(saved);
      setNotice(
        saved.value.status === "published"
          ? "Published course saved. You are viewing the server record."
          : "Draft saved. You are viewing the server record.",
      );
    } catch (cause) {
      setError(cause);
    } finally {
      busy.current = false;
      setPending(null);
    }
  }
  async function reload() {
    if (
      busy.current ||
      !(await ask({
        title: "Reload the latest saved course?",
        body: "This replaces your unsaved edits only after the reload succeeds.",
        confirmLabel: "Reload",
        danger: true,
      }))
    )
      return;
    busy.current = true;
    setPending("reload");
    setLastAction("reload");
    setError(null);
    setNotice("");
    try {
      const courses = await api.courses();
      const saved = courses.find((course) => course.id === id);
      if (!saved)
        throw new RequestError(
          "not_found",
          "This course is not on the server. Your edits are still here; return to the course list to refresh it.",
        );
      accept(saved);
      setNotice(
        "Loaded the latest saved course. You can now make your changes again.",
      );
    } catch (cause) {
      setError(cause);
    } finally {
      busy.current = false;
      setPending(null);
    }
  }

  return (
    <section className="mt-panel" aria-labelledby="mt-editor-heading">
      <div className="mt-section-heading">
        <div>
          <p className="mt-eyebrow">Course workshop</p>
          <h2 id="mt-editor-heading" ref={heading} tabIndex={-1}>
            {revision ? "Edit course" : "New course"}
          </h2>
        </div>
        <button type="button" onClick={onClose} disabled={pending !== null}>
          Back to courses
        </button>
      </div>
      <p className="mt-muted">
        Build the course in order, then publish when it is ready. Drafts stay
        private. Lesson content is plain text, not HTML.
      </p>
      {notice && (
        <p role="status" className="mt-notice">
          {notice}
        </p>
      )}
      <Failure
        error={error}
        retry={
          pending
            ? undefined
            : isConflict(error) || lastAction === "reload"
              ? () => {
                  void reload();
                }
              : () => {
                  void save();
                }
        }
        retryLabel={
          isConflict(error)
            ? "Reload latest course"
            : lastAction === "reload"
              ? "Retry reload"
              : "Retry save"
        }
      />
      {isConflict(error) && (
        <p className="mt-muted">
          Your edits are still in the form. Copy anything you want to keep
          before reloading; a newer revision cannot be overwritten.
        </p>
      )}
      <form
        ref={form}
        onSubmit={(event) => {
          void save(event);
        }}
        noValidate
        aria-busy={pending !== null}
      >
        {Object.keys(errors).length > 0 && (
          <div className="mt-validation mt-error" tabIndex={-1} role="alert">
            <p>Review the highlighted fields before saving.</p>
            {errors.lessons && <p>{errors.lessons}</p>}
          </div>
        )}
        <fieldset className="mt-unframed" disabled={pending !== null}>
          <legend className="mt-sr-only">Course details and lessons</legend>
          <div className="mt-grid">
            <TextField
              id="title"
              label="Course title"
              value={value.title}
              onChange={(title) => change({ ...value, title })}
              error={errors.title}
              required={value.status === "published"}
              maxLength={160}
            />
            <TextField
              id="instructor"
              label="Instructor"
              value={value.instructor}
              onChange={(instructor) => change({ ...value, instructor })}
              error={errors.instructor}
              required={value.status === "published"}
              maxLength={160}
            />
          </div>
          <TextField
            id="summary"
            label="Short summary"
            value={value.summary}
            onChange={(summary) => change({ ...value, summary })}
            error={errors.summary}
            multiline
            required={value.status === "published"}
            maxLength={500}
          />
          <TextField
            id="description"
            label="Course description"
            value={value.description}
            onChange={(description) => change({ ...value, description })}
            error={errors.description}
            multiline
            maxLength={5000}
          />
          <div className="mt-field mt-status-field">
            <label htmlFor="mt-course-status">Status after saving</label>
            <select
              id="mt-course-status"
              value={value.status}
              onChange={(event) =>
                change({
                  ...value,
                  status:
                    event.target.value === "published" ? "published" : "draft",
                })
              }
            >
              <option value="draft">Draft — private</option>
              <option value="published">
                Published — available to invited students
              </option>
            </select>
            <small>
              Changing this selection does not take effect until you save.
              Publishing makes only the course overview public.
            </small>
          </div>
          <div className="mt-field mt-access-field">
            <label htmlFor="mt-course-access" className="mt-check">
              <input
                id="mt-course-access"
                type="checkbox"
                checked={value.access === "open"}
                aria-describedby="mt-course-access-hint"
                onChange={(event) =>
                  change({
                    ...value,
                    access: event.target.checked ? "open" : "invite",
                  })
                }
              />
              <span>
                Open for free to every signed-in student{" "}
                <span lang="vi">
                  (Mở miễn phí cho mọi học viên đã đăng nhập)
                </span>
              </span>
            </label>
            <small id="mt-course-access-hint">
              When published, students see “Start learning” and get free,
              open-ended access. Invitations keep working. Turning this off
              stops new students from joining; students who already started keep
              their access.
            </small>
          </div>
          <div className="mt-section-heading">
            <div>
              <h3>Ordered curriculum</h3>
              <p className="mt-muted">
                {value.lessons.length}{" "}
                {value.lessons.length === 1 ? "lesson" : "lessons"} · Use Move
                up or Move down to change the learning order.
              </p>
            </div>
          </div>
          {value.lessons.length === 0 && (
            <div className="mt-empty">
              <h4>Your curriculum starts here</h4>
              <p>
                Add a lesson, give it a module, and write the content your
                students will learn from.
              </p>
            </div>
          )}
          <ol className="mt-lessons">
            {value.lessons.map((lesson, index) => {
              const key = `lesson-${lesson.id}`;
              return (
                <li key={lesson.id} className="mt-lesson">
                  <fieldset className="mt-unframed">
                    <legend className="mt-lesson-legend">
                      <span className="mt-number">
                        {String(index + 1).padStart(2, "0")}
                      </span>{" "}
                      {lesson.title || "Untitled lesson"}
                    </legend>
                    <div className="mt-actions mt-lesson-actions">
                      <button
                        type="button"
                        disabled={index === 0}
                        aria-label={`Move lesson ${index + 1} up`}
                        onClick={() => moveLesson(index, -1)}
                      >
                        Move up
                      </button>
                      <button
                        type="button"
                        disabled={index === value.lessons.length - 1}
                        aria-label={`Move lesson ${index + 1} down`}
                        onClick={() => moveLesson(index, 1)}
                      >
                        Move down
                      </button>
                      <button
                        type="button"
                        className="mt-danger"
                        onClick={async () => {
                          if (
                            !(await ask({
                              title: `Remove lesson ${index + 1}, “${lesson.title || "Untitled lesson"}”?`,
                              body: "This takes effect when you save. It will no longer count toward student progress.",
                              confirmLabel: "Remove lesson",
                              danger: true,
                            }))
                          )
                            return;
                          change({
                            ...value,
                            lessons: value.lessons.filter(
                              (entry) => entry.id !== lesson.id,
                            ),
                          });
                          setNotice(
                            `Removed lesson ${index + 1}. Save to apply this change.`,
                          );
                          requestAnimationFrame(() =>
                            document.getElementById("mt-add-lesson")?.focus(),
                          );
                        }}
                      >
                        Remove
                        <span className="mt-sr-only"> lesson {index + 1}</span>
                      </button>
                    </div>
                    <div className="mt-grid">
                      <TextField
                        id={`${key}-module`}
                        label="Module"
                        value={lesson.module}
                        onChange={(module) => changeLesson(index, { module })}
                        error={errors[`${key}-module`]}
                        required={value.status === "published"}
                        maxLength={160}
                      />
                      <TextField
                        id={`${key}-title`}
                        label="Lesson title"
                        value={lesson.title}
                        onChange={(title) => changeLesson(index, { title })}
                        error={errors[`${key}-title`]}
                        required={value.status === "published"}
                        maxLength={160}
                      />
                    </div>
                    <div className="mt-field mt-duration">
                      <label htmlFor={`mt-${key}-duration`}>
                        Duration in minutes (required)
                      </label>
                      <input
                        id={`mt-${key}-duration`}
                        type="number"
                        min="0"
                        max="1440"
                        step="1"
                        inputMode="numeric"
                        value={
                          Number.isNaN(lesson.durationMinutes)
                            ? ""
                            : lesson.durationMinutes
                        }
                        onChange={(event) =>
                          changeLesson(index, {
                            durationMinutes: event.target.valueAsNumber,
                          })
                        }
                        aria-invalid={
                          errors[`${key}-duration`] ? true : undefined
                        }
                        aria-describedby={
                          errors[`${key}-duration`]
                            ? `mt-${key}-duration-error`
                            : undefined
                        }
                      />
                      {errors[`${key}-duration`] && (
                        <p
                          id={`mt-${key}-duration-error`}
                          className="mt-field-error"
                        >
                          {errors[`${key}-duration`]}
                        </p>
                      )}
                    </div>
                    <TextField
                      id={`${key}-body`}
                      label="Lesson content"
                      value={lesson.body}
                      onChange={(body) => changeLesson(index, { body })}
                      error={errors[`${key}-body`]}
                      multiline
                      maxLength={20000}
                      hint="Plain text only. Line breaks are preserved; HTML and embed codes are not rendered. Publishing needs text, a direct video, or a published lesson video (Lesson videos screen)."
                    />
                    <TextField
                      id={`${key}-video`}
                      label="Direct video URL (optional)"
                      value={lesson.videoUrl}
                      onChange={(videoUrl) => changeLesson(index, { videoUrl })}
                      error={errors[`${key}-video`]}
                      maxLength={2048}
                      hint="HTTPS .mp4, .webm, .ogg, .ogv, or .m4v files only (signed query strings are allowed). No YouTube/Vimeo watch pages or iframes. Your provider must allow browser playback."
                    />
                    <div className="mt-grid">
                      <TextField
                        id={`${key}-label`}
                        label="Resource label (optional)"
                        value={lesson.resourceLabel}
                        onChange={(resourceLabel) =>
                          changeLesson(index, { resourceLabel })
                        }
                        error={errors[`${key}-label`]}
                        maxLength={160}
                      />
                      <TextField
                        id={`${key}-resource`}
                        label="Resource URL (optional)"
                        value={lesson.resourceUrl}
                        onChange={(resourceUrl) =>
                          changeLesson(index, { resourceUrl })
                        }
                        error={errors[`${key}-resource`]}
                        maxLength={2048}
                        hint="HTTPS only. Add both a label and URL, or leave both empty."
                      />
                    </div>
                    <ResourceRows
                      lessonKey={key}
                      lessonNumber={index + 1}
                      resources={lesson.resources ?? []}
                      errors={errors}
                      onChange={(resources) =>
                        changeLesson(index, { resources })
                      }
                      onNotice={setNotice}
                    />
                  </fieldset>
                </li>
              );
            })}
          </ol>
          <button
            type="button"
            id="mt-add-lesson"
            disabled={value.lessons.length >= 100}
            onClick={() => {
              const lessonId = crypto.randomUUID();
              change({
                ...value,
                lessons: [
                  ...value.lessons,
                  {
                    id: lessonId,
                    title: "",
                    module: "",
                    durationMinutes: 1,
                    body: "",
                    videoUrl: "",
                    resourceLabel: "",
                    resourceUrl: "",
                    resources: [],
                  },
                ],
              });
              requestAnimationFrame(() =>
                document
                  .getElementById(`mt-lesson-${lessonId}-module`)
                  ?.focus(),
              );
            }}
          >
            Add lesson
          </button>
          {value.lessons.length >= 100 && (
            <p className="mt-muted">
              This course has reached the limit of 100 lessons.
            </p>
          )}
          <p className="mt-muted mt-sharing-note">
            Private invitations protect access to the course, not copied media
            links. Set your provider’s sharing permissions carefully; these
            links are not DRM-protected.
          </p>
          <div className="mt-save-bar">
            <div>
              <strong>
                {dirty
                  ? "Unsaved changes"
                  : revision
                    ? "All changes saved"
                    : "Not saved yet"}
              </strong>
              <p className="mt-muted">
                {value.status === "published"
                  ? "Saving makes this content available to active invited students."
                  : "Save a draft now; publish when every lesson is ready."}
              </p>
            </div>
            <button type="submit" className="mt-primary">
              {pending === "save"
                ? "Saving…"
                : value.status === "published"
                  ? baseline.status === "published"
                    ? "Save published changes"
                    : "Publish course"
                  : baseline.status === "published"
                    ? "Save and move to draft"
                    : "Save draft"}
            </button>
          </div>
        </fieldset>
      </form>
      {pending === "reload" && (
        <p role="status">
          Reloading the latest course. Your current edits are retained until
          this succeeds…
        </p>
      )}
      {revision && (
        <button
          type="button"
          className="mt-subtle"
          disabled={pending !== null}
          onClick={() => {
            void reload();
          }}
        >
          Reload saved version
        </button>
      )}
    </section>
  );
}
