import { platformConfig } from "../config";
import type { Db } from "../db";
import { id, nowIso } from "../db";
import type { Locale, PlatformEnv } from "../types";
import { type EmailContent, type EmailTemplate, renderEmail } from "./templates";

export interface OutgoingEmail {
  userId?: string;
  to: string;
  locale: Locale;
  template: EmailTemplate;
  data: Record<string, string | number>;
  /** Overrides `EMAIL_FROM` for this message, for example a separate marketing sender. */
  from?: string;
  /** Overrides the default reply address for this message. */
  replyTo?: string;
  /** Extra headers such as `List-Unsubscribe`. Sent as-is to providers that accept custom headers. */
  headers?: Record<string, string>;
}

interface Provider {
  name: string;
  send(message: {
    from: string;
    to: string;
    subject: string;
    html: string;
    text: string;
    replyTo?: string;
    headers?: Record<string, string>;
  }): Promise<{ id?: string }>;
}

function defaultFrom(): string {
  return platformConfig().brand.emailFrom;
}

function createProvider(env: PlatformEnv): Provider {
  const provider = env.EMAIL_PROVIDER ?? (env.RESEND_API_KEY ? "resend" : env.POSTMARK_TOKEN ? "postmark" : "console");
  if (provider === "resend" && env.RESEND_API_KEY) {
    return {
      name: "resend",
      async send(message) {
        const response = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            authorization: `Bearer ${env.RESEND_API_KEY}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            from: message.from,
            to: [message.to],
            subject: message.subject,
            html: message.html,
            text: message.text,
            ...(message.replyTo ? { reply_to: message.replyTo } : {}),
            ...(message.headers ? { headers: message.headers } : {}),
          }),
        });
        if (!response.ok) throw new Error(`Resend responded ${response.status}`);
        const body = (await response.json()) as { id?: string };
        return { id: body.id };
      },
    };
  }
  if (provider === "postmark" && env.POSTMARK_TOKEN) {
    return {
      name: "postmark",
      async send(message) {
        const response = await fetch("https://api.postmarkapp.com/email", {
          method: "POST",
          headers: {
            "x-postmark-server-token": env.POSTMARK_TOKEN ?? "",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            From: message.from,
            To: message.to,
            Subject: message.subject,
            HtmlBody: message.html,
            TextBody: message.text,
            MessageStream: "outbound",
            ...(message.replyTo ? { ReplyTo: message.replyTo } : {}),
            ...(message.headers
              ? { Headers: Object.entries(message.headers).map(([Name, Value]) => ({ Name, Value })) }
              : {}),
          }),
        });
        if (!response.ok) throw new Error(`Postmark responded ${response.status}`);
        const body = (await response.json()) as { MessageID?: string };
        return { id: body.MessageID };
      },
    };
  }
  if (provider === "cloudflare" && env.EMAIL) {
    const binding = env.EMAIL;
    return {
      name: "cloudflare",
      async send(message) {
        const result = (await binding.send({
          from: message.from,
          to: message.to,
          subject: message.subject,
          html: message.html,
          text: message.text,
          ...(message.replyTo ? { replyTo: message.replyTo } : {}),
          ...(message.headers ? { headers: message.headers } : {}),
        })) as { messageId?: string } | undefined;
        return { id: result?.messageId };
      },
    };
  }
  return {
    name: "console",
    async send(message) {
      console.log(`[email:${message.subject}] to=${message.to} from=${message.from}`);
      if (env.EMAIL_DEBUG === "1") console.log(message.text);
      return { id: `console_${Date.now()}` };
    },
  };
}

export interface SentEmail {
  id: string;
  content: EmailContent;
  status: "sent" | "failed";
}

/**
 * Write the outbox row first, then attempt delivery. The outbox keeps a retry path
 * for the cron worker; the caller gets a real error only when delivery failed.
 */
export async function sendTransactionalEmail(env: PlatformEnv, db: Db, message: OutgoingEmail): Promise<SentEmail> {
  const content = renderEmail(
    message.template,
    message.locale,
    message.data,
    env.APP_ORIGIN || env.BETTER_AUTH_URL || "https://templatedesign.zhst.app",
  );
  const emailId = id("eml");
  const createdAt = nowIso();
  const provider = createProvider(env);
  await db.run(
    `INSERT INTO email_outbox (id, user_id, to_email, locale, template, payload_json, status, provider, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
    [
      emailId,
      message.userId ?? null,
      message.to,
      message.locale,
      message.template,
      JSON.stringify(message.data),
      provider.name,
      createdAt,
    ],
  );

  try {
    const result = await provider.send({
      from: message.from ?? env.EMAIL_FROM ?? defaultFrom(),
      to: message.to,
      subject: content.subject,
      html: content.html,
      text: content.text,
      replyTo: message.replyTo ?? env.EMAIL_REPLY_TO ?? platformConfig().brand.emailReplyTo,
      headers: message.headers,
    });
    await db.run(
      `UPDATE email_outbox SET status='sent', provider_message_id=?, attempts=attempts+1, sent_at=? WHERE id=?`,
      [result.id ?? null, nowIso(), emailId],
    );
    return { id: emailId, content, status: "sent" };
  } catch (error) {
    await db.run(`UPDATE email_outbox SET status='failed', attempts=attempts+1, last_error=? WHERE id=?`, [
      error instanceof Error ? error.message.slice(0, 500) : "delivery failed",
      emailId,
    ]);
    throw error;
  }
}

export async function retryFailedEmails(env: PlatformEnv, db: Db, limit = 20): Promise<number> {
  const rows = await db.all<{
    id: string;
    to_email: string;
    locale: Locale;
    template: EmailTemplate;
    payload_json: string;
    user_id: string | null;
  }>(
    `SELECT id, to_email, locale, template, payload_json, user_id FROM email_outbox
     WHERE status='failed' AND attempts < 5 ORDER BY created_at LIMIT ?`,
    [limit],
  );
  let sent = 0;
  for (const row of rows) {
    try {
      await sendTransactionalEmail(env, db, {
        userId: row.user_id ?? undefined,
        to: row.to_email,
        locale: row.locale,
        template: row.template,
        data: JSON.parse(row.payload_json) as Record<string, string | number>,
      });
      sent += 1;
    } catch {
      // Leave it failed; the next sweep retries until the attempt cap.
    }
  }
  return sent;
}
