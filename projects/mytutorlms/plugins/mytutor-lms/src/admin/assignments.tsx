import { useCallback, useEffect, useRef, useState } from "react";
import type { CourseRecord, InstructorSubmission } from "../model.js";
import { api, dateLabel, isConflict, RequestError } from "./api.js";
import type { ReviewStatus } from "./api.js";
import { Failure, useBlock } from "./shared.js";
import type { OnBlock } from "./shared.js";
import { useConfirm } from "./ui/confirm.js";

const statusLabels = {
  submitted: "Submitted",
  needs_revision: "Needs revision",
  accepted: "Accepted",
};
type StatusFilter = "all" | InstructorSubmission["status"];

export function Assignments({
  course,
  onClose,
  onBlock,
}: {
  course: CourseRecord;
  onClose: () => void;
  onBlock: OnBlock;
}) {
  const { ask } = useConfirm();
  const [records, setRecords] = useState<InstructorSubmission[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [selected, setSelected] = useState<InstructorSubmission | null>(null);
  const [feedback, setFeedback] = useState("");
  const [pending, setPending] = useState<ReviewStatus | "recover" | null>(null);
  const [reviewError, setReviewError] = useState<unknown>(null);
  const [conflict, setConflict] = useState(false);
  const [notice, setNotice] = useState("");
  const busy = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const feedbackInput = useRef<HTMLTextAreaElement>(null);
  const dirty = selected !== null && feedback !== selected.feedback;
  useBlock(dirty, pending !== null || loading, onBlock);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setLoadError(null);
      try {
        const latest = await api.submissions(course.id, signal);
        if (signal?.aborted) return;
        setRecords(latest);
        return latest;
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

  const latest = records?.find((record) => record.id === selected?.id);
  const stale = selected !== null && latest?.revision !== selected.revision;
  const disabled = loading || pending !== null || Boolean(loadError);
  const visible = records?.filter(
    (record) => filter === "all" || record.status === filter,
  );

  async function select(record: InstructorSubmission) {
    if (busy.current || disabled || record.id === selected?.id) return;
    if (
      dirty &&
      !(await ask({
        title: "Review another submission?",
        body: "Your unsaved feedback will be lost.",
        confirmLabel: "Discard feedback",
        danger: true,
      }))
    )
      return;
    setSelected(record);
    setFeedback(record.feedback);
    setReviewError(null);
    setConflict(false);
    setNotice("");
    requestAnimationFrame(() => reviewHeading.current?.focus());
  }

  async function recover() {
    if (!selected || busy.current || loading) return;
    busy.current = true;
    setPending("recover");
    setReviewError(null);
    setNotice("");
    try {
      const current = await load();
      if (!current) return;
      const replacement = current.find((record) => record.id === selected.id);
      if (!replacement) {
        throw new RequestError(
          "NOT_FOUND",
          "This submission is no longer available for review. Your feedback draft is kept so you can copy it before leaving.",
        );
      }
      setSelected(replacement);
      setConflict(false);
      setNotice(
        "Latest version loaded. Your feedback draft is kept. Read the current work and saved feedback below, then choose a review decision again.",
      );
      requestAnimationFrame(() => reviewHeading.current?.focus());
    } catch (cause) {
      setReviewError(cause);
    } finally {
      busy.current = false;
      setPending(null);
    }
  }

  async function review(status: ReviewStatus) {
    if (!selected || busy.current || disabled || stale || conflict) return;
    busy.current = true;
    setPending(status);
    setReviewError(null);
    setNotice("");
    try {
      const saved = await api.reviewSubmission(
        course.id,
        selected.id,
        selected.revision,
        status,
        feedback,
      );
      const updated = { ...selected, ...saved };
      setRecords(
        (current) =>
          current?.map((record) =>
            record.id === saved.id ? updated : record,
          ) ?? null,
      );
      setSelected(updated);
      setFeedback(saved.feedback);
      setNotice(
        status === "accepted"
          ? "Submission accepted. The student can see your review."
          : "Revision requested. The student can see your feedback and submit a new attempt.",
      );
    } catch (cause) {
      setReviewError(cause);
      if (isConflict(cause)) setConflict(true);
      if (cause instanceof RequestError && cause.code === "VALIDATION")
        requestAnimationFrame(() => feedbackInput.current?.focus());
    } finally {
      busy.current = false;
      setPending(null);
    }
  }

  return (
    <section className="mt-panel" aria-labelledby="mt-assignments-heading">
      <div className="mt-section-heading">
        <div>
          <p className="mt-eyebrow">Private assignment review</p>
          <h2 id="mt-assignments-heading" ref={heading} tabIndex={-1}>
            Assignments · {course.value.title || "Untitled course"}
          </h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          disabled={pending !== null || loading}
        >
          Back to courses
        </button>
      </div>
      <p className="mt-muted">
        Review the current attempt for each student and lesson. Feedback is
        private to that student and instructors. Assignment reviews do not
        change lesson completion.
      </p>
      <div className="mt-section-heading">
        <div className="mt-field">
          <label htmlFor="mt-assignment-filter">
            Filter by submission status
          </label>
          <select
            id="mt-assignment-filter"
            value={filter}
            disabled={pending !== null}
            onChange={(event) => setFilter(event.target.value as StatusFilter)}
          >
            <option value="all">All statuses</option>
            <option value="submitted">Submitted</option>
            <option value="needs_revision">Needs revision</option>
            <option value="accepted">Accepted</option>
          </select>
        </div>
        <button
          type="button"
          disabled={loading || pending !== null}
          onClick={() => {
            void load();
          }}
        >
          Refresh assignments
        </button>
      </div>
      {loading && <p role="status">Loading private submissions…</p>}
      <Failure
        error={loadError}
        retry={
          loading || pending !== null
            ? undefined
            : () => {
                void load();
              }
        }
        retryLabel="Retry assignments"
      />
      {Boolean(loadError) && records && (
        <p className="mt-warning">
          These are the last loaded submissions. Review controls are paused
          until a successful refresh. Your feedback draft is kept.
        </p>
      )}
      {!loading && !loadError && records?.length === 0 && (
        <div className="mt-empty">
          <h3>No assignments submitted yet.</h3>
          <p>
            Enrolled students can submit text or an HTTPS link from a published
            lesson. Only current lessons appear here.
          </p>
        </div>
      )}
      {!loading &&
        !loadError &&
        Boolean(records?.length) &&
        visible?.length === 0 && (
          <p role="status" className="mt-empty">
            No submissions match this status. Choose another filter or refresh
            for new work.
          </p>
        )}
      <div className="mt-grading-split">
        {Boolean(visible?.length) && (
          <ul
            className="mt-submission-list"
            aria-label="Assignment submissions"
            aria-busy={loading}
          >
            {visible?.map((record) => (
              <li key={record.id} className="mt-submission-row">
                <div>
                  <h3>{record.lessonTitle || "Untitled lesson"}</h3>
                  <p>
                    {record.student.name} · {record.student.email}
                  </p>
                  <p className="mt-muted">
                    Attempt {record.attempt} · Submitted{" "}
                    {dateLabel(record.submittedAt)}
                  </p>
                  <span
                    className={`mt-badge ${record.status === "accepted" ? "mt-badge-active" : ""}`}
                  >
                    {statusLabels[record.status]}
                  </span>
                </div>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => select(record)}
                  aria-pressed={selected?.id === record.id}
                  aria-label={`Review ${record.student.name}'s assignment for ${record.lessonTitle}`}
                >
                  {selected?.id === record.id
                    ? "Selected for review"
                    : "Review assignment"}
                </button>
              </li>
            ))}
          </ul>
        )}
        {selected && (
          <section
            className="mt-assignment-review"
            aria-labelledby="mt-review-heading"
            aria-busy={pending !== null}
          >
            <p className="mt-eyebrow">
              Selected submission · Last loaded attempt
            </p>
            <h3 id="mt-review-heading" ref={reviewHeading} tabIndex={-1}>
              {selected.lessonTitle || "Untitled lesson"}
            </h3>
            <p>
              <strong>{selected.student.name}</strong> ·{" "}
              {selected.student.email}
              {!selected.student.active && " · Access revoked"}
            </p>
            <dl className="mt-submission-details">
              <div>
                <dt>Status</dt>
                <dd>{statusLabels[selected.status]}</dd>
              </div>
              <div>
                <dt>Attempt</dt>
                <dd>{selected.attempt}</dd>
              </div>
              <div>
                <dt>Submitted</dt>
                <dd>{dateLabel(selected.submittedAt)}</dd>
              </div>
              <div>
                <dt>Reviewed</dt>
                <dd>
                  {selected.reviewedAt
                    ? dateLabel(selected.reviewedAt)
                    : "Not reviewed yet"}
                </dd>
              </div>
            </dl>
            {(conflict || stale) && (
              <div className="mt-warning" role="alert">
                <p>
                  This submission changed or is no longer available. The last
                  loaded version is shown here. Review is paused to avoid
                  overwriting a newer attempt or review. Your feedback draft has
                  not been changed.
                </p>
                <button
                  type="button"
                  disabled={loading || pending !== null}
                  onClick={() => {
                    void recover();
                  }}
                >
                  {pending === "recover"
                    ? "Loading latest version…"
                    : "Load latest version (keep draft)"}
                </button>
              </div>
            )}
            <h4>Student work</h4>
            {selected.kind === "text" ? (
              <p className="mt-submission-text">{selected.content}</p>
            ) : (
              <div className="mt-submission-text">
                <a
                  href={selected.content}
                  target="_blank"
                  rel="noopener noreferrer"
                  referrerPolicy="no-referrer"
                >
                  {selected.content}
                </a>
                <p className="mt-muted">
                  Student-provided external link. Opens in a new tab; no preview
                  is fetched.
                </p>
              </div>
            )}
            <h4>Saved instructor feedback</h4>
            <p className="mt-submission-text">
              {selected.feedback || "No feedback saved."}
            </p>
            {selected.status === "accepted" && (
              <p className="mt-notice">
                Accepted work is read-only for the student. Request revision
                with feedback to reopen it.
              </p>
            )}
            <div className="mt-field">
              <label htmlFor="mt-review-feedback">Instructor feedback</label>
              <textarea
                id="mt-review-feedback"
                ref={feedbackInput}
                rows={7}
                maxLength={4000}
                value={feedback}
                disabled={pending !== null}
                onChange={(event) => setFeedback(event.target.value)}
                aria-describedby="mt-review-help"
              />
              <small id="mt-review-help">
                Required for Needs revision; optional for Accepted. Maximum
                4,000 characters. A student's new attempt replaces the previous
                feedback.
              </small>
              <small role="status">
                {dirty
                  ? "Unsaved feedback draft"
                  : "No unsaved feedback changes"}
              </small>
            </div>
            <div className="mt-actions">
              <button
                type="button"
                disabled={disabled || stale || conflict}
                onClick={() => {
                  void review("needs_revision");
                }}
              >
                {pending === "needs_revision"
                  ? "Requesting revision…"
                  : "Needs revision"}
              </button>
              <button
                type="button"
                className="mt-primary"
                disabled={disabled || stale || conflict}
                onClick={() => {
                  void review("accepted");
                }}
              >
                {pending === "accepted" ? "Accepting…" : "Accepted"}
              </button>
            </div>
            <Failure error={reviewError} />
            {Boolean(reviewError) && (
              <p className="mt-muted">
                Your feedback draft is kept. Correct the issue and choose a
                review decision again.
              </p>
            )}
            {notice && (
              <p className="mt-notice" role="status">
                {notice}
              </p>
            )}
          </section>
        )}
      </div>
    </section>
  );
}
