import { getAdminSettings } from "./admin";
import { platformConfig } from "./config";
import type { Db } from "./db";
import { id, nowIso } from "./db";
import { sendTransactionalEmail } from "./emails/send";
import { HttpError } from "./http";
import { audit } from "./tenancy";
import type { PlatformEnv } from "./types";

export const DEFAULT_WEBHOOK_EVENTS = ["job.succeeded", "job.failed", "webhook.test"] as const;
/** Product events come from `platformConfig().webhooks.events`; the test event is always last. */
export function webhookEvents(): string[] {
  return platformConfig().webhooks?.events ?? [...DEFAULT_WEBHOOK_EVENTS];
}
export type WebhookEvent = string;

const RETRY_DELAYS_SECONDS = [60, 300, 1800, 7200, 21600];
const MAX_ATTEMPTS = 5;
const AUTO_DISABLE_AFTER = 20;

export interface WebhookEndpointView {
  id: string;
  url: string;
  events: WebhookEvent[];
  verifiedAt: string | null;
  disabledAt: string | null;
  failureCount: number;
  createdAt: string;
  updatedAt: string;
}

interface WebhookEndpointRow {
  id: string;
  tenant_id: string;
  url: string;
  secret: string | null;
  secret_hash: string;
  events: string;
  verified_at: string | null;
  verification_challenge: string | null;
  disabled_at: string | null;
  failure_count: number;
  last_error: string | null;
  created_at: string;
  updated_at: string | null;
}

type Dispatcher = (url: string, init: RequestInit) => Promise<Response>;

const defaultDispatcher: Dispatcher = (url, init) => fetch(url, init);

function mapEndpoint(row: WebhookEndpointRow): WebhookEndpointView {
  const events = JSON.parse(row.events) as string[];
  return {
    id: row.id,
    url: row.url,
    events: events.filter((event) => webhookEvents().includes(event)),
    verifiedAt: row.verified_at,
    disabledAt: row.disabled_at,
    failureCount: row.failure_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? row.created_at,
  };
}

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return [...buffer].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function signWebhook(secret: string, timestamp: number, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${body}`));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return true;
  }
  if (host === "metadata.google.internal" || host === "metadata") return true;
  if (/^\d+$/.test(host) || host.startsWith("0x")) return true;
  if (host.startsWith("::ffff:")) return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const octets = ipv4.slice(1).map(Number);
    if (octets.some((octet) => octet > 255)) return true;
    const [a, b] = octets;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (host.includes(":")) {
    return (
      host === "::" ||
      host === "::1" ||
      host.startsWith("fc") ||
      host.startsWith("fd") ||
      host.startsWith("fe8") ||
      host.startsWith("fe9") ||
      host.startsWith("fea") ||
      host.startsWith("feb") ||
      host.startsWith("ff")
    );
  }
  return false;
}

export function validateWebhookUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError("invalid_input", 400, "Webhook URL is not valid.", { field: "url" });
  }
  if (url.protocol !== "https:")
    throw new HttpError("invalid_input", 400, "Webhook URL must use HTTPS.", { field: "url" });
  if (url.username || url.password)
    throw new HttpError("invalid_input", 400, "Webhook URL cannot include credentials.");
  if (url.port && url.port !== "443") throw new HttpError("invalid_input", 400, "Webhook URL must use port 443.");
  if (isPrivateHostname(url.hostname)) {
    throw new HttpError(
      "invalid_input",
      400,
      "Webhook URL must be public; private and metadata addresses are blocked.",
      {
        field: "url",
        reason: "ssrf_guard",
      },
    );
  }
  return url.toString();
}

export async function createWebhookEndpoint(
  env: PlatformEnv,
  db: Db,
  context: { tenantId: string; userId: string },
  input: { url: string; events?: string[] },
  dispatch: Dispatcher = defaultDispatcher,
): Promise<{ endpoint: WebhookEndpointView; secret: string; verified: boolean }> {
  const url = validateWebhookUrl(input.url);
  const supported = webhookEvents();
  const events = input.events?.length ? input.events : supported.filter((event) => event !== "webhook.test");
  if (events.some((event) => !supported.includes(event))) {
    throw new HttpError("invalid_input", 400, "Unknown webhook event.", { field: "events" });
  }
  const endpointId = id("whk");
  const secret = `whsec_${randomHex(24)}`;
  const challenge = randomHex(16);
  const createdAt = nowIso();
  await db.run(
    `INSERT INTO webhook_endpoints
      (id, tenant_id, url, secret, secret_hash, events, verification_challenge, failure_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    [
      endpointId,
      context.tenantId,
      url,
      secret,
      await sha256Hex(secret),
      JSON.stringify(events),
      challenge,
      createdAt,
      createdAt,
    ],
  );
  await audit(db, {
    tenantId: context.tenantId,
    actorUserId: context.userId,
    action: "webhook_endpoint.created",
    targetType: "webhook_endpoint",
    targetId: endpointId,
    metadata: { url, events },
  });
  const verified = await attemptVerification(env, db, endpointId, context.tenantId, dispatch);
  const row = await db.first<WebhookEndpointRow>("SELECT * FROM webhook_endpoints WHERE id = ?", [endpointId]);
  if (!row) throw new Error("Webhook endpoint was not stored");
  return { endpoint: mapEndpoint(row), secret, verified };
}

