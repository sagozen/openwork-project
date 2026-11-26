import type { CallToolResult } from "@modelcontextprotocol/server";
import type { ArtifactErrorCode } from "../artifacts/errors";

/** JSON text plus the same object as `structuredContent`, the shape every tool replies in. */
export function textResult(data: Record<string, unknown>, isError = false): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
    structuredContent: data,
    ...(isError ? { isError: true } : {}),
  };
}

export type ToolErrorCode = ArtifactErrorCode;

export function errorResult(code: ToolErrorCode, message: string, extra: Record<string, unknown> = {}): CallToolResult {
  return textResult({ code, message, ...extra }, true);
}

/** A text file read back for the model: a readable block, with the facts also in `structuredContent`. */
export function textFileResult(file: { name: string; mime: string; size: number; text: string }): CallToolResult {
  return {
    content: [{ type: "text", text: `File ${file.name} (${file.mime}, ${file.size} bytes):\n\n${file.text}` }],
    structuredContent: { kind: "text", name: file.name, mime: file.mime, size: file.size, text: file.text },
  };
}

/** An image read back for the model, as an MCP image block. The bytes are not repeated in `structuredContent`. */
export function imageFileResult(file: { name: string; mime: string; size: number; data: string }): CallToolResult {
  return {
    content: [
      { type: "text", text: `Image ${file.name} (${file.mime}, ${file.size} bytes).` },
      { type: "image", data: file.data, mimeType: file.mime },
    ],
    structuredContent: { kind: "image", name: file.name, mime: file.mime, size: file.size },
  };
}
