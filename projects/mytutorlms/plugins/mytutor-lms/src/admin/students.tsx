import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { CourseRecord, StudentView } from "../model.js";
import { api, dateLabel, progressFor, RequestError } from "./api.js";
import { Failure, useBlock } from "./shared.js";
import type { OnBlock } from "./shared.js";
import { useConfirm } from "./ui/confirm.js";

type Invitation = {
  name: string;
  email: string;
  link: string;
  expiresAt: string;
};

export function Students({
  course,
  onClose,
  onBlock,
}: {
  course: CourseRecord;
  onClose: () => void;
  onBlock: OnBlock;
}) {
  const { ask } = useConfirm();
  const [students, setStudents] = useState<StudentView[] | null>(null);
  const [currentCourse, setCurrentCourse] = useState(course);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [refresh, setRefresh] = useState(0);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [copyNotice, setCopyNotice] = useState("");
  const [copyFailed, setCopyFailed] = useState(false);
  const [copying, setCopying] = useState(false);
  const [inviteError, setInviteError] = useState<unknown>(null);
  const [revokeError, setRevokeError] = useState<unknown>(null);
  const [revokeTarget, setRevokeTarget] = useState<StudentView | null>(null);
  const [pending, setPending] = useState<"invite" | "revoke" | null>(null);
  const [notice, setNotice] = useState("");
  const busy = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const linkInput = useRef<HTMLInputElement>(null);
  const inviteForm = useRef<HTMLFormElement>(null);
  useBlock(
    Boolean(name || email || invitation),
    pending !== null || copying,
    onBlock,
  );
  useEffect(() => {
    heading.current?.focus();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError(null);
    async function load() {
      try {
        const [records, courses] = await Promise.all([
          api.students(course.id, controller.signal),
          api.courses(controller.signal),
        ]);
        if (controller.signal.aborted) return;
        const latest = courses.find((entry) => entry.id === course.id);
        if (!latest)
          throw new RequestError(
            "NOT_FOUND",
            "This course is no longer available. Return to the course list and refresh.",
          );
        setCurrentCourse(latest);
        setStudents(records);
        setLoading(false);
      } catch (cause) {
        if (controller.signal.aborted) return;
        setLoadError(cause);
        setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [course.id, refresh]);

  async function invite(event: FormEvent) {
    event.preventDefault();
    if (busy.current || loading || loadError || !students) return;
    setInviteError(null);
    setNotice("");
    const cleanName = name.trim();
    const cleanEmail = email.trim().toLowerCase();
    if (
      !cleanName ||
      cleanName.length > 160 ||
      cleanEmail.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)
    ) {
      setInviteError(
        new RequestError(
          "VALIDATION",
          "Enter a student name and valid email address.",
        ),
      );
      return;
    }
    const existing = students.find(
      (student) => student.email.trim().toLowerCase() === cleanEmail,
    );
    if (
      existing &&
      !(await ask({
        title: `Reissue access for ${existing.name}?`,
        body: `This invalidates the previous invitation for ${existing.email} and all existing sessions for this course. Their progress is kept. You must share the new link manually.`,
        confirmLabel: "Reissue access",
        danger: true,
      }))
    )
      return;
    if (
      invitation &&
      !(await ask({
        title: "Replace the invitation shown here?",
        body: "Save or copy the current link first; it cannot be retrieved later.",
        confirmLabel: "Replace invitation",
        danger: true,
      }))
    )
      return;
    busy.current = true;
    setPending("invite");
    try {
      const result = await api.invite(course.id, cleanName, cleanEmail);
      setInvitation({
        name: result.student.name,
        email: result.student.email,
        link: `${window.location.origin}/join#${result.token}`,
        expiresAt: result.expiresAt,
      });
      setCopyNotice("");
      setCopyFailed(false);
      setStudents((current) => [
        ...(current ?? []).filter(
          (student) => student.id !== result.student.id,
        ),
        result.student,
      ]);
      setName("");
      setEmail("");
      setNotice(
        existing
          ? "Access reissued. Previous invitations and sessions have been invalidated."
          : "Invitation created. No email has been sent.",
      );
      setRefresh((value) => value + 1);
      requestAnimationFrame(() => {
        linkInput.current?.focus();
        linkInput.current?.select();
      });
    } catch (cause) {
      setInviteError(cause);
    } finally {
      busy.current = false;
      setPending(null);
    }
  }
  async function copyLink() {
    if (!invitation || copying) return;
    setCopying(true);
    setCopyFailed(false);
    setCopyNotice("");
    try {
      if (!navigator.clipboard) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(invitation.link);
      setCopyNotice(
        "Link copied. Share it privately with this student; no email is sent automatically.",
      );
    } catch {
      setCopyFailed(true);
      setCopyNotice(
        "Could not copy automatically. Select the invitation link below and copy it manually.",
      );
      linkInput.current?.focus();
      linkInput.current?.select();
    } finally {
      setCopying(false);
    }
  }
  async function revoke(student: StudentView) {
    if (
      busy.current ||
      !(await ask({
        title: `Revoke access for ${student.name}?`,
        body: `${student.email} loses access to “${currentCourse.value.title}”. Their invitation and existing sessions stop working immediately. Their progress is kept.`,
        confirmLabel: "Revoke access",
        danger: true,
      }))
    )
      return;
    setRevokeTarget(student);
    setRevokeError(null);
    setNotice("");
    busy.current = true;
    setPending("revoke");
    try {
      await api.revoke(student.id);
      setStudents(
        (current) =>
          current?.map((entry) =>
            entry.id === student.id ? { ...entry, active: false } : entry,
          ) ?? null,
      );
      if (invitation?.email.toLowerCase() === student.email.toLowerCase()) {
        setInvitation(null);
        setCopyNotice("");
      }
      setNotice(
        `Access revoked for ${student.name}. Invitations and sessions are invalidated.`,
      );
      setRevokeTarget(null);
      setRefresh((value) => value + 1);
    } catch (cause) {
      setRevokeError(cause);
    } finally {
      busy.current = false;
      setPending(null);
    }
  }

  const disabled =
    pending !== null ||
    loading ||
    Boolean(loadError) ||
    students === null ||
    copying;
  return (
    <section className="mt-panel" aria-labelledby="mt-students-heading">
      <div className="mt-section-heading">
        <div>
          <p className="mt-eyebrow">Private cohort</p>
          <h2 id="mt-students-heading" ref={heading} tabIndex={-1}>
            Students · {currentCourse.value.title || "Untitled course"}
          </h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          disabled={pending !== null || copying}
        >
          Back to courses
        </button>
      </div>
      <p className="mt-muted">
        Invite each student personally, share their link privately, and follow
        their progress through the current curriculum.
      </p>
      {currentCourse.value.status === "draft" && (
        <p className="mt-notice">
          This course is a draft. Invitations do not publish a course; students
          can access its lessons only after it is published.
        </p>
      )}
      {notice && (
        <p className="mt-notice" role="status">
          {notice}
        </p>
      )}
      <div className="mt-invite-panel">
        <h3>Invite a student</h3>
        <p>
          Each invitation is single-use and expires after 7 days. No automatic
          emails are sent.
        </p>
        <form
          ref={inviteForm}
          onSubmit={(event) => {
            void invite(event);
          }}
          aria-busy={pending === "invite"}
        >
          <fieldset className="mt-unframed" disabled={disabled}>
            <legend className="mt-sr-only">Student invitation details</legend>
            <div className="mt-grid">
              <div className="mt-field">
                <label htmlFor="mt-student-name">Student name (required)</label>
                <input
                  id="mt-student-name"
                  name="name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  autoComplete="off"
                  required
                  maxLength={160}
                />
              </div>
              <div className="mt-field">
                <label htmlFor="mt-student-email">
                  Email address (required)
                </label>
                <input
                  id="mt-student-email"
                  name="email"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  required
                  maxLength={254}
                  aria-describedby="mt-reissue-warning"
                />
              </div>
            </div>
            <p id="mt-reissue-warning" className="mt-warning">
              Using an existing student’s email reissues their access for this
              course, invalidates previous invitations and sessions, and keeps
              their progress. Share the replacement link manually.
            </p>
            <button type="submit" className="mt-primary">
              {pending === "invite"
                ? "Creating invitation…"
                : "Create private invitation"}
            </button>
          </fieldset>
        </form>
        <Failure
          error={inviteError}
          retry={
            disabled ? undefined : () => inviteForm.current?.requestSubmit()
          }
          retryLabel="Retry invitation"
        />
        {Boolean(inviteError) && (
          <p className="mt-muted">
            If the previous request reached the server, retrying may issue a new
            invitation and invalidate its earlier link.
          </p>
        )}
      </div>
      {invitation && (
        <section
          className="mt-invitation"
          aria-labelledby="mt-invitation-heading"
        >
          <h3 id="mt-invitation-heading">
            Share this link with {invitation.name}
          </h3>
          <p>
            For <strong>{invitation.email}</strong>. Expires{" "}
            <strong>{dateLabel(invitation.expiresAt)}</strong> (7 days after
            issue), or immediately after its first use.
          </p>
          <p>
            This secret link is shown only now and cannot be retrieved later.
            Send it privately to the intended student; do not post it publicly.
            Nothing has been emailed.
          </p>
          <div className="mt-field">
            <label htmlFor="mt-invitation-link">One-time invitation link</label>
            <input
              id="mt-invitation-link"
              ref={linkInput}
              type="text"
              value={invitation.link}
              readOnly
              autoComplete="off"
              spellCheck={false}
              onFocus={(event) => event.currentTarget.select()}
            />
          </div>
          <div className="mt-actions">
            <button
              type="button"
              className="mt-primary"
              disabled={copying || pending !== null}
              onClick={() => {
                void copyLink();
              }}
            >
              {copying ? "Copying…" : "Copy invitation link"}
            </button>
            <button
              type="button"
              disabled={copying || pending !== null}
              onClick={async () => {
                if (
                  !(await ask({
                    title: "Have you saved or shared this invitation link?",
                    body: "It cannot be retrieved after you dismiss it.",
                    confirmLabel: "Dismiss link",
                    danger: true,
                  }))
                )
                  return;
                setInvitation(null);
                setCopyNotice("");
                setCopyFailed(false);
              }}
            >
              I have saved the link
            </button>
          </div>
          {copyNotice && (
            <p
              className={copyFailed ? "mt-field-error" : "mt-notice"}
              role={copyFailed ? "alert" : "status"}
            >
              {copyNotice}
            </p>
          )}
        </section>
      )}
      <div className="mt-section-heading">
        <div>
          <h3>Enrollment and progress</h3>
          <p className="mt-muted">
            Completions are counted against this course’s current lesson IDs.
            Removed lessons never inflate progress.
          </p>
        </div>
        <button
          type="button"
          disabled={loading || pending !== null}
          onClick={() => setRefresh((value) => value + 1)}
        >
          {loading ? "Refreshing…" : "Refresh students"}
        </button>
      </div>
      <Failure
        error={loadError}
        retry={() => setRefresh((value) => value + 1)}
        retryLabel="Retry student list"
      />
      {loading && (
        <p role="status">Loading current student access and progress…</p>
      )}
      {Boolean(loadError) && students && (
        <p className="mt-warning">
          The table shows the last successful response. Refresh before making
          further access changes.
        </p>
      )}
      <Failure
        error={revokeError}
        retry={
          !disabled && revokeTarget
            ? () => {
                void revoke(revokeTarget);
              }
            : undefined
        }
        retryLabel="Retry revocation"
      />
      {students !== null && students.length === 0 && !loading && !loadError && (
        <div className="mt-empty">
          <h4>No students invited yet</h4>
          <p>
            Create your first private invitation above. Students will appear
            here after you invite them.
          </p>
        </div>
      )}
      {students !== null && students.length > 0 && (
        <div
          className="mt-table-scroll"
          role="region"
          aria-label="Student enrollment and progress table"
          tabIndex={0}
          aria-busy={loading}
        >
          <table>
            <caption>
              {students.length} {students.length === 1 ? "student" : "students"}{" "}
              · {currentCourse.value.lessons.length} current{" "}
              {currentCourse.value.lessons.length === 1 ? "lesson" : "lessons"}
            </caption>
            <thead>
              <tr>
                <th scope="col">Student</th>
                <th scope="col">Access</th>
                <th scope="col">Progress</th>
                <th scope="col">Last activity</th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {students.map((student) => {
                const progress = progressFor(student, currentCourse.value);
                return (
                  <tr key={student.id}>
                    <th scope="row">
                      {student.name}
                      <small>{student.email}</small>
                      <small>Invited {dateLabel(student.invitedAt)}</small>
                    </th>
                    <td>
                      <span
                        className={`mt-badge ${student.active ? "mt-badge-active" : ""}`}
                      >
                        {student.active ? "Active" : "Revoked"}
                      </span>
                    </td>
                    <td>
                      <strong>{progress.percentage}%</strong>
                      <small>
                        {progress.completed} of {progress.total} lessons
                        completed
                      </small>
                      <progress
                        max={100}
                        value={progress.percentage}
                        aria-label={`${student.name}: ${progress.completed} of ${progress.total} current lessons completed`}
                      />
                    </td>
                    <td>
                      {student.lastActiveAt ? (
                        <time dateTime={student.lastActiveAt}>
                          {dateLabel(student.lastActiveAt)}
                        </time>
                      ) : (
                        "No activity yet"
                      )}
                    </td>
                    <td>
                      {student.active ? (
                        <button
                          type="button"
                          className="mt-danger"
                          disabled={disabled}
                          aria-label={`Revoke access for ${student.name}`}
                          onClick={() => {
                            void revoke(student);
                          }}
                        >
                          {pending === "revoke" &&
                          revokeTarget?.id === student.id
                            ? "Revoking…"
                            : "Revoke access"}
                        </button>
                      ) : (
                        <span className="mt-muted">
                          Invite again to restore
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-muted">
        Active means access has not been revoked; it does not mean the student
        has accepted an invitation or is online. Last activity is shown in your
        local time.
      </p>
    </section>
  );
}