async function getEndpointRow(db: Db, tenantId: string, endpointId: string): Promise<WebhookEndpointRow> {
  const row = await db.first<WebhookEndpointRow>("SELECT * FROM webhook_endpoints WHERE id = ? AND tenant_id = ?", [
    endpointId,
    tenantId,
  ]);
  if (!row) throw new HttpError("not_found", 404);
  return row;
}

async function postSigned(
  dispatch: Dispatcher,
  endpoint: WebhookEndpointRow,
  eventId: string,
  type: string,
  payload: unknown,
): Promise<Response> {
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = await signWebhook(endpoint.secret ?? "", timestamp, body);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    return await dispatch(endpoint.url, {
      method: "POST",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "user-agent": `${platformConfig().brand.name}-Webhooks/1.0`,
        "x-td-event": type,
        "x-td-delivery": eventId,
        "x-td-signature": `t=${timestamp},v1=${signature}`,
      },
      body,
    });
  } finally {
    clearTimeout(timeout);
  }
}

export async function verifyWebhookEndpoint(
  env: PlatformEnv,
  db: Db,
  tenantId: string,
  endpointId: string,
  dispatch: Dispatcher = defaultDispatcher,
): Promise<WebhookEndpointView> {
  await getEndpointRow(db, tenantId, endpointId);
  await attemptVerification(env, db, endpointId, tenantId, dispatch);
  return mapEndpoint(await getEndpointRow(db, tenantId, endpointId));
}

async function attemptVerification(
  _env: PlatformEnv,
  db: Db,
  endpointId: string,
  tenantId: string,
  dispatch: Dispatcher,
): Promise<boolean> {
  const endpoint = await db.first<WebhookEndpointRow>(
    "SELECT * FROM webhook_endpoints WHERE id = ? AND tenant_id = ?",
    [endpointId, tenantId],
  );
  if (!endpoint) return false;
  const challenge = endpoint.verification_challenge ?? randomHex(16);
  const eventId = id("evt");
  try {
    const response = await postSigned(dispatch, endpoint, eventId, "webhook.verification", {
      id: eventId,
      type: "webhook.verification",
      created_at: nowIso(),
      data: { endpoint_id: endpointId, challenge },
    });
    const body = (await response.json().catch(() => ({}))) as { challenge?: string };
    if (response.ok && body.challenge === challenge) {
      const timestamp = nowIso();
      await db.run(
        "UPDATE webhook_endpoints SET verified_at = ?, failure_count = 0, last_error = NULL, updated_at = ? WHERE id = ? AND tenant_id = ?",
        [timestamp, timestamp, endpointId, tenantId],
      );
      return true;
    }
    await db.run("UPDATE webhook_endpoints SET last_error = ?, updated_at = ? WHERE id = ? AND tenant_id = ?", [
      `Verification returned HTTP ${response.status}`,
      nowIso(),
      endpointId,
      tenantId,
    ]);
    return false;
  } catch (error) {
    await db.run("UPDATE webhook_endpoints SET last_error = ?, updated_at = ? WHERE id = ? AND tenant_id = ?", [
      error instanceof Error ? error.message.slice(0, 300) : "verification failed",
      nowIso(),
      endpointId,
      tenantId,
    ]);
    return false;
  }
}

