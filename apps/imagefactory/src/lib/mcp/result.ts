import type { CallToolResult } from "@modelcontextprotocol/server";
import type { ImageErrorCode } from "../images/errors";
import type { GenerationResult, PreviewBlock } from "../images/service";

/** JSON text plus the same object as `structuredContent`, the shape every tool replies in. */
export function textResult(data: Record<string, unknown>, isError = false): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
    structuredContent: data,
    ...(isError ? { isError: true } : {}),
  };
}

export type ToolErrorCode = ImageErrorCode | "VALIDATION_ERROR" | "INTERNAL_ERROR" | "ACCOUNT_SUSPENDED";

export function errorResult(code: ToolErrorCode, message: string, extra: Record<string, unknown> = {}): CallToolResult {
  return textResult({ code, message, ...extra }, true);
}

function describe(result: GenerationResult): string {
  if (result.pending) {
    return [
      `The job is still running (${result.state}${result.queue_position !== undefined ? `, queue position ${result.queue_position}` : ""}).`,
      `Call get_job with job_id "${result.job_id}" in a few seconds to get the images.`,
      `Credits reserved: ${result.credits_reserved}. They are charged only for images that are delivered.`,
    ].join("\n");
  }
  const lines = [
    `Made ${result.images.length} image${result.images.length === 1 ? "" : "s"} for ${result.credits_charged ?? 0} credits (job ${result.job_id}).`,
  ];
  if (result.blocked_count > 0) {
    lines.push(`${result.blocked_count} image(s) were blocked by the safety check and were not charged.`);
  }
  result.images.forEach((image, index) => {
    lines.push("", `${index + 1}. ${image.url}`, `   ${image.width}x${image.height}, seed ${image.seed ?? "n/a"}`);
    lines.push(`![${image.title ?? `Image ${index + 1}`}](${image.url})`);
  });
  lines.push("", `Prompt sent to the model: ${result.prompt}`);
  return lines.join("\n");
}

/**
 * Reply for generate, edit and get_job. The text carries each public URL and a markdown image so
 * every client has something to show; small previews are added as MCP image blocks.
 */
export function generationResult(result: GenerationResult, previews: PreviewBlock[] = []): CallToolResult {
  return {
    content: [
      { type: "text", text: describe(result) },
      ...previews.map((preview) => ({ type: "image" as const, data: preview.data, mimeType: preview.mimeType })),
    ],
    structuredContent: result as unknown as Record<string, unknown>,
  };
}
