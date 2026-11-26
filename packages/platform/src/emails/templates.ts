import { platformConfig } from "../config";
import type { Locale } from "../types";

export type EmailTemplate =
  | "magic_link"
  | "sign_in_code"
  | "welcome"
  | "invitation"
  | "key_created"
  | "key_revoked"
  | "deletion_requested"
  | "deletion_completed"
  | "webhook_disabled"
  | "billing_alert"
  | "worker_alert"
  | "abuse_alert"
  | "ops_notice"
  | "product_notice"
  | "digest";

export interface EmailContent {
  subject: string;
  html: string;
  text: string;
  links: string[];
}

interface Copy {
  subject: string;
  heading: string;
  body: string[];
  action?: string;
  footnote: string;
  /** Marketing footer: a clickable unsubscribe link and the sender's postal address. */
  unsubscribeUrl?: string;
  address?: string;
  /** A letter-style message: no brand header, heading or button. */
  plain?: boolean;
}

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

function layout(copy: Copy, url?: string, appUrl?: string): EmailContent {
  const brand = platformConfig().brand;
  const action = copy.action && url ? `<p><a href="${escapeHtml(url)}">${escapeHtml(copy.action)}</a></p>` : "";
  const footer = appUrl ? `<p><a href="${escapeHtml(appUrl)}">${escapeHtml(brand.name)}</a></p>` : "";
  const unsubscribe = copy.unsubscribeUrl
    ? `<p style="font-size:12px;color:#57534A;margin:8px 0 0"><a href="${escapeHtml(copy.unsubscribeUrl)}" style="color:#57534A">Unsubscribe</a></p>`
    : "";
  const address = copy.address
    ? `<p style="font-size:12px;color:#57534A;margin:8px 0 0">${escapeHtml(copy.address)}</p>`
    : "";
  const html = copy.plain
    ? `<!doctype html>
<html lang="en">
<body style="margin:0;background:#FFFFFF;color:#1A1915;font-family:Arial,sans-serif;line-height:1.6">
  <div style="max-width:560px;padding:24px">
    ${copy.body.map((paragraph) => `<p style="margin:0 0 12px">${escapeHtml(paragraph)}</p>`).join("")}
    <p style="font-size:12px;color:#57534A;margin:24px 0 0">${escapeHtml(copy.footnote)}</p>
    ${address}
    ${unsubscribe}
  </div>
</body>
</html>`
    : `<!doctype html>
<html lang="en">
<body style="margin:0;background:#FAF8F4;color:#1A1915;font-family:Arial,sans-serif;line-height:1.6">
  <div style="max-width:560px;margin:0 auto;padding:32px 24px">
    <p style="font-family:Georgia,serif;font-size:20px;margin:0 0 24px">${escapeHtml(brand.name)}</p>
    <h1 style="font-size:22px;line-height:1.3;margin:0 0 16px">${escapeHtml(copy.heading)}</h1>
    ${copy.body.map((paragraph) => `<p style="margin:0 0 12px">${escapeHtml(paragraph)}</p>`).join("")}
    ${action}
    <hr style="border:0;border-top:1px solid #DCD6CB;margin:24px 0" />
    <p style="font-size:12px;color:#57534A;margin:0">${escapeHtml(copy.footnote)}</p>
    ${address}
    ${unsubscribe}
    ${footer}
  </div>
</body>
</html>`;
  const text = `${copy.plain ? "" : `${copy.heading}\n\n`}${copy.body.join("\n\n")}${url ? `\n\n${copy.action ?? "Open"}: ${url}` : ""}\n\n${copy.footnote}${copy.address ? `\n${copy.address}` : ""}${copy.unsubscribeUrl ? `\nUnsubscribe: ${copy.unsubscribeUrl}` : ""}${appUrl ? `\n\n${appUrl}` : ""}\n`;
  const links = [url, appUrl, copy.unsubscribeUrl].filter((value): value is string => Boolean(value));
  return { subject: copy.subject, html, text, links };
}

/** One section of a `digest` email: a heading and a list of linked items. */
export interface DigestSection {
  title: string;
  items: Array<{ title: string; url: string; meta?: string; excerpt?: string }>;
}

function parseSections(raw: unknown): DigestSection[] {
  try {
    const parsed = JSON.parse(String(raw ?? "[]")) as DigestSection[];
    return Array.isArray(parsed) ? parsed.filter((section) => Array.isArray(section?.items)) : [];
  } catch {
    return [];
  }
}

/**
 * A summary email with linked sections, for example replies and new posts. The app composes every
 * string; `sections` is a JSON array of `DigestSection`, so the outbox payload can be replayed.
 */