export async function listWebhookEndpoints(db: Db, tenantId: string): Promise<WebhookEndpointView[]> {
  const rows = await db.all<WebhookEndpointRow>(
    "SELECT * FROM webhook_endpoints WHERE tenant_id = ? ORDER BY created_at DESC",
    [tenantId],
  );
  return rows.map(mapEndpoint);
}

export async function deleteWebhookEndpoint(db: Db, tenantId: string, endpointId: string): Promise<void> {
  await getEndpointRow(db, tenantId, endpointId);
  await db.run("DELETE FROM webhook_endpoints WHERE id = ? AND tenant_id = ?", [endpointId, tenantId]);
}

export async function sendTestWebhook(
  _env: PlatformEnv,
  db: Db,
  tenantId: string,
  endpointId: string,
  dispatch: Dispatcher = defaultDispatcher,
): Promise<{ delivered: boolean; status: number | null }> {
  const endpoint = await getEndpointRow(db, tenantId, endpointId);
  if (endpoint.disabled_at) throw new HttpError("invalid_input", 409, "This endpoint is disabled.");
  const eventId = id("evt");
  try {
    const response = await postSigned(dispatch, endpoint, eventId, "webhook.test", {
      id: eventId,
      type: "webhook.test",
      created_at: nowIso(),
      data: { message: `${platformConfig().brand.name} test event`, endpoint_id: endpointId },
    });
    return { delivered: response.ok, status: response.status };
  } catch {
    return { delivered: false, status: null };
  }
}

export async function deliverEvent(
  _env: PlatformEnv,
  db: Db,
  tenantId: string,
  type: WebhookEvent,
  data: unknown,
  dispatch: Dispatcher = defaultDispatcher,
): Promise<number> {
  if ((await getAdminSettings(db)).pauseWebhooks) return 0;
  const endpoints = await db.all<WebhookEndpointRow>(
    "SELECT * FROM webhook_endpoints WHERE tenant_id = ? AND disabled_at IS NULL AND verified_at IS NOT NULL",
    [tenantId],
  );
  let delivered = 0;
  for (const endpoint of endpoints) {
    if (!(JSON.parse(endpoint.events) as string[]).includes(type)) continue;
    const eventId = id("evt");
    const deliveryId = id("whd");
    const payload = { id: eventId, type, created_at: nowIso(), data };
    await db.run(
      `INSERT INTO webhook_deliveries
        (id, tenant_id, endpoint_id, event_id, type, payload_json, status, attempts, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?)`,
      [deliveryId, tenantId, endpoint.id, eventId, type, JSON.stringify(payload), nowIso()],
    );
    if (await attemptDelivery(db, deliveryId, endpoint, payload, dispatch)) delivered += 1;
  }
  return delivered;
}

