import { useCallback, useEffect, useState } from "react";
import { z } from "zod";
import { adminCall, dateLabel } from "./api.js";
import { useConfirm } from "./ui/confirm.js";
import { Failure } from "./shared.js";

const siteSchema = z.object({
  settings: z.object({
    siteId: z.string(),
    accentColor: z.string(),
    locales: z.array(z.enum(["vi", "en", "es"])),
    defaultLocale: z.enum(["vi", "en", "es"]),
    supportEmail: z.string(),
    legal: z.object({ termsUrl: z.string(), privacyUrl: z.string() }),
    emailFrom: z.object({
      name: z.string(),
      address: z.string(),
      replyTo: z.string(),
    }),
    selfSignup: z.boolean(),
    instructorsMayGrant: z.boolean(),
    passkeysEnabled: z.boolean(),
    dailySignInEmailCap: z.number(),
    features: z.record(z.string(), z.boolean()),
  }),
  revision: z.string().nullable(),
});
type Site = z.infer<typeof siteSchema>;
const reportSchema = z.object({
  report: z.object({
    scanned: z.number(),
    v1Enrollments: z.number(),
    distinctEmails: z.number(),
    studentsToCreate: z.number(),
    entitlementsToCreate: z.number(),
    migrated: z.number(),
    reverted: z.number(),
    conflicts: z.array(z.string()),
  }),
  cursor: z.string().nullable(),
});

