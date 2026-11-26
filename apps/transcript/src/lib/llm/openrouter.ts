import { getAdminSettingValue } from "@templatedesign/platform/admin";
import type { Db } from "@templatedesign/platform/db";
import { dayKey } from "../quota";
import type { Env } from "../types";

/**
 * OpenRouter free-model client. No SDK: `fetch` plus the fallback list is all this needs.
 * Free providers log prompts, so the privacy policy and the add-on UI both disclose it and
 * a user who disabled the add-on never reaches this module.
 */
export const DEFAULT_MODELS = [
  "meta-llama/llama-3.3-70b-instruct:free",
  "google/gemini-2.0-flash-exp:free",
  "mistralai/mistral-small-3.1-24b-instruct:free",
];

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export class LlmUnavailableError extends Error {
  constructor(public readonly reason: "disabled" | "budget" | "all_failed" | "no_key") {
    super(`llm_${reason}`);
  }
}

export async function modelList(db: Db, env: Env): Promise<string[]> {
  const configured = await getAdminSettingValue<string[] | string>(db, "llm.models");
  const parsed =
    typeof configured === "string"
      ? configured
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean)
      : Array.isArray(configured)
        ? configured
        : [];
  if (parsed.length > 0) return parsed;
  if (env.OPENROUTER_MODELS) {
    return env.OPENROUTER_MODELS.split(",")
      .map((value) => value.trim())
      .filter(Boolean);
  }
  return DEFAULT_MODELS;
}

/** Free models allow a small number of requests per day; the counter is per model per day. */
export const DAILY_REQUESTS_PER_MODEL = 50;

async function takeBudget(db: Db, model: string): Promise<boolean> {
  const day = dayKey();
  await db.run("INSERT OR IGNORE INTO llm_usage (day, model, requests) VALUES (?, ?, 0)", [day, model]);
  const result = await db.run(
    "UPDATE llm_usage SET requests = requests + 1 WHERE day = ? AND model = ? AND requests < ?",
    [day, model, DAILY_REQUESTS_PER_MODEL],
  );
  return result.changes === 1;
}

export interface ChatResult {
  content: string;
  model: string;
}

export async function llmEnabled(db: Db): Promise<boolean> {
  const value = await getAdminSettingValue<boolean>(db, "llm.enabled");
  return value !== false;
}

/**
 * Tries each configured model in order. 429, 5xx and network errors move to the next model;
 * a model that is out of daily budget is skipped without a request.
 */
export async function chat(
  env: Env,
  db: Db,
  messages: ChatMessage[],
  options: { maxTokens?: number; temperature?: number; fetcher?: typeof fetch } = {},
): Promise<ChatResult> {
  if (!(await llmEnabled(db))) throw new LlmUnavailableError("disabled");
  if (!env.OPENROUTER_API_KEY) throw new LlmUnavailableError("no_key");
  const models = await modelList(db, env);
  const fetcher = options.fetcher ?? fetch;
  for (const model of models) {
    if (!(await takeBudget(db, model))) continue;
    try {
      const response = await fetcher("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
          "content-type": "application/json",
          "http-referer": "https://transcriptanything.zhst.app",
          "x-title": "TranscriptAnything",
        },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: options.maxTokens ?? 800,
          temperature: options.temperature ?? 0.2,
        }),
      });
      if (!response.ok) continue;
      const body = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        error?: { message?: string };
      };
      const content = body.choices?.[0]?.message?.content?.trim();
      if (!content) continue;
      return { content, model };
    } catch {}
  }
  throw new LlmUnavailableError("all_failed");
}

export async function dailyUsage(db: Db): Promise<Array<{ model: string; requests: number }>> {
  return db.all<{ model: string; requests: number }>(
    "SELECT model, requests FROM llm_usage WHERE day = ? ORDER BY requests DESC",
    [dayKey()],
  );
}
