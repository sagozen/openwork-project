import { useRef, useState, type SubmitEvent } from "react";
import type {
  LearningState,
  SubmissionRecord,
} from "@mytutor/plugin-mytutor-lms/model";
import type { MessageKey, Translate, UiLocale } from "../../i18n";
import { track } from "../../lib/analytics";
import { formatDateTime, formatNumber } from "../../lib/format";
import { LearningError, studentRequest } from "../../lib/student-client";
import { Disclosure, InlineAlert, StatusPill, useConfirmDialog } from "../ui";

interface AssignmentSnapshot {
  kind: SubmissionRecord["kind"];
  content: string;
  review: SubmissionRecord | null;
}

export interface AssignmentDraft {
  kind: SubmissionRecord["kind"];
  content: string;
  base: SubmissionRecord | null;
  snapshot: AssignmentSnapshot | null;
  requiresRefresh: boolean;
}

export function hasAssignmentEdits(draft: AssignmentDraft) {
  return (
    draft.kind !== (draft.base?.kind ?? "text") ||
    draft.content !== (draft.base?.content ?? "")
  );
}

const STATUS_TONE = {
  submitted: "neutral",
  needs_revision: "warning",
  accepted: "success",
} as const;

function SavedSubmission({
  t,
  locale,
  submission,
}: {
  t: Translate;
  locale: UiLocale;
  submission: SubmissionRecord;
}) {
  return (
    <div className="assignment-review">
      <p className="assignment-status">
        <StatusPill tone={STATUS_TONE[submission.status]}>
          {t(`assignment.status.${submission.status}` as MessageKey)}
        </StatusPill>{" "}
        {t("assignment.attempt", { number: submission.attempt })}
      </p>
      <p className="muted assignment-meta">
        {t("assignment.submittedAt")}{" "}
        <time dateTime={submission.submittedAt}>
          {formatDateTime(submission.submittedAt, locale)}
        </time>
        {submission.reviewedAt && (
          <>
            {" · "}
            {t("assignment.reviewedAt")}{" "}
            <time dateTime={submission.reviewedAt}>
              {formatDateTime(submission.reviewedAt, locale)}
            </time>
          </>
        )}
      </p>
      <h3>
        {submission.kind === "url"
          ? t("assignment.yourLink")
          : t("assignment.yourText")}
      </h3>
      {submission.kind === "url" ? (
        <p className="assignment-link">
          <a
            href={submission.content}
            target="_blank"
            rel="noopener noreferrer"
          >
            {submission.content}
          </a>
        </p>
      ) : (
        <div className="prose assignment-copy">{submission.content}</div>
      )}
      <h3>{t("assignment.feedback")}</h3>
      {submission.feedback ? (
        <div className="prose assignment-copy">{submission.feedback}</div>
      ) : (
        <p className="muted">
          {submission.status === "submitted"
            ? t("assignment.awaitingReview")
            : t("assignment.noFeedback")}
        </p>
      )}
    </div>
  );
}

interface Props {
  t: Translate;
  locale: UiLocale;
  enrollmentId: string;
  lessonId: string;
  submission: SubmissionRecord | null;
  draft?: AssignmentDraft;
  pending: boolean;
  onDraft: (draft: AssignmentDraft) => void;
  onPending: (pending: boolean) => void;
  onState: (state: LearningState) => void;
  onAccessLost: (message: string) => void;
}