async function attemptDelivery(
  db: Db,
  deliveryId: string,
  endpoint: WebhookEndpointRow,
  payload: unknown,
  dispatch: Dispatcher,
): Promise<boolean> {
  const delivery = await db.first<{ attempts: number; event_id: string; type: string }>(
    "SELECT attempts, event_id, type FROM webhook_deliveries WHERE id = ?",
    [deliveryId],
  );
  if (!delivery) return false;
  const attempts = delivery.attempts + 1;
  try {
    const response = await postSigned(dispatch, endpoint, delivery.event_id, delivery.type, payload);
    if (response.ok) {
      await db.batch([
        {
          sql: "UPDATE webhook_deliveries SET status='delivered', attempts=?, response_status=?, delivered_at=?, next_attempt_at=NULL, error=NULL WHERE id=?",
          params: [attempts, response.status, nowIso(), deliveryId],
        },
        {
          sql: "UPDATE webhook_endpoints SET failure_count=0, last_error=NULL, updated_at=? WHERE id=?",
          params: [nowIso(), endpoint.id],
        },
      ]);
      return true;
    }
    const error = `HTTP ${response.status}`;
    const exhausted = attempts >= MAX_ATTEMPTS;
    const next = exhausted ? null : new Date(Date.now() + RETRY_DELAYS_SECONDS[attempts - 1] * 1000).toISOString();
    await db.batch([
      {
        sql: "UPDATE webhook_deliveries SET status=?, attempts=?, response_status=?, error=?, next_attempt_at=? WHERE id=?",
        params: [exhausted ? "failed" : "pending", attempts, response.status, error, next, deliveryId],
      },
      {
        sql: "UPDATE webhook_endpoints SET failure_count=failure_count+1, last_error=?, updated_at=? WHERE id=?",
        params: [error, nowIso(), endpoint.id],
      },
    ]);
    return false;
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 300) : "delivery failed";
    const exhausted = attempts >= MAX_ATTEMPTS;
    const next = exhausted ? null : new Date(Date.now() + RETRY_DELAYS_SECONDS[attempts - 1] * 1000).toISOString();
    await db.batch([
      {
        sql: "UPDATE webhook_deliveries SET status=?, attempts=?, error=?, next_attempt_at=? WHERE id=?",
        params: [exhausted ? "failed" : "pending", attempts, message, next, deliveryId],
      },
      {
        sql: "UPDATE webhook_endpoints SET failure_count=failure_count+1, last_error=?, updated_at=? WHERE id=?",
        params: [message, nowIso(), endpoint.id],
      },
    ]);
    return false;
  }
}

export async function retryDueWebhookDeliveries(
  env: PlatformEnv,
  db: Db,
  limit = 20,
  dispatch: Dispatcher = defaultDispatcher,
): Promise<number> {
  const due = await db.all<{ id: string; endpoint_id: string; payload_json: string }>(
    "SELECT id, endpoint_id, payload_json FROM webhook_deliveries WHERE status='pending' AND next_attempt_at IS NOT NULL AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT ?",
    [nowIso(), limit],
  );
  let delivered = 0;
  for (const row of due) {
    const endpoint = await db.first<WebhookEndpointRow>("SELECT * FROM webhook_endpoints WHERE id = ?", [
      row.endpoint_id,
    ]);
    if (!endpoint || endpoint.disabled_at) continue;
    if (await attemptDelivery(db, row.id, endpoint, JSON.parse(row.payload_json), dispatch)) delivered += 1;
  }
  await disableFailingEndpoints(env, db);
  return delivered;
}

async function disableFailingEndpoints(env: PlatformEnv, db: Db): Promise<void> {
  const rows = await db.all<{ id: string; tenant_id: string; failure_count: number; url: string }>(
    "SELECT id, tenant_id, failure_count, url FROM webhook_endpoints WHERE disabled_at IS NULL AND failure_count >= ?",
    [AUTO_DISABLE_AFTER],
  );
  for (const row of rows) {
    await db.run("UPDATE webhook_endpoints SET disabled_at = ?, updated_at = ? WHERE id = ?", [
      nowIso(),
      nowIso(),
      row.id,
    ]);
    await audit(db, {
      tenantId: row.tenant_id,
      actorUserId: null,
      action: "webhook_endpoint.auto_disabled",
      targetType: "webhook_endpoint",
      targetId: row.id,
      metadata: { failureCount: row.failure_count },
    });
    const owner = await db.first<{ email: string; ui_language: "en" | "vi" }>(
      `SELECT u.email, p.ui_language FROM memberships m
       JOIN "user" u ON u.id = m.user_id
       JOIN profiles p ON p.user_id = m.user_id
       WHERE m.tenant_id = ? LIMIT 1`,
      [row.tenant_id],
    );
    if (owner) {
      await sendTransactionalEmail(env, db, {
        to: owner.email,
        locale: owner.ui_language,
        template: "webhook_disabled",
        data: { url: row.url, failureCount: row.failure_count },
      }).catch(() => undefined);
    }
  }
}

export { AUTO_DISABLE_AFTER, MAX_ATTEMPTS };
