import { getAdminSettingValue } from "../admin";
import { platformConfig } from "../config";
import type { Db } from "../db";

/**
 * OpenRouter free-model client shared by the mini apps. It owns the model list, the per-model
 * daily request budget and the fallback chat call. The prompt, the verdict rules and the apply
 * step stay per app, because they depend on each app's content.
 *
 * Free providers log prompts, so callers send public content fields only — never emails or IPs.
 */
export const DEFAULT_MODELS = [
  "meta-llama/llama-3.3-70b-instruct:free",
  "google/gemini-2.0-flash-exp:free",
  "mistralai/mistral-small-3.1-24b-instruct:free",
];

export const DEFAULT_DAILY_REQUESTS_PER_MODEL = 50;

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** The bindings this module reads. Every app's `Env` is structurally compatible. */
export interface LlmEnv {
  OPENROUTER_API_KEY?: string;
  OPENROUTER_MODELS?: string;
  PUBLIC_ORIGIN?: string;
}

export class LlmUnavailableError extends Error {
  constructor(public readonly reason: "disabled" | "budget" | "all_failed" | "no_key") {
    super(`llm_${reason}`);
  }
}

export class JsonExtractionError extends Error {
  constructor(message: string) {
    super(`json_invalid: ${message}`);
  }
}

/** Models wrap JSON in fences or prose; take the outermost array/object they produced. */
export function extractJson(content: string): unknown {
  const stripped = content
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    return JSON.parse(stripped) as unknown;
  } catch {
    const start = stripped.indexOf("[");
    const end = stripped.lastIndexOf("]");
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(stripped.slice(start, end + 1)) as unknown;
      } catch {
        // Fall through to the object attempt.
      }
    }
    const braceStart = stripped.indexOf("{");
    const braceEnd = stripped.lastIndexOf("}");
    if (braceStart !== -1 && braceEnd > braceStart) {
      try {
        return JSON.parse(stripped.slice(braceStart, braceEnd + 1)) as unknown;
      } catch {
        // Fall through to the error.
      }
    }
    throw new JsonExtractionError("not_json");
  }
}

export function dayKey(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

export async function llmEnabled(db: Db): Promise<boolean> {
  const value = await getAdminSettingValue<boolean>(db, "llm.enabled");
  return value !== false;
}

export async function modelList(db: Db, env: Pick<LlmEnv, "OPENROUTER_MODELS">): Promise<string[]> {
  const configured = await getAdminSettingValue<string[] | string>(db, "llm.models");
  const parsed =
    typeof configured === "string"
      ? configured
          .split(/[\n,]/)
          .map((value) => value.trim())
          .filter(Boolean)
      : Array.isArray(configured)
        ? configured.filter((value): value is string => typeof value === "string")
        : [];
  if (parsed.length > 0) return parsed;
  if (env.OPENROUTER_MODELS) {
    return env.OPENROUTER_MODELS.split(",")
      .map((value) => value.trim())
      .filter(Boolean);
  }
  return DEFAULT_MODELS;
}

async function dailyBudget(db: Db): Promise<number> {
  const configured = await getAdminSettingValue<number | string>(db, "moderation.daily_request_budget");
  const number = Number(configured);
  return Number.isInteger(number) && number > 0 ? number : DEFAULT_DAILY_REQUESTS_PER_MODEL;
}

/** One counter per model per UTC day. Returns false when the model has spent its budget. */
export async function takeBudget(db: Db, model: string, limit?: number, now = Date.now()): Promise<boolean> {
  const day = dayKey(now);
  const cap = limit ?? (await dailyBudget(db));
  await db.run("INSERT OR IGNORE INTO llm_usage (day, model, requests) VALUES (?, ?, 0)", [day, model]);
  const result = await db.run(
    "UPDATE llm_usage SET requests = requests + 1 WHERE day = ? AND model = ? AND requests < ?",
    [day, model, cap],
  );
  return result.changes === 1;
}

export interface ChatResult {
  content: string;
  model: string;
}

/** One request to one model. Throws on 429, 5xx, a network error or an empty completion. */
export async function requestModel(
  env: Pick<LlmEnv, "OPENROUTER_API_KEY" | "PUBLIC_ORIGIN">,
  model: string,
  messages: ChatMessage[],
  options: {
    maxTokens?: number;
    temperature?: number;
    fetcher?: typeof fetch;
    timeoutMs?: number;
  } = {},
): Promise<ChatResult> {
  if (!env.OPENROUTER_API_KEY) throw new LlmUnavailableError("no_key");
  const fetcher = options.fetcher ?? fetch;
  const controller = new AbortController();
  const timeout = options.timeoutMs ?? 30_000;
  const timer = setTimeout(() => controller.abort(), timeout);
  const brand = platformConfig().brand.name;
  try {
    const response = await fetcher("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        "content-type": "application/json",
        "http-referer": env.PUBLIC_ORIGIN ?? "https://example.invalid",
        "x-title": `${brand} moderation`,
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: options.maxTokens ?? 1200,
        temperature: options.temperature ?? 0.1,
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`openrouter_${response.status}`);
    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      error?: { message?: string };
    };
    const content = body.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error("openrouter_empty");
    return { content, model };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The models one batch may try, honouring the on/off switch and the API key. Throws
 * `LlmUnavailableError` when moderation cannot run at all, which the job records as a failed run.
 */
export async function planChatModels(
  db: Db,
  env: Pick<LlmEnv, "OPENROUTER_API_KEY">,
  models: string[],
  attempts: number,
): Promise<string[]> {
  if (!(await llmEnabled(db))) throw new LlmUnavailableError("disabled");
  if (!env.OPENROUTER_API_KEY) throw new LlmUnavailableError("no_key");
  return models.slice(0, Math.max(1, attempts));
}

/** Tries each configured model in order. Kept for callers that only need one successful answer. */
export async function chat(
  env: Pick<LlmEnv, "OPENROUTER_API_KEY" | "PUBLIC_ORIGIN" | "OPENROUTER_MODELS">,
  db: Db,
  messages: ChatMessage[],
  options: { maxTokens?: number; temperature?: number; fetcher?: typeof fetch } = {},
): Promise<ChatResult> {
  if (!(await llmEnabled(db))) throw new LlmUnavailableError("disabled");
  if (!env.OPENROUTER_API_KEY) throw new LlmUnavailableError("no_key");
  for (const model of await modelList(db, env)) {
    if (!(await takeBudget(db, model))) continue;
    try {
      return await requestModel(env, model, messages, options);
    } catch {
      // 429, 5xx or network: move to the next model.
    }
  }
  throw new LlmUnavailableError("all_failed");
}

export async function dailyUsage(db: Db, now = Date.now()): Promise<Array<{ model: string; requests: number }>> {
  return db.all<{ model: string; requests: number }>(
    "SELECT model, requests FROM llm_usage WHERE day = ? ORDER BY requests DESC",
    [dayKey(now)],
  );
}
