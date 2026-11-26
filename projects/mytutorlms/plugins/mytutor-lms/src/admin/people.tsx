import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { z } from "zod";
import type { CourseRecord } from "../model.js";
import { adminCall, dateLabel } from "./api.js";
import { useConfirm } from "./ui/confirm.js";
import { Failure } from "./shared.js";

const profileSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  locale: z.string(),
  emailVerified: z.boolean(),
  createdAt: z.string(),
});
const entitlementSchema = z.object({
  id: z.string(),
  courseId: z.string(),
  source: z.string(),
  startsAt: z.string(),
  expiresAt: z.string().nullable(),
  status: z.enum(["active", "revoked"]),
  revokeReason: z.string(),
});
const detailSchema = z.object({
  profile: profileSchema.extend({ status: z.enum(["active", "disabled"]) }),
  entitlements: z.array(entitlementSchema),
  recentAudit: z.array(
    z.object({
      id: z.string(),
      at: z.string(),
      action: z.string(),
      reason: z.string(),
    }),
  ),
});
type Profile = z.infer<typeof profileSchema>;
type Detail = z.infer<typeof detailSchema>;

/** Student directory, one student's access, and manual grants. */
export function People({
  courses,
  canGrant,
  canManageStudents,
  onClose,
}: {
  courses: CourseRecord[];
  canGrant: boolean;
  canManageStudents: boolean;
  onClose: () => void;
}) {
  const { action: confirmAction } = useConfirm();
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<Profile[] | null>(null);
  const [selected, setSelected] = useState<Detail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState("");
  const [grant, setGrant] = useState({
    email: "",
    name: "",
    courseId: courses[0]?.id ?? "",
    expiresAt: "",
    source: "manual" as "manual" | "comp",
  });
  const title = (courseId: string) =>
    courses.find((course) => course.id === courseId)?.value.title || courseId;

  const search = useCallback(async () => {
    setError(null);
    try {
      const data = await adminCall(
        "students-directory",
        query ? { query } : {},
        z.object({ items: z.array(profileSchema) }),
      );
      setItems(data.items);
    } catch (cause) {
      setError(cause);
    }
  }, [query]);
  useEffect(() => {
    void search();
  }, []);
  async function open(studentId: string) {
    setError(null);
    try {
      setSelected(await adminCall("student", { studentId }, detailSchema));
    } catch (cause) {
      setError(cause);
    }
  }
  async function act(run: () => Promise<unknown>, done: string) {
    setError(null);
    setNotice("");
    try {
      await run();
      setNotice(done);
      if (selected) await open(selected.profile.id);
      await search();
    } catch (cause) {
      setError(cause);
    }
  }
  async function submitGrant(event: FormEvent) {
    event.preventDefault();
    const confirmed = await confirmAction(
      `Give ${grant.email} access to ${title(grant.courseId)}.`,
      grant.email,
    );
    if (!confirmed) return;
    void act(
      () =>
        adminCall(
          "grant",
          {
            studentEmail: grant.email,
            studentName: grant.name,
            courseId: grant.courseId,
            expiresAt: grant.expiresAt
              ? new Date(`${grant.expiresAt}T23:59:59`).toISOString()
              : null,
            source: grant.source,
            requestKey: crypto.randomUUID(),
            ...confirmed,
          },
          z.unknown(),
        ),
      "Access granted. The student receives an email when email is set up.",
    );
  }

  return (
    <section className="mt-panel" aria-labelledby="mt-people-heading">
      <div className="mt-section-heading">
        <div>
          <p className="mt-eyebrow">Students and access</p>
          <h2 id="mt-people-heading">Students</h2>
          <p className="mt-muted">
            Accounts, the courses they can open, and manual access.
          </p>
        </div>
        <div className="mt-actions">
          <button type="button" onClick={onClose}>
            Back to courses
          </button>
        </div>
      </div>
      <Failure error={error} />
      {notice && (
        <p className="mt-notice" role="status">
          {notice}
        </p>
      )}
      <form
        className="mt-actions"
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
      >
        <label className="mt-field">
          <span>Find by name or email</span>
          <input
            value={query}
            maxLength={254}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <button type="submit">Search</button>
      </form>
      {items === null ? (
        <p role="status">Loading students…</p>
      ) : items.length === 0 ? (
        <p className="mt-muted">No students yet.</p>
      ) : (
        <div className="mt-table-scroll">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Joined</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>{item.name}</td>
                  <td>
                    {item.email}
                    {item.emailVerified ? "" : " (not verified)"}
                  </td>
                  <td>{dateLabel(item.createdAt)}</td>
                  <td>
                    <button type="button" onClick={() => void open(item.id)}>
                      Open
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {selected && (
        <article
          className="mt-media-lesson"
          aria-label={`Student ${selected.profile.email}`}
        >
          <h3>
            {selected.profile.name} · {selected.profile.email}
          </h3>
          <p className="mt-muted">
            Account{" "}
            {selected.profile.status === "active" ? "active" : "disabled"}
          </p>
          <ul className="mt-media-list">
            {selected.entitlements.map((item) => (
              <li key={item.id}>
                <div>
                  <span
                    className={`mt-badge ${item.status === "active" ? "mt-badge-active" : ""}`}
                  >
                    {item.status === "active" ? "Active" : "Revoked"}
                  </span>{" "}
                  <strong>{title(item.courseId)}</strong>
                  <p className="mt-muted">
                    {item.source} · from {dateLabel(item.startsAt)}{" "}
                    {item.expiresAt
                      ? `until ${dateLabel(item.expiresAt)}`
                      : "· no end date"}
                    {item.revokeReason && ` · ${item.revokeReason}`}
                  </p>
                </div>
                {canGrant && item.status === "active" && (
                  <button
                    type="button"
                    className="mt-danger"
                    onClick={async () => {
                      const confirmed = await confirmAction(
                        `Remove access to ${title(item.courseId)}. Progress is kept.`,
                        selected.profile.email,
                      );
                      if (confirmed)
                        void act(
                          () =>
                            adminCall(
                              "revoke-entitlement",
                              { entitlementId: item.id, ...confirmed },
                              z.unknown(),
                            ),
                          "Access removed.",
                        );
                    }}
                  >
                    Remove access
                  </button>
                )}
              </li>
            ))}
          </ul>
          {canManageStudents && (
            <div className="mt-actions">
              <button
                type="button"
                onClick={async () => {
                  const confirmed = await confirmAction(
                    "Sign this student out on every device.",
                    selected.profile.email,
                  );
                  if (confirmed)
                    void act(
                      () =>
                        adminCall(
                          "sign-out-student",
                          { studentId: selected.profile.id, ...confirmed },
                          z.unknown(),
                        ),
                      "Signed out everywhere.",
                    );
                }}
              >
                Sign out everywhere
              </button>
              <button
                type="button"
                className="mt-danger"
                onClick={async () => {
                  const status =
                    selected.profile.status === "active"
                      ? "disabled"
                      : "active";
                  const confirmed = await confirmAction(
                    status === "disabled"
                      ? "Disable this account. The student is signed out and cannot sign in."
                      : "Enable this account again.",
                    selected.profile.email,
                  );
                  if (confirmed)
                    void act(
                      () =>
                        adminCall(
                          "update-student",
                          {
                            studentId: selected.profile.id,
                            status,
                            ...confirmed,
                          },
                          z.unknown(),
                        ),
                      status === "disabled"
                        ? "Account disabled."
                        : "Account enabled.",
                    );
                }}
              >
                {selected.profile.status === "active"
                  ? "Disable account"
                  : "Enable account"}
              </button>
            </div>
          )}
          {selected.recentAudit.length > 0 && (
            <details>
              <summary>Recent activity</summary>
              <ul>
                {selected.recentAudit.map((event) => (
                  <li key={event.id}>
                    {dateLabel(event.at)} · {event.action}
                    {event.reason ? ` · ${event.reason}` : ""}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </article>
      )}
      {canGrant && courses.length > 0 && (
        <form className="mt-media-form" onSubmit={submitGrant}>
          <h3>Give access</h3>
          <div className="mt-grid">
            <label className="mt-field">
              <span>Student email</span>
              <input
                type="email"
                required
                value={grant.email}
                onChange={(event) =>
                  setGrant({ ...grant, email: event.target.value })
                }
              />
            </label>
            <label className="mt-field">
              <span>Name (optional)</span>
              <input
                maxLength={160}
                value={grant.name}
                onChange={(event) =>
                  setGrant({ ...grant, name: event.target.value })
                }
              />
            </label>
            <label className="mt-field">
              <span>Course</span>
              <select
                value={grant.courseId}
                onChange={(event) =>
                  setGrant({ ...grant, courseId: event.target.value })
                }
              >
                {courses.map((course) => (
                  <option key={course.id} value={course.id}>
                    {course.value.title || course.id}
                  </option>
                ))}
              </select>
            </label>
            <label className="mt-field">
              <span>Access ends (optional)</span>
              <input
                type="date"
                value={grant.expiresAt}
                onChange={(event) =>
                  setGrant({ ...grant, expiresAt: event.target.value })
                }
              />
            </label>
            <label className="mt-field">
              <span>Type</span>
              <select
                value={grant.source}
                onChange={(event) =>
                  setGrant({
                    ...grant,
                    source: event.target.value as "manual" | "comp",
                  })
                }
              >
                <option value="manual">Manual (paid outside the site)</option>
                <option value="comp">Complimentary</option>
              </select>
            </label>
          </div>
          <div className="mt-actions">
            <button type="submit" className="mt-primary">
              Give access
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
