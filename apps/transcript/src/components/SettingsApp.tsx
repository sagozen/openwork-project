import {
  AppShell,
  Badge,
  Button,
  Dialog,
  Field,
  InlineNotice,
  LinkButton,
  type Locale,
  LocaleProvider,
  PageHeader,
  SegmentedControl,
  Select,
  ToastProvider,
  Toggle,
  t,
  track,
  useToast,
} from "@templatedesign/ui";
import { useMemo, useState } from "react";
import type { AuthUser, Profile } from "../lib/types";

interface Deletion {
  id: string;
  status: "requested" | "completed" | "failed";
  requestedAt: string;
  hardDeleteAt: string;
  creditsForfeited: number;
}

function nav(locale: Locale) {
  const tr = (key: Parameters<typeof t>[1]) => t(locale, key);
  return [
    { key: "dashboard", label: tr("nav.dashboard"), href: "/app", icon: "layout" as const },
    { key: "templates", label: tr("nav.templates"), href: "/app/templates", icon: "template" as const },
    { key: "jobs", label: tr("nav.jobs"), href: "/app/jobs", icon: "list" as const },
    { key: "credits", label: tr("nav.credits"), href: "/app/credits", icon: "credit-card" as const },
    { key: "developers", label: tr("nav.developers"), href: "/app/developers", icon: "key" as const },
    { key: "settings", label: tr("nav.settings"), href: "/app/settings", icon: "settings" as const },
  ];
}

