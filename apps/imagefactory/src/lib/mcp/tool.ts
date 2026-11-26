import { type CallToolResult, type McpServer, specTypeSchemas, type Tool } from "@modelcontextprotocol/server";
import { HttpError } from "@templatedesign/platform/http";
import { z } from "zod";
import { ImageError } from "../images/errors";
import { assertScope, type Caller, type PreviewBlock } from "../images/service";
import { errorResult, type ToolErrorCode, textResult } from "./result";

export type ToolScope = "images:read" | "images:write";

export interface ToolOutput {
  data?: Record<string, unknown>;
  /** A fully formatted reply, used by the image tools. */
  reply?: CallToolResult;
  previews?: PreviewBlock[];
}

export interface ToolDefinition<T extends z.ZodObject = z.ZodObject> {
  name: string;
  title: string;
  description: string;
  schema: T;
  scope: ToolScope;
  /** Removes data. Clients may ask for confirmation first. */
  destructive?: boolean;
  /** Reads from or writes to systems outside this app (the image provider, remote image URLs). */
  openWorld?: boolean;
  /** The same arguments always give the same result. */
  idempotent?: boolean;
  run(input: z.infer<T>, caller: Caller): Promise<ToolOutput>;
}

const HINTS: Partial<Record<ToolErrorCode, string>> = {
  NOT_FOUND: " Use the matching list tool to see valid ids.",
  INSUFFICIENT_CREDITS: " Check the balance with get_balance, or ask the account owner to add credits.",
  INSUFFICIENT_SCOPE: " Reconnect the connector and approve write access.",
  INVALID_INPUT: " Correct the arguments and retry.",
  JOB_PENDING: " Call get_job with the job_id.",
};

/** Turns anything a tool can throw into a stable `{ code, message }` tool error. */
export function mapError(error: unknown): CallToolResult {
  if (error instanceof ImageError) {
    return errorResult(error.code, error.message + (HINTS[error.code] ?? ""), error.details ?? {});
  }
  if (error instanceof HttpError) {
    if (error.code === "insufficient_credits") {
      return errorResult("INSUFFICIENT_CREDITS", error.message + HINTS.INSUFFICIENT_CREDITS, error.details ?? {});
    }
    if (error.code === "forbidden") return errorResult("INSUFFICIENT_SCOPE", error.message + HINTS.INSUFFICIENT_SCOPE);
    if (error.code === "rate_limited") return errorResult("PROVIDER_ERROR", error.message);
    return errorResult("INVALID_INPUT", error.message);
  }
  if (error instanceof z.ZodError) {
    return errorResult("VALIDATION_ERROR", "Correct the indicated fields and retry.", {
      fields: error.issues.map(({ path, message }) => ({ path: path.join("."), message })),
    });
  }
  console.error("[mcp] Tool failed", error instanceof Error ? error.message : "unknown");
  return errorResult(
    "INTERNAL_ERROR",
    "The operation could not be completed. Check get_balance and list_images before retrying a generation so you do not pay twice.",
  );
}

/**
 * Registers the tools the caller's scopes allow. Tools that need a scope the token lacks stay
 * registered so the SDK can issue its scope challenge, but are left out of `tools/list`.
 */
export function registerTools(server: McpServer, definitions: ToolDefinition[], caller: Caller): void {
  const has = (scope: ToolScope) =>
    caller.scopes.includes(scope) || (scope === "images:read" && caller.scopes.includes("images:write"));
  const visible: Tool[] = [];

  for (const def of definitions) {
    const annotations = {
      readOnlyHint: def.scope === "images:read",
      destructiveHint: def.destructive ?? false,
      idempotentHint: def.idempotent ?? def.scope === "images:read",
      openWorldHint: def.openWorld ?? false,
    };
    if (has(def.scope)) {
      const descriptor = specTypeSchemas.Tool["~standard"].validate({
        name: def.name,
        title: def.title,
        description: def.description,
        annotations,
        inputSchema: z.toJSONSchema(def.schema, { io: "input" }),
      });
      if (descriptor.issues) throw new Error(`Invalid MCP tool descriptor for ${def.name}`);
      visible.push(descriptor.value);
    }

    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: def.schema,
        annotations,
        scopeChallenge: () =>
          has(def.scope)
            ? undefined
            : {
                scopes: [def.scope] as [string, ...string[]],
                errorDescription: `Reconnect and approve ${def.scope} to call this tool`,
              },
      },
      async (input: z.infer<typeof def.schema>) => {
        try {
          assertScope(caller, def.scope);
          const output = await def.run(input, caller);
          return output.reply ?? textResult(output.data ?? {});
        } catch (error) {
          return mapError(error);
        }
      },
    );
  }

  server.server.setRequestHandler("tools/list", () => ({ tools: visible }));
}