function renderDigest(data: Record<string, string | number>, appUrl: string): EmailContent {
  const brand = platformConfig().brand;
  const sections = parseSections(data.sections);
  const intro = String(data.intro ?? "");
  const manageUrl = data.manageUrl ? String(data.manageUrl) : undefined;
  const unsubscribeUrl = data.unsubscribeUrl ? String(data.unsubscribeUrl) : undefined;
  const manageLabel = String(data.manageLabel ?? "Email settings");
  const unsubscribeLabel = String(data.unsubscribeLabel ?? "Unsubscribe");
  const footnote = String(data.footnote ?? brand.name);
  const sectionHtml = sections
    .map(
      (section) => `<h2 style="font-size:16px;margin:24px 0 8px">${escapeHtml(section.title)}</h2>
    <ul style="list-style:none;padding:0;margin:0">${section.items
      .map(
        (item) => `<li style="margin:0 0 12px">
        <a href="${escapeHtml(item.url)}" style="color:#1A1915;font-weight:bold">${escapeHtml(item.title)}</a>${
          item.meta ? `<br /><span style="font-size:12px;color:#57534A">${escapeHtml(item.meta)}</span>` : ""
        }${item.excerpt ? `<br /><span style="font-size:14px">${escapeHtml(item.excerpt)}</span>` : ""}
      </li>`,
      )
      .join("")}</ul>`,
    )
    .join("");
  const footerLinks = [
    manageUrl ? `<a href="${escapeHtml(manageUrl)}" style="color:#57534A">${escapeHtml(manageLabel)}</a>` : "",
    unsubscribeUrl
      ? `<a href="${escapeHtml(unsubscribeUrl)}" style="color:#57534A">${escapeHtml(unsubscribeLabel)}</a>`
      : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const html = `<!doctype html>
<html lang="en">
<body style="margin:0;background:#FAF8F4;color:#1A1915;font-family:Arial,sans-serif;line-height:1.5">
  <div style="max-width:560px;margin:0 auto;padding:32px 24px">
    <p style="font-family:Georgia,serif;font-size:20px;margin:0 0 16px"><a href="${escapeHtml(appUrl)}" style="color:#1A1915;text-decoration:none">${escapeHtml(brand.name)}</a></p>
    <h1 style="font-size:22px;line-height:1.3;margin:0 0 8px">${escapeHtml(String(data.heading ?? data.subject ?? brand.name))}</h1>
    ${intro ? `<p style="margin:0 0 8px">${escapeHtml(intro)}</p>` : ""}
    ${sectionHtml}
    <hr style="border:0;border-top:1px solid #DCD6CB;margin:24px 0" />
    <p style="font-size:12px;color:#57534A;margin:0">${escapeHtml(footnote)}</p>
    ${footerLinks ? `<p style="font-size:12px;color:#57534A;margin:8px 0 0">${footerLinks}</p>` : ""}
  </div>
</body>
</html>`;
  const textSections = sections
    .map(
      (section) =>
        `${section.title}\n\n${section.items
          .map((item) => [`- ${item.title}`, item.meta, item.excerpt, item.url].filter(Boolean).join("\n  "))
          .join("\n\n")}`,
    )
    .join("\n\n");
  const text = `${String(data.heading ?? data.subject ?? brand.name)}\n\n${intro ? `${intro}\n\n` : ""}${textSections}\n\n${footnote}${
    manageUrl ? `\n${manageLabel}: ${manageUrl}` : ""
  }${unsubscribeUrl ? `\n${unsubscribeLabel}: ${unsubscribeUrl}` : ""}\n`;
  const links = [
    appUrl,
    ...sections.flatMap((section) => section.items.map((item) => item.url)),
    manageUrl,
    unsubscribeUrl,
  ].filter((value): value is string => Boolean(value));
  return { subject: String(data.subject ?? brand.name), html, text, links };
}

export function renderEmail(
  template: EmailTemplate,
  locale: Locale,
  data: Record<string, string | number>,
  appUrl = platformConfig().brand.appOrigin,
): EmailContent {
  const en = locale === "en";
  const brand = platformConfig();
  const name = brand.brand.name;
  const developersUrl = `${appUrl}${brand.brand.developersPath ?? "/app/developers"}`;
  const settingsUrl = `${appUrl}${brand.brand.settingsPath ?? "/app/settings"}#export`;
  const reconciliationUrl = `${appUrl}${brand.brand.reconciliationPath ?? "/admin/reconciliation/"}`;
  switch (template) {
    case "magic_link":
      return layout(
        {
          subject: en ? `Your ${name} sign-in link` : `Liên kết đăng nhập ${name}`,
          heading: en ? `Sign in to ${name}` : `Đăng nhập ${name}`,
          body: [
            en
              ? `Use this link to sign in. It expires in ${data.expiresMinutes ?? 15} minutes and works once.`
              : `Dùng liên kết này để đăng nhập. Liên kết hết hạn sau ${data.expiresMinutes ?? 15} phút và chỉ dùng một lần.`,
            en
              ? "If you didn't ask for this, you can ignore the email."
              : "Nếu bạn không yêu cầu, hãy bỏ qua email này.",
          ],
          action: en ? "Sign in" : "Đăng nhập",
          footnote: en
            ? `${name} will never ask for your password by email.`
            : `${name} không bao giờ hỏi mật khẩu qua email.`,
        },
        String(data.url ?? ""),
        appUrl,
      );
    case "sign_in_code": {
      const code = String(data.code ?? "");
      return layout(
        {
          subject: en ? `Your ${name} sign-in code: ${code}` : `Mã đăng nhập ${name}: ${code}`,
          heading: en ? `Sign in to ${name}` : `Đăng nhập ${name}`,
          body: [
            en
              ? `Enter this code on the sign-in page: ${code}`
              : `Nhập mã này vào trang đăng nhập: ${code}`,
            en
              ? `The code expires in ${data.expiresMinutes ?? 10} minutes and works once.`
              : `Mã hết hạn sau ${data.expiresMinutes ?? 10} phút và chỉ dùng một lần.`,
            en
              ? "If you didn't ask for this, you can ignore the email."
              : "Nếu bạn không yêu cầu, hãy bỏ qua email này.",
          ],
          footnote: en
            ? `${name} will never ask for your password by email.`
            : `${name} không bao giờ hỏi mật khẩu qua email.`,
        },
        undefined,
        appUrl,
      );
    }
    case "welcome":
      return layout(
        {
          subject: en ? `Welcome to ${name}` : `Chào mừng đến ${name}`,
          heading: en ? "Your account is ready" : "Tài khoản của bạn đã sẵn sàng",
          body: [...brand.copy.welcomeBody[locale]],
          action: en ? `Open ${name}` : `Mở ${name}`,
          footnote: en
            ? "Free credits reset on the 1st of each month (UTC)."
            : "Credit miễn phí làm mới vào ngày 1 mỗi tháng (UTC).",
        },
        String(data.url ?? appUrl),
        appUrl,
      );
    case "invitation":
      return layout(
        {
          subject: en
            ? `Join ${data.restaurant ?? "the restaurant"} on ${name}`
            : `Lời mời vào ${data.restaurant ?? "quán"} trên ${name}`,
          heading: en
            ? `You are invited to ${data.restaurant ?? "a restaurant"}`
            : `Bạn được mời vào ${data.restaurant ?? "quán"}`,
          body: [
            en
              ? `${data.inviter ?? "The owner"} invited you to work as ${data.role ?? "staff"} at ${data.branch ?? "a branch"}. Open the link, then ask for a sign-in link for this address; the account is created on first sign-in.`
              : `${data.inviter ?? "Chủ quán"} mời bạn làm ${data.role ?? "nhân viên"} ở ${data.branch ?? "một chi nhánh"}. Mở liên kết rồi bấm nhận đường dẫn đăng nhập cho địa chỉ này; tài khoản được tạo ngay lần đăng nhập đầu.`,
            en
              ? `The link expires in ${data.days ?? 7} days. If you were not expecting this, you can ignore the email.`
              : `Liên kết hết hạn sau ${data.days ?? 7} ngày. Nếu bạn không chờ lời mời này, hãy bỏ qua email.`,
          ],
          action: en ? "Join the restaurant" : "Vào quán",
          footnote: en
            ? `${name} will never ask for your password by email.`
            : `${name} không bao giờ hỏi mật khẩu qua email.`,
        },
        String(data.url ?? ""),
        appUrl,
      );
    case "key_created":
      return layout(
        {
          subject: en ? "An API key was created" : "Một API key đã được tạo",
          heading: en ? "API key created" : "Đã tạo API key",
          body: [
            en
              ? `A key named “${data.keyName ?? "API key"}” was created for your account. The key itself is never included in email.`
              : `Một khoá tên “${data.keyName ?? "API key"}” đã được tạo cho tài khoản của bạn. Khoá không bao giờ được gửi trong email.`,
            en
              ? "If this wasn't you, revoke it and sign out everywhere."
              : "Nếu không phải bạn, hãy thu hồi khoá và đăng xuất mọi nơi.",
          ],
          action: en ? "Review API keys" : "Xem API key",
          footnote: en ? "Never put an API key in browser code." : "Không đặt API key trong mã chạy trên trình duyệt.",
        },
        `${developersUrl}`,
        appUrl,
      );
    case "key_revoked":
      return layout(
        {
          subject: en ? "An API key was revoked" : "Một API key đã bị thu hồi",
          heading: en ? "API key revoked" : "Đã thu hồi API key",
          body: [
            en
              ? `The key named “${data.keyName ?? "API key"}” no longer works.`
              : `Khoá tên “${data.keyName ?? "API key"}” không còn hoạt động.`,
            en
              ? "If this wasn't you, create a new key and review recent jobs."
              : "Nếu không phải bạn, hãy tạo khoá mới và xem lại các job gần đây.",
          ],
          action: en ? "Review API keys" : "Xem API key",
          footnote: en
            ? "Security notice — no action is needed if you made this change."
            : "Thông báo bảo mật — không cần làm gì nếu bạn đã thực hiện thay đổi này.",
        },
        `${developersUrl}`,
        appUrl,
      );
    case "deletion_requested":
      return layout(
        {
          subject: en ? "Your account deletion was requested" : "Đã yêu cầu xoá tài khoản",
          heading: en ? "Account deletion requested" : "Đã yêu cầu xoá tài khoản",
          body: [
            en
              ? "Sessions, API keys, share links and webhooks were revoked immediately."
              : "Phiên đăng nhập, API key, liên kết chia sẻ và webhook đã bị thu hồi ngay.",
            en
              ? `Your ${brand.copy.dataNoun.en} and personal data will be deleted by ${data.hardDeleteAt ?? "30 days from now"}.`
              : `${brand.copy.dataNoun.vi} và dữ liệu cá nhân sẽ bị xoá trước ${data.hardDeleteAt ?? "30 ngày kể từ bây giờ"}.`,
            en
              ? "You can export your data until the deletion completes."
              : "Bạn có thể xuất dữ liệu cho đến khi việc xoá hoàn tất.",
          ],
          action: en ? "Export my data" : "Xuất dữ liệu của tôi",
          footnote: en
            ? "If you didn't request this, contact support immediately."
            : "Nếu bạn không yêu cầu, hãy liên hệ hỗ trợ ngay.",
        },
        `${settingsUrl}`,
        appUrl,
      );
    case "billing_alert":
      return layout(
        {
          subject: `[${name}] ${data.kind ?? "billing alert"}`,
          heading: `Billing alert: ${data.kind ?? "unknown"}`,
          body: [
            String(data.summary ?? "Reconciliation reported a billing problem."),
            String(data.detail ?? ""),
            "Open /admin/reconciliation to review the finding. Refunds are issued in the provider dashboard; never edit the ledger by hand.",
          ],
          action: "Open reconciliation",
          footnote: "Operator alert. One email per alert kind per hour.",
        },
        `${reconciliationUrl}`,
        appUrl,
      );

    case "worker_alert":
      return layout(
        {
          subject: `[${name}] worker ${data.severity ?? "warning"}: ${data.worker ?? "worker"} ${data.metric ?? "metric"}`,
          heading: `Worker ${data.worker ?? "worker"}: ${data.metric ?? "metric"} ${data.severity ?? "warning"}`,
          body: [
            `${data.metric ?? "Metric"} is ${data.value ?? "unknown"} (threshold ${data.threshold ?? "unknown"}).`,
            String(data.hint ?? "Open Admin → Workers for the history."),
            "Metrics arrive with each heartbeat; warnings are sent on the transition, not on every sample.",
          ],
          action: data.url ? String(data.action ?? "Open worker in Admin") : undefined,
          footnote: `Operator alert from the ${name} worker fleet.`,
        },
        data.url ? String(data.url) : undefined,
        appUrl,
      );

    case "abuse_alert":
      return layout(
        {
          subject: `[${name}] job spam blocked: ${data.subject ?? "unknown subject"}`,
          heading: `Blocked ${data.subject ?? "a subject"} from creating jobs`,
          body: [
            `Reason: ${data.reason ?? "unusual activity"} (${data.count ?? "?"} in the last hour, limit ${data.limit ?? "?"}).`,
            `Blocked until: ${data.until ?? "unknown"}. Queued jobs cancelled: ${data.cancelled ?? 0}.`,
            "Open Admin → Abuse to release the block if this is a real customer, extend it, or keep it until released.",
          ],
          action: "Review in Admin",
          footnote: "Operator alert. At most ten abuse emails per hour.",
        },
        data.url ? String(data.url) : undefined,
        appUrl,
      );

    case "ops_notice": {
      // A generic operator message: the caller composes the wording, `lines` is newline separated.
      const lines = String(data.lines ?? "")
        .split("\n")
        .filter((line) => line.trim().length > 0);
      return layout(
        {
          subject: `[${name}] ${data.subject ?? "notice"}`,
          heading: String(data.heading ?? data.subject ?? "Notice"),
          body: lines,
          action: data.url ? String(data.action ?? "Open in Admin") : undefined,
          footnote: String(data.footnote ?? `Operator notice from ${name}.`),
        },
        data.url ? String(data.url) : undefined,
        appUrl,
      );
    }

    case "product_notice": {
      // A generic buyer message: the app composes the wording, `lines` is newline separated.
      const lines = String(data.lines ?? "")
        .split("\n")
        .filter((line) => line.trim().length > 0);
      return layout(
        {
          subject: String(data.subject ?? `${name}: your purchase`),
          heading: String(data.heading ?? data.subject ?? "Your purchase"),
          body: lines,
          action: data.actionUrl && !data.plain ? String(data.actionLabel ?? "Open") : undefined,
          plain: Boolean(data.plain),
          footnote: String(data.footnote ?? `${name} · support@example.com`),
          unsubscribeUrl: data.unsubscribeUrl ? String(data.unsubscribeUrl) : undefined,
          address: data.address ? String(data.address) : undefined,
        },
        data.actionUrl && !data.plain ? String(data.actionUrl) : undefined,
        data.plain ? undefined : appUrl,
      );
    }

    case "digest":
      return renderDigest(data, appUrl);

    case "webhook_disabled":
      return layout(
        {
          subject: en ? "A webhook endpoint was disabled" : "Một webhook đã bị tắt",
          heading: en ? "Webhook endpoint disabled" : "Đã tắt webhook",
          body: [
            en
              ? `The endpoint ${data.url ?? "on your account"} failed ${data.failureCount ?? 20} consecutive deliveries and was disabled to protect your account.`
              : `Endpoint ${data.url ?? "trên tài khoản của bạn"} đã lỗi ${data.failureCount ?? 20} lần liên tiếp và bị tắt để bảo vệ tài khoản.`,
            en
              ? "Fix the receiver, then verify and re-enable the endpoint in Developers → Webhooks."
              : "Sửa endpoint nhận, sau đó xác minh và bật lại trong Developers → Webhooks.",
          ],
          action: en ? "Review webhooks" : "Xem webhook",
          footnote: en
            ? "Missed events can be fetched with GET /api/v1/jobs."
            : "Có thể lấy job bị lỡ bằng GET /api/v1/jobs.",
        },
        `${developersUrl}`,
        appUrl,
      );
    case "deletion_completed":
      return layout(
        {
          subject: en ? `Your ${name} account was deleted` : `Tài khoản ${name} đã bị xoá`,
          heading: en ? "Account deleted" : "Đã xoá tài khoản",
          body: [
            en
              ? `Your ${brand.copy.dataNoun.en} and personal data have been deleted. Ledger records are kept in anonymised form where the law requires it.`
              : `${brand.copy.dataNoun.vi} và dữ liệu cá nhân đã bị xoá. Sổ cái được giữ ở dạng ẩn danh khi pháp luật yêu cầu.`,
            en ? "You can create a new account at any time." : "Bạn có thể tạo tài khoản mới bất cứ lúc nào.",
          ],
          action: en ? `Open ${name}` : `Mở ${name}`,
          footnote: en ? "Backups age out on their own schedule." : "Bản sao lưu sẽ hết hạn theo lịch riêng.",
        },
        appUrl,
        appUrl,
      );
  }
}

export function checkEmailLinks(content: EmailContent): string[] {
  const errors: string[] = [];
  for (const link of content.links) {
    try {
      const url = new URL(link);
      if (!["http:", "https:"].includes(url.protocol)) errors.push(`Unsupported link protocol: ${link}`);
      if (url.protocol === "http:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
        errors.push(`Non-local links must be https: ${link}`);
      }
    } catch {
      errors.push(`Invalid link: ${link}`);
    }
  }
  if (content.subject.trim().length === 0) errors.push("Missing subject");
  if (content.html.includes("{{")) errors.push("Unrendered placeholder in HTML");
  return errors;
}