function SettingsInner({
  locale,
  user,
  initialProfile,
  csrfToken,
  initialDeletion,
  credits,
  embedded = false,
}: {
  locale: Locale;
  user: AuthUser;
  initialProfile: Profile;
  csrfToken: string;
  initialDeletion: Deletion | null;
  credits: number;
  embedded?: boolean;
}) {
  const { push } = useToast();
  const tr = (key: Parameters<typeof t>[1]) => t(locale, key);
  const [profile, setProfile] = useState(initialProfile);
  const [form, setForm] = useState({
    displayName: initialProfile.displayName,
    uiLanguage: initialProfile.uiLanguage,
    docLanguage: initialProfile.docLanguage,
    defaultRetentionSeconds: String(initialProfile.defaultRetentionSeconds),
    numberLocale: initialProfile.numberLocale,
    dateLocale: initialProfile.dateLocale,
    lowBalanceEmail: initialProfile.lowBalanceEmail,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [savedAt, setSavedAt] = useState<string>();
  const [exportJob, setExportJob] = useState<{
    id: string;
    status: string;
    downloadUrl: string | null;
    expiresAt?: string | null;
  } | null>(null);
  const [exporting, setExporting] = useState(false);
  const [deletion, setDeletion] = useState(initialDeletion);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [localCleared, setLocalCleared] = useState(false);

  const headers = useMemo(() => ({ "content-type": "application/json", "x-csrf-token": csrfToken }), [csrfToken]);

  const save = async (event: { preventDefault: () => void }) => {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    try {
      const response = await fetch("/api/v1/settings", {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          displayName: form.displayName,
          uiLanguage: form.uiLanguage,
          docLanguage: form.docLanguage,
          defaultRetentionSeconds: Number(form.defaultRetentionSeconds),
          numberLocale: form.numberLocale,
          dateLocale: form.dateLocale,
          lowBalanceEmail: form.lowBalanceEmail,
        }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message ?? "Could not save settings.");
      }
      const body = (await response.json()) as { profile: Profile };
      setProfile(body.profile);
      setSavedAt(
        new Date().toLocaleTimeString(locale === "vi" ? "vi-VN" : "en-GB", { hour: "2-digit", minute: "2-digit" }),
      );
      track("settings_change", { setting: "profile" });
      push({ tone: "success", message: locale === "vi" ? "Đã lưu cài đặt" : "Settings saved" });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save settings.");
    } finally {
      setSaving(false);
    }
  };

  const changeLocale = async (next: Locale) => {
    if (next === "pseudo") return;
    setForm((value) => ({ ...value, uiLanguage: next }));
    await fetch("/api/v1/settings", { method: "PATCH", headers, body: JSON.stringify({ uiLanguage: next }) });
    window.location.reload();
  };

  const startExport = async () => {
    setExporting(true);
    setError(undefined);
    try {
      const response = await fetch("/api/v1/export", { method: "POST", headers });
      if (!response.ok) throw new Error("Could not start the export.");
      const job = (await response.json()) as { id: string; status: string; downloadUrl: string | null };
      setExportJob(job);
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 900));
        const poll = await fetch(`/api/v1/export/${job.id}`, { headers: { "x-csrf-token": csrfToken } });
        if (!poll.ok) break;
        const next = (await poll.json()) as { id: string; status: string; downloadUrl: string | null };
        setExportJob(next);
        if (next.status === "ready" || next.status === "failed") break;
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not start the export.");
    } finally {
      setExporting(false);
    }
  };

  const requestDeletion = async () => {
    track("account_delete_confirm", {});
    setDeleting(true);
    try {
      const response = await fetch("/api/v1/account/delete", { method: "POST", headers, body: "{}" });
      if (!response.ok) throw new Error("Could not request deletion.");
      const result = (await response.json()) as Deletion;
      setDeletion(result);
      setDeleteOpen(false);
      push({ tone: "warning", message: locale === "vi" ? "Đã yêu cầu xoá tài khoản" : "Account deletion requested" });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not request deletion.");
    } finally {
      setDeleting(false);
    }
  };

  const clearLocal = async () => {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith("td-")) localStorage.removeItem(key);
    }
    if ("indexedDB" in window) indexedDB.deleteDatabase("td-drafts");
    setLocalCleared(true);
    track("local_drafts_cleared", {});
    push({ tone: "success", message: locale === "vi" ? "Đã xoá dữ liệu cục bộ" : "Local data cleared" });
  };

  const content = (
    <>
      {error ? (
        <InlineNotice tone="danger" title={locale === "vi" ? "Không lưu được" : "Something went wrong"}>
          {error}
        </InlineNotice>
      ) : null}
      {deletion ? (
        <InlineNotice tone="warning" title={locale === "vi" ? "Đang chờ xoá tài khoản" : "Account deletion requested"}>
          {locale === "vi"
            ? `Phiên, API key, liên kết chia sẻ và webhook đã bị thu hồi ngay. Dữ liệu cá nhân sẽ bị xoá vào ${deletion.hardDeleteAt}.`
            : `Sessions, API keys, share links and webhooks were revoked immediately. Personal data will be deleted on ${deletion.hardDeleteAt}.`}
        </InlineNotice>
      ) : null}

      <form onSubmit={save} className="w-settings">
        <section className="w-card" id="profile">
          <h2>{locale === "vi" ? "Hồ sơ" : "Profile"}</h2>
          <div className="w-form-grid">
            <Field label={locale === "vi" ? "Tên hiển thị" : "Display name"} required>
              {(props) => (
                <input
                  id={props.id}
                  aria-describedby={props.describedBy}
                  aria-invalid={props.invalid || undefined}
                  className="td-input"
                  value={form.displayName}
                  onChange={(event) => setForm({ ...form, displayName: event.target.value })}
                />
              )}
            </Field>
            <Field
              label="Email"
              hint={
                locale === "vi"
                  ? "Email đăng nhập không thể đổi tại đây."
                  : "Your sign-in email cannot be changed here."
              }
            >
              {(props) => (
                <input
                  id={props.id}
                  aria-describedby={props.describedBy}
                  aria-invalid={props.invalid || undefined}
                  className="td-input"
                  value={user.email}
                  readOnly
                />
              )}
            </Field>
          </div>
          <p className="td-field__hint">
            {user.emailVerified ? (
              <Badge tone="success">{locale === "vi" ? "Email đã xác minh" : "Email verified"}</Badge>
            ) : (
              <Badge tone="warning">{locale === "vi" ? "Email chưa xác minh" : "Email not verified"}</Badge>
            )}
          </p>
        </section>

        <section className="w-card" id="language">
          <h2>{locale === "vi" ? "Ngôn ngữ và khu vực" : "Language and region"}</h2>
          <div className="w-form-grid">
            <Field label={locale === "vi" ? "Ngôn ngữ giao diện" : "Interface language"}>
              {() => (
                <SegmentedControl
                  label={locale === "vi" ? "Ngôn ngữ giao diện" : "Interface language"}
                  hideLabel
                  value={form.uiLanguage}
                  onChange={(value) => setForm({ ...form, uiLanguage: value as "en" | "vi" })}
                  options={[
                    { value: "en", label: "English" },
                    { value: "vi", label: "Tiếng Việt" },
                  ]}
                />
              )}
            </Field>
            <Field label={locale === "vi" ? "Ngôn ngữ tài liệu mặc định" : "Default document language"}>
              {() => (
                <SegmentedControl
                  label={locale === "vi" ? "Ngôn ngữ tài liệu" : "Document language"}
                  hideLabel
                  value={form.docLanguage}
                  onChange={(value) => setForm({ ...form, docLanguage: value as "en" | "vi" })}
                  options={[
                    { value: "en", label: "English" },
                    { value: "vi", label: "Tiếng Việt" },
                  ]}
                />
              )}
            </Field>
            <Field label={locale === "vi" ? "Giữ tệp mặc định" : "Default file retention"}>
              {(props) => (
                <Select
                  {...props}
                  value={form.defaultRetentionSeconds}
                  onChange={(event) => setForm({ ...form, defaultRetentionSeconds: event.target.value })}
                  options={[
                    { value: "3600", label: locale === "vi" ? "1 giờ" : "1 hour" },
                    { value: "86400", label: locale === "vi" ? "24 giờ" : "24 hours" },
                    { value: "604800", label: locale === "vi" ? "7 ngày" : "7 days" },
                    { value: "2592000", label: locale === "vi" ? "30 ngày" : "30 days" },
                  ]}
                />
              )}
            </Field>
            <Field label={locale === "vi" ? "Định dạng số" : "Number format"}>
              {(props) => (
                <Select
                  {...props}
                  value={form.numberLocale}
                  onChange={(event) => setForm({ ...form, numberLocale: event.target.value })}
                  options={[
                    { value: "en-US", label: "1,234.56 (en-US)" },
                    { value: "en-GB", label: "1,234.56 (en-GB)" },
                    { value: "vi-VN", label: "1.234,56 (vi-VN)" },
                  ]}
                />
              )}
            </Field>
            <Field label={locale === "vi" ? "Định dạng ngày" : "Date format"}>
              {(props) => (
                <Select
                  {...props}
                  value={form.dateLocale}
                  onChange={(event) => setForm({ ...form, dateLocale: event.target.value })}
                  options={[
                    { value: "en-GB", label: "21/10/2026 (en-GB)" },
                    { value: "en-US", label: "10/21/2026 (en-US)" },
                    { value: "vi-VN", label: "21/10/2026 (vi-VN)" },
                  ]}
                />
              )}
            </Field>
          </div>
          <Toggle
            label={locale === "vi" ? "Email khi số dư thấp" : "Low-balance email"}
            description={locale === "vi" ? "Gửi khi credit dưới 20." : "Send when credits drop below 20."}
            checked={form.lowBalanceEmail}
            onChange={(checked) => setForm({ ...form, lowBalanceEmail: checked })}
          />
          <div className="w-row w-row--end">
            {savedAt ? (
              <span className="td-field__hint">{locale === "vi" ? `Đã lưu ${savedAt}` : `Saved ${savedAt}`}</span>
            ) : null}
            <Button type="submit" variant="primary" loading={saving}>
              {locale === "vi" ? "Lưu thay đổi" : "Save changes"}
            </Button>
          </div>
        </section>
      </form>

      <section className="w-card" id="privacy">
        <h2>{locale === "vi" ? "Quyền riêng tư" : "Privacy"}</h2>
        <p className="td-muted">
          {locale === "vi"
            ? "Chúng tôi không lưu nội dung tài liệu trong dữ liệu phân tích."
            : "We never store document contents in analytics."}
        </p>
        <dl className="w-facts">
          <div>
            <dt>{locale === "vi" ? "Liên kết chia sẻ" : "Share links"}</dt>
            <dd>
              {locale === "vi"
                ? "Tối đa 30 ngày, không vượt quá thời gian giữ tệp."
                : "At most 30 days, never longer than the file retention."}
            </dd>
          </div>
          <div>
            <dt>{locale === "vi" ? "Bản xem trước" : "Previews"}</dt>
            <dd>
              {locale === "vi"
                ? "Miễn phí, có watermark, theo hạn mức ngày."
                : "Free, watermarked, under a daily quota."}
            </dd>
          </div>
          <div>
            <dt>{locale === "vi" ? "Dữ liệu cục bộ" : "Local data"}</dt>
            <dd>
              {locale === "vi"
                ? "Bản nháp trình duyệt không rời thiết bị cho đến khi bạn đăng nhập."
                : "Browser drafts stay on this device until you sign in."}
            </dd>
          </div>
        </dl>
        <div className="w-row">
          <Button variant="secondary" onClick={clearLocal}>
            {locale === "vi" ? "Xoá dữ liệu cục bộ" : "Clear local data"}
          </Button>
          {localCleared ? <span className="td-field__hint">{locale === "vi" ? "Đã xoá" : "Cleared"}</span> : null}
        </div>
      </section>

      <section className="w-card" id="export">
        <h2>{locale === "vi" ? "Xuất dữ liệu" : "Export your data"}</h2>
        <p className="td-muted">
          {locale === "vi"
            ? "ZIP gồm hồ sơ, tuỳ chọn, mẫu, tài nguyên, job, sổ cái CSV và metadata API key. Không có khoá bí mật."
            : "A ZIP with your profile, preferences, templates, assets, jobs, ledger CSV and API key metadata. No secrets."}
        </p>
        <div className="w-row">
          <Button variant="primary" onClick={startExport} loading={exporting}>
            {exportJob
              ? locale === "vi"
                ? "Xuất lại"
                : "Export again"
              : locale === "vi"
                ? "Tạo bản xuất"
                : "Create export"}
          </Button>
          {exportJob ? (
            <Badge
              status={exportJob.status === "ready" ? "succeeded" : exportJob.status === "failed" ? "failed" : "running"}
            />
          ) : null}
        </div>
        {exportJob?.downloadUrl ? (
          <p style={{ marginTop: 12 }}>
            <a className="td-btn td-btn--secondary td-btn--md" href={exportJob.downloadUrl}>
              {locale === "vi" ? "Tải ZIP" : "Download ZIP"}
            </a>
          </p>
        ) : null}
        {exportJob && exportJob.status !== "ready" ? (
          <p className="td-field__hint">
            {locale === "vi"
              ? "Bản xuất có sẵn trong 24 giờ. Bạn có thể rời trang và quay lại."
              : "Exports are available for 24 hours. You can leave this page and come back."}
          </p>
        ) : null}
      </section>

      <section className="w-card w-card--danger" id="danger">
        <h2>{locale === "vi" ? "Vùng nguy hiểm" : "Danger zone"}</h2>
        <p>
          {locale === "vi"
            ? "Xoá tài khoản sẽ thu hồi phiên, API key, liên kết chia sẻ và webhook ngay. Dữ liệu cá nhân bị xoá trong 30 ngày."
            : "Deleting your account revokes sessions, API keys, share links and webhooks immediately. Personal data is deleted within 30 days."}
        </p>
        <p className="td-field__hint">
          {locale === "vi"
            ? "Credit mua còn lại sẽ bị mất sau cảnh báo, trừ khi được hoàn theo chính sách."
            : "Remaining purchased credits are forfeited after an explicit warning unless a refund applies."}
        </p>
        <Button
          variant="danger"
          onClick={() => {
            track("account_delete_start", {});
            setDeleteOpen(true);
          }}
          disabled={Boolean(deletion)}
        >
          {deletion
            ? locale === "vi"
              ? "Đã yêu cầu xoá"
              : "Deletion requested"
            : locale === "vi"
              ? "Xoá tài khoản"
              : "Delete account"}
        </Button>
      </section>

      <Dialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title={locale === "vi" ? "Xoá tài khoản?" : "Delete your account?"}
        description={
          locale === "vi"
            ? `Nhập ${user.email} để xác nhận. Thao tác này không thể hoàn tác.`
            : `Type ${user.email} to confirm. This cannot be undone.`
        }
        destructive
        footer={
          <>
            <Button variant="secondary" onClick={() => setDeleteOpen(false)}>
              {tr("common.cancel")}
            </Button>
            <Button variant="danger" loading={deleting} disabled={confirmText !== user.email} onClick={requestDeletion}>
              {locale === "vi" ? "Xoá tài khoản" : "Delete account"}
            </Button>
          </>
        }
      >
        <Field label="Email">
          {(props) => (
            <input
              id={props.id}
              aria-describedby={props.describedBy}
              aria-invalid={props.invalid || undefined}
              className="td-input"
              value={confirmText}
              onChange={(event) => setConfirmText(event.target.value)}
              autoComplete="off"
            />
          )}
        </Field>
        <InlineNotice tone="warning">
          {locale === "vi"
            ? "API key và liên kết chia sẻ ngừng hoạt động ngay sau khi gửi."
            : "API keys and share links stop working as soon as you submit."}
        </InlineNotice>
      </Dialog>
    </>
  );

  if (embedded) return <div className="ta-account">{content}</div>;

  return (
    <AppShell
      brandName="TranscriptAnything"
      brandMark="TA"
      nav={nav(locale)}
      currentPath="/app/settings"
      credits={credits}
      locale={profile.uiLanguage}
      onLocaleChange={changeLocale}
      accountName={profile.displayName || user.name || user.email}
    >
      <PageHeader
        title={tr("nav.settings")}
        description={
          locale === "vi"
            ? "Hồ sơ, ngôn ngữ, quyền riêng tư và dữ liệu của bạn."
            : "Profile, language, privacy and your data."
        }
        actions={
          <LinkButton href="/app" variant="secondary" size="sm">
            {tr("common.back")}
          </LinkButton>
        }
      />
      {content}
    </AppShell>
  );
}

export function SettingsApp(props: {
  locale: Locale;
  user: AuthUser;
  initialProfile: Profile;
  csrfToken: string;
  initialDeletion: Deletion | null;
  credits: number;
  /** Content only, for the account popups on the landing page. */
  embedded?: boolean;
}) {
  return (
    <LocaleProvider locale={props.locale}>
      <ToastProvider>
        <SettingsInner {...props} />
      </ToastProvider>
    </LocaleProvider>
  );
}
