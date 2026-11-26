import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { CourseRecord, LiveSession, LiveSessionInput } from "../model.js";
import { api, dateLabel, isConflict, newMediaAssetId } from "./api.js";
import { TextField } from "./course-editor.js";
import { Failure, useBlock } from "./shared.js";
import type { OnBlock } from "./shared.js";
import { useConfirm } from "./ui/confirm.js";

interface Draft {
  id: string;
  revision: string | null;
  title: string;
  /** `datetime-local` value in the staff member's own time zone. */
  startsAtLocal: string;
  durationMinutes: number;
  joinUrl: string;
  passcode: string;
  notes: string;
}
type Errors = Partial<Record<keyof Draft, string>>;

const pad = (value: number) => String(value).padStart(2, "0");
/** ISO instant to a `datetime-local` value in this browser's time zone. */
export function toLocalInput(iso: string): string {
  const date = new Date(iso);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
/** A `datetime-local` value (this browser's time zone) to an ISO instant in UTC, or null. */
export function fromLocalInput(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function emptyDraft(): Draft {
  const start = new Date(Date.now() + 24 * 60 * 60 * 1000);
  start.setMinutes(0, 0, 0);
  return {
    id: newMediaAssetId(),
    revision: null,
    title: "",
    startsAtLocal: toLocalInput(start.toISOString()),
    durationMinutes: 60,
    joinUrl: "",
    passcode: "",
    notes: "",
  };
}
function draftFrom(session: LiveSession): Draft {
  return {
    id: session.id,
    revision: session.revision,
    title: session.title,
    startsAtLocal: toLocalInput(session.startsAt),
    durationMinutes: session.durationMinutes,
    joinUrl: session.joinUrl,
    passcode: session.passcode,
    notes: session.notes,
  };
}

export function validateLiveSession(draft: Draft): Errors {
  const errors: Errors = {};
  const title = draft.title.trim();
  if (!title || title.length > 120 || /[\r\n\t]/.test(title))
    errors.title = "Give the session a title of 1 to 120 characters.";
  if (!fromLocalInput(draft.startsAtLocal))
    errors.startsAtLocal = "Choose the date and start time.";
  if (
    !Number.isInteger(draft.durationMinutes) ||
    draft.durationMinutes < 15 ||
    draft.durationMinutes > 480
  )
    errors.durationMinutes = "Enter a whole number of minutes from 15 to 480.";
  let url: URL | null = null;
  try {
    url = new URL(draft.joinUrl);
  } catch {
    url = null;
  }
  if (
    !url ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    draft.joinUrl.length > 2048 ||
    /\s/.test(draft.joinUrl)
  )
    errors.joinUrl =
      "Paste the HTTPS meeting link (for example https://zoom.us/j/…).";
  if (draft.passcode.trim().length > 40 || /[\r\n\t]/.test(draft.passcode))
    errors.passcode = "Use at most 40 characters on one line.";
  if (draft.notes.trim().length > 1000)
    errors.notes = "Use no more than 1,000 characters.";
  return errors;
}

function sessionInput(courseId: string, draft: Draft): LiveSessionInput {
  return {
    courseId,
    title: draft.title.trim(),
    startsAt: fromLocalInput(draft.startsAtLocal) ?? "",
    durationMinutes: draft.durationMinutes,
    joinUrl: draft.joinUrl,
    passcode: draft.passcode.trim(),
    notes: draft.notes.trim(),
  };
}

/** Per course: schedule, edit and delete live classes (Zoom or any HTTPS meeting link). */
export function LiveSessions({
  course,
  onBlock,
  onClose,
}: {
  course: CourseRecord;
  onBlock: OnBlock;
  onClose: () => void;
}) {
  const { ask } = useConfirm();
  const [sessions, setSessions] = useState<LiveSession[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [baseline, setBaseline] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);
  const [notice, setNotice] = useState("");
  const busy = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const formHeading = useRef<HTMLHeadingElement>(null);
  const dirty = draft !== null && JSON.stringify(draft) !== baseline;
  useBlock(dirty, pending, onBlock);
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setLoadError(null);
      try {
        const latest = await api.liveSessions(course.id, signal);
        if (!signal?.aborted) setSessions(latest);
      } catch (cause) {
        if (!signal?.aborted) setLoadError(cause);
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [course.id],
  );
  useEffect(() => {
    heading.current?.focus();
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function run(action: () => Promise<unknown>, success: string) {
    if (busy.current) return false;
    busy.current = true;
    setPending(true);
    setActionError(null);
    setNotice("");
    try {
      await action();
      setNotice(success);
      await load();
      return true;
    } catch (cause) {
      setActionError(cause);
      if (isConflict(cause)) await load();
      return false;
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  async function edit(next: Draft) {
    if (
      dirty &&
      !(await ask({
        title: "Discard your unsaved session changes?",
        confirmLabel: "Discard changes",
        danger: true,
      }))
    )
      return;
    setDraft(next);
    setBaseline(JSON.stringify(next));
    setErrors({});
    setActionError(null);
    setNotice("");
    requestAnimationFrame(() => formHeading.current?.focus());
  }

  function save(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    const nextErrors = validateLiveSession(draft);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) return;
    const current = draft;
    void run(async () => {
      await api.saveLiveSession(
        current.id,
        current.revision,
        sessionInput(course.id, current),
      );
      setDraft(null);
      setBaseline("");
    }, "Live session saved. Students with access see it in the classroom.");
  }

  async function remove(session: LiveSession) {
    if (
      !(await ask({
        title: `Delete “${session.title}”?`,
        body: "Students will no longer see this session or its join link.",
        confirmLabel: "Delete session",
        danger: true,
      }))
    )
      return;
    void run(async () => {
      await api.deleteLiveSession(session);
      if (draft?.id === session.id) {
        setDraft(null);
        setBaseline("");
      }
    }, "Live session deleted.");
  }

  const disabled = loading || pending || Boolean(loadError);
  const now = Date.now();
  return (
    <section className="mt-panel" aria-labelledby="mt-live-heading">
      <div className="mt-section-heading">
        <div>
          <p className="mt-eyebrow">
            {course.value.title || "Untitled course"}
          </p>
          <h2 id="mt-live-heading" ref={heading} tabIndex={-1}>
            Live sessions <span lang="vi">(Buổi học trực tiếp)</span>
          </h2>
          <p className="mt-muted">
            Schedule live classes with a Zoom (or other HTTPS) meeting link.
            Students with access to this course see the link and passcode in the
            classroom; the public course page shows only titles and times. Times
            use this computer’s time zone ({timeZone}).
          </p>
        </div>
        <div className="mt-actions">
          <button type="button" onClick={onClose} disabled={pending}>
            Back to courses
          </button>
          <button
            type="button"
            className="mt-primary"
            disabled={disabled}
            onClick={() => void edit(emptyDraft())}
          >
            Add live session
          </button>
        </div>
      </div>
      {loading && <p role="status">Loading live sessions…</p>}
      <Failure error={loadError} retry={() => void load()} retryLabel="Retry" />
      <Failure error={actionError} />
      {notice && (
        <p className="mt-notice" role="status">
          {notice}
        </p>
      )}
      {draft && (
        <form className="mt-media-form" onSubmit={save} noValidate>
          <h3 ref={formHeading} tabIndex={-1}>
            {draft.revision ? "Edit live session" : "New live session"}
          </h3>
          <fieldset className="mt-unframed" disabled={pending}>
            <legend className="mt-sr-only">Live session details</legend>
            <TextField
              id="live-title"
              label="Title"
              value={draft.title}
              onChange={(title) => setDraft({ ...draft, title })}
              error={errors.title}
              required
              maxLength={120}
            />
            <div className="mt-grid">
              <div className="mt-field">
                <label htmlFor="mt-live-start">
                  Starts at ({timeZone})
                  <span className="mt-required"> (required)</span>
                </label>
                <input
                  id="mt-live-start"
                  type="datetime-local"
                  required
                  value={draft.startsAtLocal}
                  aria-invalid={errors.startsAtLocal ? true : undefined}
                  aria-describedby={
                    errors.startsAtLocal ? "mt-live-start-error" : undefined
                  }
                  onChange={(event) =>
                    setDraft({ ...draft, startsAtLocal: event.target.value })
                  }
                />
                {errors.startsAtLocal && (
                  <p id="mt-live-start-error" className="mt-field-error">
                    {errors.startsAtLocal}
                  </p>
                )}
              </div>
              <div className="mt-field">
                <label htmlFor="mt-live-duration">
                  Duration in minutes (15–480)
                  <span className="mt-required"> (required)</span>
                </label>
                <input
                  id="mt-live-duration"
                  type="number"
                  min="15"
                  max="480"
                  step="5"
                  inputMode="numeric"
                  required
                  value={
                    Number.isNaN(draft.durationMinutes)
                      ? ""
                      : draft.durationMinutes
                  }
                  aria-invalid={errors.durationMinutes ? true : undefined}
                  aria-describedby={
                    errors.durationMinutes
                      ? "mt-live-duration-error"
                      : undefined
                  }
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      durationMinutes: event.target.valueAsNumber,
                    })
                  }
                />
                {errors.durationMinutes && (
                  <p id="mt-live-duration-error" className="mt-field-error">
                    {errors.durationMinutes}
                  </p>
                )}
              </div>
            </div>
            <TextField
              id="live-url"
              label="Meeting link (Zoom)"
              value={draft.joinUrl}
              onChange={(joinUrl) => setDraft({ ...draft, joinUrl })}
              error={errors.joinUrl}
              required
              maxLength={2048}
              hint="Shown only to students with access to this course."
            />
            <TextField
              id="live-passcode"
              label="Passcode (optional)"
              value={draft.passcode}
              onChange={(passcode) => setDraft({ ...draft, passcode })}
              error={errors.passcode}
              maxLength={40}
            />
            <TextField
              id="live-notes"
              label="Notes for students (optional)"
              value={draft.notes}
              onChange={(notes) => setDraft({ ...draft, notes })}
              error={errors.notes}
              multiline
              maxLength={1000}
            />
            <div className="mt-actions">
              <button type="submit" className="mt-primary">
                {pending ? "Saving…" : "Save live session"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setDraft(null);
                  setBaseline("");
                  setErrors({});
                }}
              >
                Cancel
              </button>
            </div>
          </fieldset>
        </form>
      )}
      {sessions && sessions.length === 0 && !draft && (
        <div className="mt-empty">
          <h3>No live sessions yet.</h3>
          <p>Add one to show students when and where to join.</p>
        </div>
      )}
      {sessions && sessions.length > 0 && (
        <ul className="mt-media-list">
          {sessions.map((session) => {
            const start = Date.parse(session.startsAt);
            const ended = start + session.durationMinutes * 60_000 <= now;
            return (
              <li key={session.id}>
                <div>
                  <span
                    className={`mt-badge ${ended ? "" : "mt-badge-active"}`}
                  >
                    {ended
                      ? "Ended"
                      : start <= now
                        ? "In progress"
                        : "Upcoming"}
                  </span>{" "}
                  <strong>{session.title}</strong>
                  <p className="mt-muted">
                    {dateLabel(session.startsAt)} · {session.durationMinutes}{" "}
                    min{session.passcode ? " · passcode set" : ""}
                  </p>
                </div>
                <div className="mt-actions">
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => void edit(draftFrom(session))}
                    aria-label={`Edit ${session.title}`}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="mt-danger"
                    disabled={disabled}
                    onClick={() => void remove(session)}
                    aria-label={`Delete ${session.title}`}
                  >
                    Delete
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