export default function AssignmentPanel({
  t,
  locale,
  enrollmentId,
  lessonId,
  submission,
  draft: storedDraft,
  pending,
  onDraft,
  onPending,
  onState,
  onAccessLost,
}: Props) {
  const draft = storedDraft ?? {
    kind: submission?.kind ?? "text",
    content: submission?.content ?? "",
    base: submission,
    snapshot: null,
    requiresRefresh: false,
  };
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirm, confirmDialog] = useConfirmDialog();
  const conflict = draft.requiresRefresh;
  const [operation, setOperation] = useState<"submit" | "refresh" | null>(null);
  const inFlight = useRef(false);
  const contentField = useRef<HTMLInputElement | HTMLTextAreaElement | null>(
    null,
  );
  const reviewChanged =
    (draft.base?.revision ?? null) !== (submission?.revision ?? null);
  const accepted = submission?.status === "accepted";
  const dirty = hasAssignmentEdits(draft);
  const limit = draft.kind === "text" ? 4000 : 2048;
  const fieldId = `assignment-content-${lessonId}`;
  const hintId = `assignment-hint-${lessonId}`;
  const errorId = `assignment-error-${lessonId}`;

  function reportFailure(cause: unknown, fallback: string) {
    const message = cause instanceof Error ? cause.message : fallback;
    setError(message);
    if (cause instanceof LearningError) {
      if (
        ["CONFLICT", "NETWORK", "UNAVAILABLE", "SESSION_CHANGED"].includes(
          cause.code,
        )
      ) {
        // A lost response may still have committed. Refresh before another write.
        onDraft({ ...draft, requiresRefresh: true });
      }
      if (["ACCESS_DENIED", "AUTH_REQUIRED"].includes(cause.code)) {
        onAccessLost(message);
      }
    }
  }

  async function refresh() {
    if (pending || inFlight.current) return;
    inFlight.current = true;
    onPending(true);
    setOperation("refresh");
    setError("");
    setNotice("");
    try {
      const data = await studentRequest<LearningState>("library");
      onState(data);
      if (storedDraft) onDraft({ ...draft, requiresRefresh: false });
      setNotice(t("assignment.refreshed"));
    } catch (cause) {
      reportFailure(cause, t("assignment.refreshFailed"));
    } finally {
      inFlight.current = false;
      onPending(false);
      setOperation(null);
    }
  }

  function reconcile(keepDraft: boolean) {
    if (pending) return;
    onDraft({
      kind: keepDraft ? draft.kind : (submission?.kind ?? "text"),
      content: keepDraft ? draft.content : (submission?.content ?? ""),
      base: submission,
      snapshot: {
        kind: draft.kind,
        content: draft.content,
        review: draft.base,
      },
      requiresRefresh: false,
    });
    setError("");
    setNotice(
      keepDraft ? t("assignment.keptDraft") : t("assignment.usedLatest"),
    );
  }

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || inFlight.current || accepted || conflict || reviewChanged)
      return;
    const content = draft.content.trim();
    let validation = "";
    if (!content || content.length > limit) {
      validation = t(
        draft.kind === "text"
          ? "assignment.error.textLength"
          : "assignment.error.linkLength",
        { limit: formatNumber(limit, locale) },
      );
    } else if (draft.kind === "url") {
      try {
        const url = new URL(content);
        if (
          url.protocol !== "https:" ||
          !url.hostname ||
          url.username ||
          url.password ||
          /[\s\u0000-\u001f\u007f-\u009f]/u.test(draft.content)
        ) {
          validation = t("assignment.error.linkUnsafe");
        }
      } catch {
        validation = t("assignment.error.linkInvalid");
      }
    }
    if (validation) {
      setError(validation);
      contentField.current?.focus();
      return;
    }
    if (
      submission?.feedback &&
      (await confirm({
        title: t("assignment.resubmit.title"),
        body: <p>{t("assignment.resubmit.body")}</p>,
        confirmLabel: t("assignment.resubmit.confirm"),
        cancelLabel: t("common.cancel"),
      })) === null
    )
      return;
    inFlight.current = true;
    onPending(true);
    setOperation("submit");
    setError("");
    setNotice("");
    // Keep the exact input even if the response fails or access expires.
    onDraft(draft);
    try {
      const data = await studentRequest<LearningState>(
        "submit",
        {
          lessonId,
          revision: draft.base?.revision ?? null,
          kind: draft.kind,
          content,
        },
        enrollmentId,
      );
      const saved = data.submissions.find((item) => item.lessonId === lessonId);
      if (!saved) {
        throw new LearningError("UNAVAILABLE", t("assignment.unconfirmed"));
      }
      onDraft({
        kind: saved.kind,
        content: saved.content,
        base: saved,
        snapshot: draft.base
          ? { kind: draft.kind, content: draft.content, review: draft.base }
          : draft.snapshot,
        requiresRefresh: false,
      });
      onState(data);
      track(
        "assignment_submitted",
        { courseId: data.course.id, lessonId, attempt: saved.attempt },
        locale,
      );
      setNotice(t("assignment.submitted", { number: saved.attempt }));
    } catch (cause) {
      reportFailure(cause, t("assignment.submitFailed"));
    } finally {
      inFlight.current = false;
      onPending(false);
      setOperation(null);
    }
  }

  return (
    <section
      className="assignment"
      aria-labelledby={`assignment-heading-${lessonId}`}
      aria-busy={operation !== null}
    >
      <div className="assignment-heading">
        <div>
          <p className="eyebrow">{t("assignment.eyebrow")}</p>
          <h2 id={`assignment-heading-${lessonId}`}>
            {t("assignment.heading")}
          </h2>
        </div>
        <button
          className="button secondary small"
          type="button"
          disabled={pending}
          onClick={() => void refresh()}
        >
          {operation === "refresh"
            ? t("assignment.checking")
            : t("assignment.check")}
        </button>
      </div>
      <p className="muted">{t("assignment.intro")}</p>
      <div role="status" aria-live="polite">
        {notice && <InlineAlert tone="success">{notice}</InlineAlert>}
      </div>
      {error && (
        <div id={errorId}>
          <InlineAlert tone="danger">
            {error} {t("assignment.draftKept")}
          </InlineAlert>
        </div>
      )}
      {submission ? (
        <SavedSubmission t={t} locale={locale} submission={submission} />
      ) : (
        <p className="assignment-status">
          <StatusPill>{t("assignment.status.none")}</StatusPill>
        </p>
      )}
      {conflict && (
        <InlineAlert tone="warning">{t("assignment.conflict")}</InlineAlert>
      )}
      {reviewChanged && (
        <InlineAlert
          tone="info"
          title={t("assignment.reviewChanged")}
          action={
            !conflict && (
              <div className="actions">
                {!accepted && (
                  <button
                    className="button secondary small"
                    type="button"
                    disabled={pending}
                    onClick={() => reconcile(true)}
                  >
                    {t("assignment.keepDraft")}
                  </button>
                )}
                <button
                  className="button secondary small"
                  type="button"
                  disabled={pending}
                  onClick={() => reconcile(false)}
                >
                  {t("assignment.useLatest")}
                </button>
              </div>
            )
          }
        />
      )}
      {accepted ? (
        <>
          <InlineAlert tone="success">{t("assignment.accepted")}</InlineAlert>
          {dirty && (
            <label className="field">
              <span>
                {draft.kind === "url"
                  ? t("assignment.unsentLink")
                  : t("assignment.unsentText")}
              </span>
              <textarea readOnly rows={6} value={draft.content} />
              <small className="muted">
                {t("assignment.copyBeforeLeaving")}
              </small>
            </label>
          )}
        </>
      ) : (
        <form onSubmit={(event) => void submit(event)}>
          <fieldset className="assignment-fields" disabled={pending}>
            <legend>
              {submission ? t("assignment.revise") : t("assignment.share")}
            </legend>
            <div className="assignment-kinds">
              <label>
                <input
                  type="radio"
                  name={`assignment-kind-${lessonId}`}
                  value="text"
                  checked={draft.kind === "text"}
                  onChange={() => {
                    onDraft({ ...draft, kind: "text" });
                    setError("");
                  }}
                />{" "}
                {t("assignment.kind.text")}
              </label>
              <label>
                <input
                  type="radio"
                  name={`assignment-kind-${lessonId}`}
                  value="url"
                  checked={draft.kind === "url"}
                  onChange={() => {
                    onDraft({ ...draft, kind: "url" });
                    setError("");
                  }}
                />{" "}
                {t("assignment.kind.url")}
              </label>
            </div>
            <label className="field" htmlFor={fieldId}>
              <span>
                {draft.kind === "text"
                  ? t("assignment.response")
                  : t("assignment.link")}
              </span>
              {draft.kind === "text" ? (
                <textarea
                  id={fieldId}
                  ref={(node) => {
                    contentField.current = node;
                  }}
                  rows={7}
                  required
                  maxLength={limit}
                  value={draft.content}
                  aria-describedby={`${hintId}${error ? ` ${errorId}` : ""}`}
                  aria-invalid={!!error}
                  onChange={(event) => {
                    onDraft({ ...draft, content: event.target.value });
                    setError("");
                  }}
                />
              ) : (
                <input
                  id={fieldId}
                  ref={(node) => {
                    contentField.current = node;
                  }}
                  type="url"
                  inputMode="url"
                  autoCapitalize="none"
                  autoComplete="off"
                  spellCheck={false}
                  required
                  maxLength={limit}
                  value={draft.content}
                  placeholder="https://example.com/your-work"
                  aria-describedby={`${hintId}${error ? ` ${errorId}` : ""}`}
                  aria-invalid={!!error}
                  onChange={(event) => {
                    onDraft({ ...draft, content: event.target.value });
                    setError("");
                  }}
                />
              )}
              <small className="muted" id={hintId}>
                {t("assignment.characters", {
                  used: formatNumber(draft.content.length, locale),
                  limit: formatNumber(limit, locale),
                })}{" "}
                {draft.kind === "url"
                  ? t("assignment.linkHint")
                  : t("assignment.textHint", {
                      limit: formatNumber(limit, locale),
                    })}{" "}
                {dirty
                  ? t("assignment.unsentHint")
                  : t("assignment.noAutosave")}
              </small>
            </label>
            {submission && (
              <p className="muted assignment-meta">
                {t("assignment.resubmitNote")}
              </p>
            )}
            <button
              className="button"
              type="submit"
              disabled={pending || conflict || reviewChanged}
            >
              {operation === "submit"
                ? t("assignment.submitting")
                : submission
                  ? t("assignment.resubmitAction")
                  : t("assignment.submit")}
            </button>
          </fieldset>
        </form>
      )}
      {draft.snapshot && (
        <div className="assignment-snapshot">
          <Disclosure summary={t("assignment.snapshot.title")} defaultOpen>
            <p className="muted">{t("assignment.snapshot.body")}</p>
            <label className="field">
              <span>
                {draft.snapshot.kind === "url"
                  ? t("assignment.snapshot.link")
                  : t("assignment.snapshot.text")}
              </span>
              <textarea readOnly rows={4} value={draft.snapshot.content} />
            </label>
            {draft.snapshot.review && (
              <SavedSubmission
                t={t}
                locale={locale}
                submission={draft.snapshot.review}
              />
            )}
          </Disclosure>
        </div>
      )}
      {confirmDialog}
    </section>
  );
}
