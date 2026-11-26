import { type CallToolResult, type McpServer, specTypeSchemas, type Tool } from "@modelcontextprotocol/server";
import { HttpError } from "@templatedesign/platform/http";
import { z } from "zod";
import { ArtifactError, type ArtifactErrorCode } from "../artifacts/errors";
import type { Caller } from "../auth/caller";
import { assertScope, hasScope, SCOPE_READ, type SCOPE_WRITE } from "../auth/scopes";
import { type ServiceContext, serviceFor } from "./context";
import { errorResult, type ToolErrorCode, textResult } from "./result";

export type ToolScope = typeof SCOPE_READ | typeof SCOPE_WRITE;

export interface ToolOutput {
  data?: Record<string, unknown>;
  /** A fully formatted reply, used by `read_file`. */
  reply?: CallToolResult;
}

export interface ToolDefinition<T extends z.ZodType = z.ZodType> {
  name: string;
  title: string;
  description: string;
  schema: T;
  scope: ToolScope;
  /** Removes data or switches something off. Clients may ask for confirmation first. */
  destructive?: boolean;
  /** Reads from or writes to systems outside this app (remote URLs). */
  openWorld?: boolean;
  /** Repeating the call with the same arguments leaves the same result. */
  idempotent?: boolean;
  run(input: z.output<T>, caller: Caller, services: ServiceContext): Promise<ToolOutput>;
}

/**
 * Declares a tool with its input type taken from its schema, so `run` gets a typed input. The one
 * cast erases that type so tools of different shapes can share a list.
 */
export function defineTool<T extends z.ZodType>(def: ToolDefinition<T>): ToolDefinition {
  return def as unknown as ToolDefinition;
}

const PASS_THROUGH = z.looseObject({});

const HINTS: Partial<Record<ArtifactErrorCode, string>> = {
  NOT_FOUND: " Use list_files or list_shares to see valid ids.",
  INVALID_INPUT: " Correct the arguments and retry.",
  UPLOAD_NOT_FOUND: " PUT the file to the upload_url from create_upload first, then call complete_upload again.",
  TOO_LARGE: " For a big file use create_upload (up to 5 GB) or, for a public URL, import_from_url.",
  UPLOADS_DISABLED: " The owner has switched uploads off; do not retry until they are back on.",
  PROVIDER_ERROR: " File storage had a problem. Try again in a moment.",
  INSUFFICIENT_SCOPE: " Reconnect the connector and approve write access.",
};

/** Turns anything a tool can throw into a stable `{ code, message }` tool error. */
export function mapError(error: unknown): CallToolResult {
  if (error instanceof ArtifactError) {
    return errorResult(error.code, error.message + (HINTS[error.code] ?? ""), error.details ?? {});
  }
  if (error instanceof z.ZodError) {
    return errorResult("VALIDATION_ERROR", "Correct the indicated fields and retry.", {
      fields: error.issues.map(({ path, message }) => ({ path: path.join("."), message })),
    });
  }
  if (error instanceof HttpError) {
    return errorResult(error.status === 403 ? "INSUFFICIENT_SCOPE" : "INVALID_INPUT", error.message);
  }
  console.error("[mcp] Tool failed", error instanceof Error ? error.message : "unknown");
  return errorResult(
    "INTERNAL_ERROR",
    "The operation could not be completed. Check list_files before retrying a write so you do not repeat it.",
  );
}

/** Parses `input` with the tool's own strict schema, checks the scope and runs the tool. Shared by MCP and REST. */
export async function callTool(
  def: ToolDefinition,
  input: unknown,
  caller: Caller,
  services?: ServiceContext,
): Promise<ToolOutput> {
  assertScope(caller, def.scope);
  return def.run(def.schema.parse(input), caller, services ?? (await serviceFor()));
}

/**
 * Registers the tools the caller's scopes allow. Tools that need a scope the token lacks stay
 * registered so the SDK can issue its scope challenge, but are left out of `tools/list`.
 */
export function registerTools(server: McpServer, definitions: ToolDefinition[], caller: Caller): void {
  const visible: Tool[] = [];

  for (const def of definitions) {
    const annotations = {
      readOnlyHint: def.scope === SCOPE_READ,
      destructiveHint: def.destructive ?? false,
      idempotentHint: def.idempotent ?? def.scope === SCOPE_READ,
      openWorldHint: def.openWorld ?? false,
    };
    const allowed = hasScope(caller, def.scope);
    if (allowed) {
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
        // Validation is ours, so every failure has the same { code, message, fields } shape; the SDK only passes input through.
        inputSchema: PASS_THROUGH,
        annotations,
        scopeChallenge: () =>
          allowed
            ? undefined
            : {
                scopes: [def.scope] as [string, ...string[]],
                errorDescription: `Reconnect and approve ${def.scope} to call this tool`,
              },
      },
      async (input: unknown) => {
        try {
          const output = await callTool(def, input, caller);
          return output.reply ?? textResult(output.data ?? {});
        } catch (error) {
          return mapError(error);
        }
      },
    );
  }

  server.server.setRequestHandler("tools/list", () => ({ tools: visible }));
}

export type { ToolErrorCode };
