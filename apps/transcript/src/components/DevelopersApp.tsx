import {
  ApiKeyDialog,
  ApiKeyRevokeDialog,
  AppShell,
  Badge,
  Button,
  Checkbox,
  CodeBlock,
  Dialog,
  Field,
  InlineNotice,
  type Locale,
  LocaleProvider,
  PageHeader,
  TextInput,
  ToastProvider,
  t,
  track,
  useToast,
} from "@templatedesign/ui";
import { useState } from "react";
import { PRICING } from "../lib/pricing-core";
import type { AuthUser, Profile } from "../lib/types";

interface WebhookEndpoint {
  id: string;
  url: string;
  events: string[];
  verifiedAt: string | null;
  disabledAt: string | null;
  failureCount: number;
  createdAt: string;
}

interface KeyMetadata {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  spendCapDaily: number | null;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

function nav(locale: Locale) {
  const vi = locale === "vi";
  return [
    { key: "dashboard", label: vi ? "Tổng quan" : "Dashboard", href: "/app", icon: "layout" as const },
    { key: "transcripts", label: vi ? "Bản ghi" : "Transcriptions", href: "/app/jobs", icon: "list" as const },
    { key: "credits", label: vi ? "Credit" : "Credits", href: "/app/credits", icon: "credit-card" as const },
    { key: "developers", label: vi ? "API" : "Developers", href: "/app/developers", icon: "key" as const },
    { key: "settings", label: vi ? "Cài đặt" : "Settings", href: "/app/settings", icon: "settings" as const },
  ];
}

function DevelopersInner({
  locale,
  user,
  profile,
  initialKeys,
  initialWebhooks,
  csrfToken,
  credits,
  embedded = false,
}: {
  locale: Locale;
  user: AuthUser;
  profile: Profile;
  initialKeys: KeyMetadata[];
  initialWebhooks: WebhookEndpoint[];
  csrfToken: string;
  credits: number;
  embedded?: boolean;
}) {
  const { push } = useToast();
  const tr = (key: Parameters<typeof t>[1]) => t(locale, key);
  const [keys, setKeys] = useState(initialKeys);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("n8n-prod");
  const [cap, setCap] = useState("200");
  const [scopes, setScopes] = useState<string[]>(["transcriptions:write", "transcriptions:read"]);
  const [testMode, setTestMode] = useState(false);
  const [webhooks, setWebhooks] = useState(initialWebhooks);
  const [hookOpen, setHookOpen] = useState(false);
  const [hookUrl, setHookUrl] = useState("");
  const [hookEvents, setHookEvents] = useState<string[]>(["transcription.completed", "transcription.failed"]);
  const [hookSecret, setHookSecret] = useState<{ secret: string; verified: boolean } | null>(null);
  const [hookError, setHookError] = useState<string>();
  const [hookBusy, setHookBusy] = useState(false);
  const [revealed, setRevealed] = useState<{ key: string; name: string } | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<KeyMetadata | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const refresh = async () => {
    const response = await fetch("/api/v1/api-keys");
    if (!response.ok) return;
    const body = (await response.json()) as { data: KeyMetadata[] };
    setKeys(body.data);
  };

  const create = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch("/api/v1/api-keys", {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({
          name,
          scopes,
          spendCapDaily: cap ? Number(cap) : null,
          livemode: !testMode,
        }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message ?? "Could not create the key.");
      }
      const body = (await response.json()) as { key: string; metadata: KeyMetadata };
      setKeys((current) => [body.metadata, ...current]);
      setCreateOpen(false);
      setRevealed({ key: body.key, name: body.metadata.name });
      track("api_key_created", { scopes: scopes.join(","), has_cap: Boolean(cap) });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create the key.");
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    if (!revokeTarget) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/v1/api-keys/${revokeTarget.id}`, {
        method: "DELETE",
        headers: { "x-csrf-token": csrfToken },
      });
      if (!response.ok) throw new Error("Could not revoke the key.");
      track("api_key_revoked", {});
      await refresh();
      push({ tone: "success", message: locale === "vi" ? "Đã thu hồi khoá" : "Key revoked" });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not revoke the key.");
    } finally {
      setBusy(false);
      setRevokeTarget(null);
    }
  };

  const refreshWebhooks = async () => {
    const response = await fetch("/api/v1/webhook-endpoints");
    if (!response.ok) return;
    const body = (await response.json()) as { data: WebhookEndpoint[] };
    setWebhooks(body.data);
  };

  const createWebhook = async () => {
    setHookBusy(true);
    setHookError(undefined);
    try {
      const response = await fetch("/api/v1/webhook-endpoints", {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ url: hookUrl, events: hookEvents }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        endpoint?: WebhookEndpoint;
        secret?: string;
        verified?: boolean;
        detail?: string;
      };
      if (!response.ok || !body.endpoint || !body.secret)
        throw new Error(body.detail ?? "Could not create the endpoint.");
      setWebhooks((current) => [body.endpoint!, ...current]);
      setHookOpen(false);
      setHookSecret({ secret: body.secret, verified: Boolean(body.verified) });
    } catch (caught) {
      setHookError(caught instanceof Error ? caught.message : "Could not create the endpoint.");
    } finally {
      setHookBusy(false);
    }
  };

  const verifyWebhook = async (id: string) => {
    setHookBusy(true);
    try {
      const response = await fetch(`/api/v1/webhook-endpoints/${id}/verify`, {
        method: "POST",
        headers: { "x-csrf-token": csrfToken },
      });
      if (!response.ok) throw new Error("Verification request failed.");
      await refreshWebhooks();
      push({ tone: "success", message: locale === "vi" ? "Đã gửi thử thách xác minh" : "Verification challenge sent" });
    } catch (caught) {
      setHookError(caught instanceof Error ? caught.message : "Verification failed.");
    } finally {
      setHookBusy(false);
    }
  };

  const testWebhook = async (id: string) => {
    setHookBusy(true);
    try {
      const response = await fetch(`/api/v1/webhook-endpoints/${id}/test`, {
        method: "POST",
        headers: { "x-csrf-token": csrfToken },
      });
      const body = (await response.json()) as { delivered: boolean; status: number | null };
      push({
        tone: body.delivered ? "success" : "error",
        message: body.delivered
          ? locale === "vi"
            ? "Đã gửi sự kiện thử"
            : "Test event delivered"
          : locale === "vi"
            ? `Endpoint trả về ${body.status ?? "lỗi mạng"}`
            : `Endpoint returned ${body.status ?? "a network error"}`,
      });
    } finally {
      setHookBusy(false);
    }
  };

  const deleteWebhook = async (id: string) => {
    setHookBusy(true);
    try {
      await fetch(`/api/v1/webhook-endpoints/${id}`, { method: "DELETE", headers: { "x-csrf-token": csrfToken } });
      await refreshWebhooks();
    } finally {
      setHookBusy(false);
    }
  };

  const createKey = (
    <Button
      variant="primary"
      iconLeft="key"
      disabled={!user.emailVerified}
      onClick={() => {
        setError(undefined);
        setCreateOpen(true);
      }}
    >
      {tr("key.title")}
    </Button>
  );

  const content = (
    <>
      {!user.emailVerified ? (
        <InlineNotice tone="warning" title={locale === "vi" ? "Xác minh email trước" : "Verify your email first"}>
          {locale === "vi"
            ? "Tài khoản chưa xác minh không thể tạo API key (403 forbidden, reason email_unverified)."
            : "An unverified account cannot create an API key (403 forbidden, reason email_unverified)."}
        </InlineNotice>
      ) : null}
      {error ? (
        <InlineNotice tone="danger" title={locale === "vi" ? "Có lỗi" : "Something went wrong"}>
          {error}
        </InlineNotice>
      ) : null}

      <dl className="st-summary">
        <div className="st-summary__item">
          <dt>{locale === "vi" ? "Credit khả dụng" : "Credit balance"}</dt>
          <dd>{credits}</dd>
        </div>
        <div className="st-summary__item">
          <dt>{locale === "vi" ? "Khoá đang hoạt động" : "Active keys"}</dt>
          <dd>{keys.filter((key) => !key.revokedAt).length}</dd>
        </div>
        <div className="st-summary__item">
          <dt>{locale === "vi" ? "Endpoint webhook" : "Webhook endpoints"}</dt>
          <dd>{webhooks.filter((hook) => !hook.disabledAt).length}</dd>
        </div>
      </dl>

      <div className="st-cols">
        <div className="st-cols__main">
          <section className="w-card">
            <div className="w-row w-row--between">
              <h2>{tr("api.keys")}</h2>
              <Button variant="secondary" size="sm" onClick={refresh}>
                {locale === "vi" ? "Làm mới" : "Refresh"}
              </Button>
            </div>
            {keys.length === 0 ? (
              <div className="w-empty">
                <p>{tr("empty.keys.title")}</p>
                <p className="td-muted">{tr("empty.keys.body")}</p>
              </div>
            ) : (
              <div className="td-table-wrap">
                <table className="td-table">
                  <caption className="td-visually-hidden">{tr("api.keys")}</caption>
                  <thead>
                    <tr>
                      <th scope="col">Name</th>
                      <th scope="col">Prefix</th>
                      <th scope="col">Scopes</th>
                      <th scope="col">Mode</th>
                      <th scope="col">Cap</th>
                      <th scope="col">Created</th>
                      <th scope="col">Status</th>
                      <th scope="col">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {keys.map((key) => (
                      <tr key={key.id}>
                        <th scope="row">{key.name}</th>
                        <td>
                          <code>{key.prefix}…</code>
                        </td>
                        <td>{key.scopes.join(", ")}</td>
                        <td>{key.prefix.startsWith("td_test_") ? "Test" : "Live"}</td>
                        <td className="td-table__numeric">{key.spendCapDaily ?? "—"}</td>
                        <td>{key.createdAt.slice(0, 10)}</td>
                        <td>
                          <Badge status={key.revokedAt ? "revoked" : "active"} />
                        </td>
                        <td>
                          {key.revokedAt ? null : (
                            <Button variant="danger-outline" size="sm" onClick={() => setRevokeTarget(key)}>
                              {tr("common.revoke")}
                            </Button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="w-card">
            <div className="w-row w-row--between">
              <h2>{locale === "vi" ? "Webhook" : "Webhooks"}</h2>
              <Button variant="secondary" size="sm" onClick={() => setHookOpen(true)}>
                {locale === "vi" ? "Thêm endpoint" : "Add endpoint"}
              </Button>
            </div>
            <p className="td-muted">
              {locale === "vi"
                ? "Nhận job.succeeded / job.failed đã ký HMAC. Endpoint phải công khai, HTTPS và xác minh thử thách."
                : "Receive HMAC-signed job.succeeded / job.failed events. Endpoints must be public HTTPS and echo the verification challenge."}
            </p>
            {hookError ? <InlineNotice tone="danger">{hookError}</InlineNotice> : null}
            {webhooks.length === 0 ? (
              <p className="td-muted">{locale === "vi" ? "Chưa có endpoint." : "No endpoints yet."}</p>
            ) : (
              <div className="td-table-wrap">
                <table className="td-table td-table--dense">
                  <thead>
                    <tr>
                      <th scope="col">URL</th>
                      <th scope="col">Events</th>
                      <th scope="col">Status</th>
                      <th scope="col">Failures</th>
                      <th scope="col">{tr("common.actions")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {webhooks.map((hook) => (
                      <tr key={hook.id}>
                        <th scope="row">
                          <code>{hook.url}</code>
                        </th>
                        <td>{hook.events.join(", ")}</td>
                        <td>
                          <Badge status={hook.disabledAt ? "revoked" : hook.verifiedAt ? "active" : "pending"} />
                        </td>
                        <td className="td-table__numeric">{hook.failureCount}</td>
                        <td>
                          <div className="w-row">
                            {!hook.verifiedAt && !hook.disabledAt ? (
                              <Button
                                variant="secondary"
                                size="sm"
                                loading={hookBusy}
                                onClick={() => verifyWebhook(hook.id)}
                              >
                                {locale === "vi" ? "Xác minh" : "Verify"}
                              </Button>
                            ) : null}
                            <Button
                              variant="tertiary"
                              size="sm"
                              loading={hookBusy}
                              onClick={() => testWebhook(hook.id)}
                            >
                              {locale === "vi" ? "Gửi thử" : "Send test"}
                            </Button>
                            <Button
                              variant="danger-outline"
                              size="sm"
                              loading={hookBusy}
                              onClick={() => deleteWebhook(hook.id)}
                            >
                              {tr("common.delete")}
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="w-card">
            <h2>{tr("api.quickstart")}</h2>
            <p className="td-muted">
              {locale === "vi"
                ? "Dùng placeholder $TD_API_KEY. Không bao giờ đặt khoá thật trong mã trình duyệt."
                : "Use the $TA_API_KEY placeholder. Never put a real key in browser code."}
            </p>
            <CodeBlock
              tabs={[
                {
                  id: "curl",
                  label: "cURL",
                  code: `curl https://transcriptanything.zhst.app/api/v1/transcriptions \\\n  -H "Authorization: Bearer $TA_API_KEY" \\\n  -H "Idempotency-Key: episode-0042" \\\n  -H "Content-Type: application/json" \\\n  -d '{"link":"https://www.youtube.com/watch?v=..."}'`,
                },
                {
                  id: "js",
                  label: "JavaScript",
                  code: `const res = await fetch("https://transcriptanything.zhst.app/api/v1/transcriptions", {\n  method: "POST",\n  headers: {\n    Authorization: \`Bearer \${process.env.TA_API_KEY}\`,\n    "Content-Type": "application/json",\n  },\n  body: JSON.stringify({ link, summary: { preset: "bullets" } }),\n});`,
                },
              ]}
            />
          </section>
        </div>

        <aside className="st-cols__side">
          <section className="w-card">
            <h2>{locale === "vi" ? "Giới hạn" : "Limits"}</h2>
            <dl className="w-facts">
              <div>
                <dt>{locale === "vi" ? "Phút trả phí mỗi tháng" : "Paid minutes / month"}</dt>
                <dd>{PRICING.monthlyCapMinutes}</dd>
              </div>
              <div>
                <dt>{locale === "vi" ? "Liên kết mỗi lô" : "Links per batch"}</dt>
                <dd>{PRICING.maxLinksPerBatch}</dd>
              </div>
              <div>
                <dt>{locale === "vi" ? "Phụ phí API" : "API surcharge"}</dt>
                <dd>+{PRICING.apiSurchargeCredits} credits</dd>
              </div>
              <div>
                <dt>{locale === "vi" ? "Bản ghi miễn phí mỗi ngày" : "Free transcriptions / day"}</dt>
                <dd>{PRICING.freeJobsPerDay.user}</dd>
              </div>
            </dl>
          </section>
          <section className="w-card">
            <h2>{locale === "vi" ? "Quyền riêng tư & dữ liệu" : "Privacy & data"}</h2>
            <dl className="w-facts">
              <div>
                <dt>{locale === "vi" ? "Tệp media" : "Source media"}</dt>
                <dd>{locale === "vi" ? "Xoá sau 24 giờ" : "Deleted after 24 hours"}</dd>
              </div>
              <div>
                <dt>{locale === "vi" ? "Bản ghi" : "Transcripts"}</dt>
                <dd>{locale === "vi" ? "Giữ 30 ngày" : "Kept for 30 days"}</dd>
              </div>
            </dl>
            <a href="/?account=settings">
              {locale === "vi" ? "Xuất hoặc xoá dữ liệu trong Cài đặt" : "Export or delete your data in Settings"}
            </a>
          </section>
        </aside>
      </div>

      <Dialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title={tr("key.title")}
        description={
          locale === "vi"
            ? "Khoá chỉ hiển thị một lần. Đặt hạn mức chi tiêu để giới hạn thiệt hại."
            : "The key is shown once. Set a spend cap to limit the blast radius."
        }
        footer={
          <>
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>
              {tr("common.cancel")}
            </Button>
            <Button variant="primary" loading={busy} onClick={create}>
              {tr("key.title")}
            </Button>
          </>
        }
      >
        <Field label={tr("key.name")} required>
          {(props) => <TextInput {...props} value={name} onChange={(event) => setName(event.target.value)} />}
        </Field>
        <Field
          label={tr("key.cap")}
          hint={locale === "vi" ? "Để trống nếu không giới hạn." : "Leave empty for no cap."}
        >
          {(props) => (
            <TextInput {...props} type="number" min={1} value={cap} onChange={(event) => setCap(event.target.value)} />
          )}
        </Field>
        <Checkbox
          label={
            locale === "vi"
              ? "Khoá test — miễn phí, 50 bản ghi/ngày, không tính credit"
              : "Test key — free, 50 transcriptions/day, no credits charged"
          }
          checked={testMode}
          onChange={(event) => setTestMode(event.target.checked)}
        />
        <fieldset className="td-fieldset">
          <legend className="td-field__label">{tr("key.scopes")}</legend>
          {[
            ["transcriptions:write", "Create transcriptions"],
            ["transcriptions:read", "Read transcriptions"],
          ].map(([scope, label]) => (
            <Checkbox
              key={scope}
              label={label}
              checked={scopes.includes(scope)}
              onChange={(event) =>
                setScopes((current) =>
                  event.target.checked ? [...current, scope] : current.filter((value) => value !== scope),
                )
              }
            />
          ))}
        </fieldset>
      </Dialog>

      <ApiKeyDialog
        open={Boolean(revealed)}
        onClose={() => setRevealed(null)}
        keyName={revealed?.name ?? "API key"}
        apiKey={revealed?.key ?? ""}
      />
      <ApiKeyRevokeDialog
        open={Boolean(revokeTarget)}
        onClose={() => setRevokeTarget(null)}
        name={revokeTarget?.name ?? ""}
        onConfirm={revoke}
      />

      <Dialog
        open={hookOpen}
        onClose={() => setHookOpen(false)}
        title={locale === "vi" ? "Thêm webhook" : "Add webhook"}
        description={
          locale === "vi"
            ? "Chỉ HTTPS công khai. Thử thách xác minh được gửi ngay."
            : "Public HTTPS only. A verification challenge is sent immediately."
        }
        footer={
          <>
            <Button variant="secondary" onClick={() => setHookOpen(false)}>
              {tr("common.cancel")}
            </Button>
            <Button variant="primary" loading={hookBusy} onClick={createWebhook}>
              {locale === "vi" ? "Thêm" : "Add"}
            </Button>
          </>
        }
      >
        <Field label="URL" required>
          {(props) => (
            <TextInput
              {...props}
              type="url"
              value={hookUrl}
              placeholder="https://your-app.com/hooks/transcriptanything"
              onChange={(event) => setHookUrl(event.target.value)}
            />
          )}
        </Field>
        <fieldset className="td-fieldset">
          <legend className="td-field__label">Events</legend>
          {["transcription.completed", "transcription.failed"].map((event) => (
            <Checkbox
              key={event}
              label={event}
              checked={hookEvents.includes(event)}
              onChange={(change) =>
                setHookEvents((current) =>
                  change.target.checked ? [...current, event] : current.filter((value) => value !== event),
                )
              }
            />
          ))}
        </fieldset>
      </Dialog>

      <Dialog
        open={Boolean(hookSecret)}
        onClose={() => setHookSecret(null)}
        title={locale === "vi" ? "Lưu secret ngay" : "Save the signing secret now"}
        description={
          locale === "vi"
            ? "Secret chỉ hiển thị một lần. Dùng nó để xác minh HMAC."
            : "This secret is shown once. Use it to verify HMAC signatures."
        }
        footer={
          <Button variant="primary" onClick={() => setHookSecret(null)}>
            {tr("common.close")}
          </Button>
        }
      >
        <CodeBlock tabs={[{ id: "secret", label: "Secret", code: hookSecret?.secret ?? "" }]} />
        <InlineNotice tone={hookSecret?.verified ? "success" : "warning"}>
          {hookSecret?.verified
            ? locale === "vi"
              ? "Endpoint đã xác minh."
              : "Endpoint verified."
            : locale === "vi"
              ? "Chưa xác minh: endpoint phải trả 2xx và echo data.challenge."
              : "Not verified: the endpoint must return 2xx and echo data.challenge."}
        </InlineNotice>
      </Dialog>
    </>
  );

  if (embedded) {
    return (
      <div className="ta-account">
        <p className="ta-account__actions">{createKey}</p>
        {content}
      </div>
    );
  }

  return (
    <AppShell
      brandName="TranscriptAnything"
      brandMark="TA"
      nav={nav(locale)}
      currentPath="/app/developers"
      credits={credits}
      locale={profile.uiLanguage}
      onLocaleChange={async (next) => {
        await fetch("/api/v1/settings", {
          method: "PATCH",
          headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
          body: JSON.stringify({ uiLanguage: next }),
        });
        window.location.reload();
      }}
      accountName={profile.displayName || user.name || user.email}
    >
      <PageHeader
        title={tr("api.title")}
        description={
          locale === "vi"
            ? "API key, quickstart và trạng thái xác minh email."
            : "API keys, quickstart and email verification state."
        }
        actions={createKey}
      />
      {content}
    </AppShell>
  );
}

export function DevelopersApp(props: {
  locale: Locale;
  user: AuthUser;
  profile: Profile;
  initialKeys: KeyMetadata[];
  initialWebhooks: WebhookEndpoint[];
  csrfToken: string;
  credits: number;
  /** Content only, for the account popups on the landing page. */
  embedded?: boolean;
}) {
  return (
    <LocaleProvider locale={props.locale}>
      <ToastProvider>
        <DevelopersInner {...props} />
      </ToastProvider>
    </LocaleProvider>
  );
}