/** Owner screens: site settings, account migration, audit log and email log. */
export function Operations({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<"site" | "migration" | "audit" | "email">(
    "site",
  );
  return (
    <section className="mt-panel" aria-labelledby="mt-ops-heading">
      <div className="mt-section-heading">
        <div>
          <p className="mt-eyebrow">Owner</p>
          <h2 id="mt-ops-heading">Site and records</h2>
        </div>
        <div className="mt-actions">
          {(["site", "migration", "audit", "email"] as const).map((name) => (
            <button
              key={name}
              type="button"
              className={tab === name ? "mt-primary" : ""}
              aria-pressed={tab === name}
              onClick={() => setTab(name)}
            >
              {
                {
                  site: "Settings",
                  migration: "Account upgrade",
                  audit: "Audit log",
                  email: "Email log",
                }[name]
              }
            </button>
          ))}
          <button type="button" onClick={onClose}>
            Back to courses
          </button>
        </div>
      </div>
      {tab === "site" && <SiteSettings />}
      {tab === "migration" && <Migration />}
      {tab === "audit" && <AuditLog />}
      {tab === "email" && <EmailLog />}
    </section>
  );
}

function SiteSettings() {
  const { action: confirmAction } = useConfirm();
  const [site, setSite] = useState<Site | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState("");
  const [testTo, setTestTo] = useState("");
  useEffect(() => {
    adminCall("site", {}, siteSchema).then(setSite, setError);
  }, []);
  if (!site)
    return (
      <>
        <Failure error={error} />
        {!error && <p role="status">Loading settings…</p>}
      </>
    );
  const s = site.settings;
  const set = (patch: Partial<Site["settings"]>) =>
    setSite({ ...site, settings: { ...s, ...patch } });
  async function save() {
    if (!site) return;
    setError(null);
    setNotice("");
    // Email sender and languages are high impact; the server asks for confirmation when they change.
    const confirmed = await confirmAction(
      "Save site settings. Changes to the email sender or languages are recorded.",
      site.settings.siteId,
    );
    if (!confirmed) return;
    try {
      setSite(
        await adminCall(
          "save-site",
          { revision: site.revision, value: site.settings, ...confirmed },
          siteSchema,
        ),
      );
      setNotice("Settings saved.");
    } catch (cause) {
      setError(cause);
    }
  }
  return (
    <div>
      <Failure error={error} />
      {notice && (
        <p className="mt-notice" role="status">
          {notice}
        </p>
      )}
      <p className="mt-muted">
        Site name, logo and time zone are edited in EmDash settings. Site ID:{" "}
        {s.siteId}
      </p>
      <div className="mt-grid">
        <label className="mt-field">
          <span>Support email</span>
          <input
            type="email"
            value={s.supportEmail}
            onChange={(event) => set({ supportEmail: event.target.value })}
          />
        </label>
        <label className="mt-field">
          <span>Email sender name</span>
          <input
            value={s.emailFrom.name}
            onChange={(event) =>
              set({ emailFrom: { ...s.emailFrom, name: event.target.value } })
            }
          />
        </label>
        <label className="mt-field">
          <span>Reply-to address</span>
          <input
            type="email"
            value={s.emailFrom.replyTo}
            onChange={(event) =>
              set({
                emailFrom: { ...s.emailFrom, replyTo: event.target.value },
              })
            }
          />
        </label>
        <label className="mt-field">
          <span>Default language</span>
          <select
            value={s.defaultLocale}
            onChange={(event) =>
              set({
                defaultLocale: event.target.value as "vi" | "en" | "es",
                locales: s.locales.includes(event.target.value as "vi")
                  ? s.locales
                  : [...s.locales, event.target.value as "vi"],
              })
            }
          >
            <option value="vi">Tiếng Việt</option>
            <option value="en">English</option>
            <option value="es">Español</option>
          </select>
        </label>
        <label className="mt-field">
          <span>Terms URL</span>
          <input
            value={s.legal.termsUrl}
            onChange={(event) =>
              set({ legal: { ...s.legal, termsUrl: event.target.value } })
            }
          />
        </label>
        <label className="mt-field">
          <span>Privacy URL</span>
          <input
            value={s.legal.privacyUrl}
            onChange={(event) =>
              set({ legal: { ...s.legal, privacyUrl: event.target.value } })
            }
          />
        </label>
        <label className="mt-field">
          <span>Sign-in emails per day (site cap)</span>
          <input
            type="number"
            min={1}
            max={100000}
            value={s.dailySignInEmailCap}
            onChange={(event) =>
              set({
                dailySignInEmailCap: Math.max(
                  1,
                  Math.trunc(Number(event.target.value) || 1),
                ),
              })
            }
          />
        </label>
      </div>
      <label className="mt-check">
        <input
          type="checkbox"
          checked={s.selfSignup}
          onChange={(event) => set({ selfSignup: event.target.checked })}
        />{" "}
        Anyone can create an account by email (they see an empty dashboard until
        given access)
      </label>
      <label className="mt-check">
        <input
          type="checkbox"
          checked={s.instructorsMayGrant}
          onChange={(event) =>
            set({ instructorsMayGrant: event.target.checked })
          }
        />{" "}
        Instructors may give and remove access in their courses
      </label>
      <div className="mt-actions">
        <button
          type="button"
          className="mt-primary"
          onClick={() => void save()}
        >
          Save settings
        </button>
      </div>
      <h3>Test email delivery</h3>
      <div className="mt-actions">
        <input
          type="email"
          aria-label="Send a test email to"
          value={testTo}
          onChange={(event) => setTestTo(event.target.value)}
        />
        <button
          type="button"
          disabled={!testTo}
          onClick={async () => {
            try {
              const sent = await adminCall(
                "test-email",
                { to: testTo },
                z.object({ status: z.string() }),
              );
              setNotice(
                sent.status === "sent"
                  ? "Test email sent."
                  : `Test email ${sent.status}. Check the email provider settings.`,
              );
            } catch (cause) {
              setError(cause);
            }
          }}
        >
          Send test
        </button>
      </div>
    </div>
  );
}

function Migration() {
  const { ask } = useConfirm();
  const [backupAt, setBackupAt] = useState("");
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  async function run(dryRun: boolean, revertToV1 = false) {
    if (!backupAt) return;
    if (
      !dryRun &&
      !(await ask({
        title: revertToV1
          ? "Revert linked invitations to the 0.2 format?"
          : "Link every 0.2 invitation to a student account now?",
        confirmLabel: revertToV1 ? "Revert" : "Link invitations",
        danger: revertToV1,
      }))
    )
      return;
    setPending(true);
    setError(null);
    const lines: string[] = [];
    try {
      let cursor: string | null = null;
      do {
        const page: z.infer<typeof reportSchema> = await adminCall(
          "migrate-accounts",
          {
            dryRun,
            ...(revertToV1 ? { revertToV1 } : {}),
            backupConfirmedAt: new Date(backupAt).toISOString(),
            ...(cursor ? { cursor } : {}),
          },
          reportSchema,
        );
        const r = page.report;
        lines.push(
          dryRun
            ? `Checked ${r.scanned}: ${r.v1Enrollments} to link, ${r.studentsToCreate} new accounts, ${r.entitlementsToCreate} access grants.`
            : revertToV1
              ? `Reverted ${r.reverted}.`
              : `Linked ${r.migrated}.`,
        );
        if (r.conflicts.length)
          lines.push(`Needs review: ${r.conflicts.length} record(s).`);
        cursor = page.cursor;
      } while (cursor);
      setLog(lines);
    } catch (cause) {
      setError(cause);
    } finally {
      setPending(false);
    }
  }
  return (
    <div>
      <p>
        Moves 0.2 invitation enrollments to student accounts so students can
        sign in on any device. Progress and assignments stay where they are.
        Revoked invitations get no access. Run a backup first and restore-test
        it.
      </p>
      <label className="mt-field">
        <span>
          When was the verified backup taken? (must be within 24 hours)
        </span>
        <input
          type="datetime-local"
          value={backupAt}
          onChange={(event) => setBackupAt(event.target.value)}
        />
      </label>
      <div className="mt-actions">
        <button
          type="button"
          disabled={!backupAt || pending}
          onClick={() => void run(true)}
        >
          Check (dry run)
        </button>
        <button
          type="button"
          className="mt-primary"
          disabled={!backupAt || pending}
          onClick={() => void run(false)}
        >
          Upgrade accounts
        </button>
        <button
          type="button"
          className="mt-danger"
          disabled={!backupAt || pending}
          onClick={() => void run(false, true)}
        >
          Revert (escape hatch)
        </button>
      </div>
      <Failure error={error} />
      {log.length > 0 && (
        <ul role="status">
          {log.map((line, index) => (
            <li key={index}>{line}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

const auditSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      at: z.string(),
      actor: z.object({ type: z.string(), label: z.string() }),
      action: z.string(),
      subject: z.object({ type: z.string(), id: z.string() }),
      reason: z.string(),
    }),
  ),
  cursor: z.string().nullable(),
});
function AuditLog() {
  const [items, setItems] = useState<z.infer<typeof auditSchema>["items"]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(async (from?: string) => {
    try {
      const page = await adminCall(
        "audit",
        from ? { cursor: from } : {},
        auditSchema,
      );
      setItems((current) => (from ? [...current, ...page.items] : page.items));
      setCursor(page.cursor);
    } catch (cause) {
      setError(cause);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <div>
      <Failure error={error} />
      <div className="mt-table-scroll">
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Who</th>
              <th>What</th>
              <th>Subject</th>
              <th>Reason</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td>{dateLabel(item.at)}</td>
                <td>
                  {item.actor.label} ({item.actor.type})
                </td>
                <td>{item.action}</td>
                <td>{item.subject.type}</td>
                <td>{item.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {cursor && (
        <button type="button" onClick={() => void load(cursor)}>
          Load older
        </button>
      )}
    </div>
  );
}

const emailSchema = z.array(
  z.object({
    id: z.string(),
    template: z.string(),
    recipient: z.string(),
    status: z.string(),
    attempts: z.number(),
    lastError: z.string(),
    createdAt: z.string(),
  }),
);
function EmailLog() {
  const [items, setItems] = useState<z.infer<typeof emailSchema> | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(async () => {
    try {
      setItems(await adminCall("notifications", {}, emailSchema));
    } catch (cause) {
      setError(cause);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <div>
      <Failure error={error} />
      <p className="mt-muted">
        Sign-in codes are never stored or resent. Failed messages can be queued
        again.
      </p>
      {items && (
        <div className="mt-table-scroll">
          <table>
            <thead>
              <tr>
                <th>Created</th>
                <th>Template</th>
                <th>To</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>{dateLabel(item.createdAt)}</td>
                  <td>{item.template}</td>
                  <td>{item.recipient}</td>
                  <td>
                    {item.status}
                    {item.lastError ? ` (${item.lastError})` : ""}
                  </td>
                  <td>
                    {item.status === "failed" &&
                      !["sign_in_code", "invitation"].includes(
                        item.template,
                      ) && (
                        <button
                          type="button"
                          onClick={async () => {
                            try {
                              await adminCall(
                                "resend-notification",
                                { notificationId: item.id },
                                z.unknown(),
                              );
                              await load();
                            } catch (cause) {
                              setError(cause);
                            }
                          }}
                        >
                          Send again
                        </button>
                      )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
