import { useCallback, useEffect, useState } from "react";
import { z } from "zod";
import type { CourseRecord } from "../model.js";
import { adminCall } from "./api.js";
import { useConfirm } from "./ui/confirm.js";
import { Failure } from "./shared.js";

const staffSchema = z.object({
  userId: z.string(),
  displayName: z.string(),
  email: z.string(),
  role: z.enum(["owner", "instructor", "assistant"]),
  courseIds: z.union([z.literal("all"), z.array(z.string())]),
  active: z.boolean(),
  revision: z.string(),
});
const listSchema = z.object({
  staff: z.array(staffSchema),
  users: z.array(
    z.object({
      id: z.string(),
      email: z.string(),
      name: z.string().nullable(),
      role: z.number(),
    }),
  ),
});
type Role = z.infer<typeof staffSchema>["role"];
const roleLabels: Record<Role, string> = {
  owner: "Owner: everything, including settings and access",
  instructor: "Instructor: edits and teaches assigned courses",
  assistant: "Assistant: reviews work in assigned courses",
};

/** Owner screen: who can use the workspace and for which courses. */
export function Team({
  courses,
  onClose,
}: {
  courses: CourseRecord[];
  onClose: () => void;
}) {
  const { action: confirmAction } = useConfirm();
  const [data, setData] = useState<z.infer<typeof listSchema> | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState("");
  const [draft, setDraft] = useState<{
    userId: string;
    role: Role;
    courseIds: string[];
  }>({ userId: "", role: "assistant", courseIds: [] });
  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await adminCall("staff", {}, listSchema));
    } catch (cause) {
      setError(cause);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  async function save() {
    const user = data?.users.find((item) => item.id === draft.userId);
    if (!user) return;
    const confirmed = await confirmAction(
      `Give ${user.email} the ${draft.role} role.`,
      user.email,
    );
    if (!confirmed) return;
    setError(null);
    try {
      const existing = data?.staff.find(
        (member) => member.userId === draft.userId,
      );
      await adminCall(
        "save-staff",
        {
          userId: draft.userId,
          revision: existing?.revision ?? null,
          role: draft.role,
          courseIds: draft.role === "owner" ? "all" : draft.courseIds,
          ...confirmed,
        },
        z.unknown(),
      );
      setNotice("Saved.");
      await load();
    } catch (cause) {
      setError(cause);
    }
  }
  return (
    <section className="mt-panel" aria-labelledby="mt-team-heading">
      <div className="mt-section-heading">
        <div>
          <p className="mt-eyebrow">Workspace access</p>
          <h2 id="mt-team-heading">Team</h2>
          <p className="mt-muted">
            Invite people through EmDash users first (Contributor or higher),
            then choose their role here. EmDash administrators without a role
            are treated as owners.
          </p>
        </div>
        <div className="mt-actions">
          <button type="button" onClick={onClose}>
            Back to courses
          </button>
        </div>
      </div>
      <Failure error={error} retry={() => void load()} />
      {notice && (
        <p className="mt-notice" role="status">
          {notice}
        </p>
      )}
      {!data ? (
        <p role="status">Loading the team…</p>
      ) : (
        <>
          <ul className="mt-media-list">
            {data.staff.map((member) => (
              <li key={member.userId}>
                <div>
                  <span
                    className={`mt-badge ${member.active ? "mt-badge-active" : ""}`}
                  >
                    {member.active ? member.role : "removed"}
                  </span>{" "}
                  <strong>{member.displayName}</strong>
                  <p className="mt-muted">
                    {member.email} ·{" "}
                    {member.courseIds === "all"
                      ? "All courses"
                      : `${member.courseIds.length} course(s)`}
                  </p>
                </div>
                {member.active && (
                  <button
                    type="button"
                    className="mt-danger"
                    onClick={async () => {
                      const confirmed = await confirmAction(
                        `Remove ${member.email} from the workspace.`,
                        member.email,
                      );
                      if (!confirmed) return;
                      try {
                        await adminCall(
                          "remove-staff",
                          { userId: member.userId, ...confirmed },
                          z.unknown(),
                        );
                        await load();
                      } catch (cause) {
                        setError(cause);
                      }
                    }}
                  >
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
          <div className="mt-media-form">
            <h3>Add or change a role</h3>
            <label className="mt-field">
              <span>EmDash user</span>
              <select
                value={draft.userId}
                onChange={(event) =>
                  setDraft({ ...draft, userId: event.target.value })
                }
              >
                <option value="">Choose a user</option>
                {data.users.map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.name ?? user.email} ({user.email})
                  </option>
                ))}
              </select>
            </label>
            <fieldset className="mt-field">
              <legend>Role</legend>
              {(Object.keys(roleLabels) as Role[]).map((role) => (
                <label key={role}>
                  <input
                    type="radio"
                    name="mt-role"
                    checked={draft.role === role}
                    onChange={() => setDraft({ ...draft, role })}
                  />{" "}
                  {roleLabels[role]}
                </label>
              ))}
            </fieldset>
            {draft.role !== "owner" && (
              <fieldset className="mt-field">
                <legend>Courses</legend>
                {courses.map((course) => (
                  <label key={course.id}>
                    <input
                      type="checkbox"
                      checked={draft.courseIds.includes(course.id)}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          courseIds: event.target.checked
                            ? [...draft.courseIds, course.id]
                            : draft.courseIds.filter((id) => id !== course.id),
                        })
                      }
                    />{" "}
                    {course.value.title || course.id}
                  </label>
                ))}
              </fieldset>
            )}
            <div className="mt-actions">
              <button
                type="button"
                className="mt-primary"
                disabled={!draft.userId}
                onClick={() => void save()}
              >
                Save role
              </button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
