import { z } from "zod";
import { ARTIFACT_ID_PATTERN } from "../storage/keys";
import { MAX_PRESIGN_GET_SECONDS, MIN_PRESIGN_GET_SECONDS } from "../storage/s3";

/**
 * Input shapes for the service. The service parses its own input with these, so the MCP tools, the
 * REST routes and the tests all share one set of limits. Unknown keys are rejected.
 */

export const MAX_EXPIRY_DAYS = 3650;

export const artifactId = z.string().regex(ARTIFACT_ID_PATTERN, "Not a valid file id.");

const name = z.string().min(1).max(255);
const mime = z.string().max(127).optional();
const note = z.string().max(1000).nullish();
const expiresInDays = z.number().int().min(1).max(MAX_EXPIRY_DAYS).optional();

export const createUploadSchema = z
  .object({
    name,
    // The ceiling is checked by the service so an oversized request gets TOO_LARGE, not a field error.
    size: z.number().int().min(0),
    mime,
    expires_in_days: expiresInDays,
    note,
  })
  .strict();

export const putInlineSchema = z
  .object({
    name,
    content: z.string(),
    encoding: z.enum(["text", "base64"]).default("text"),
    mime,
    expires_in_days: expiresInDays,
    note,
  })
  .strict();

/** The metadata of an upload whose bytes arrive as the request body, so they are not a field. */
export const putBytesSchema = putInlineSchema.omit({ content: true, encoding: true });

export const importFromUrlSchema = z
  .object({
    url: z.string().min(1).max(2048),
    name: name.optional(),
    mime,
    expires_in_days: expiresInDays,
    note,
  })
  .strict();

export const listArtifactsSchema = z
  .object({
    cursor: z.string().max(200).optional(),
    limit: z.number().int().min(1).max(100).default(25),
    status: z.enum(["pending", "ready", "deleted"]).default("ready"),
    query: z.string().max(200).optional(),
  })
  .strict();

export const setExpirySchema = z
  .object({
    /** Null clears the expiry: the file is kept until it is deleted. */
    expires_in_days: z.number().int().min(1).max(MAX_EXPIRY_DAYS).nullable(),
  })
  .strict();

export const downloadLinkSchema = z
  .object({
    ttl_seconds: z.number().int().min(MIN_PRESIGN_GET_SECONDS).max(MAX_PRESIGN_GET_SECONDS).default(3600),
    disposition: z.enum(["inline", "attachment"]).default("attachment"),
  })
  .strict();

export type CreateUploadInput = z.input<typeof createUploadSchema>;
export type PutInlineInput = z.input<typeof putInlineSchema>;
export type PutBytesInput = z.input<typeof putBytesSchema>;
export type ImportFromUrlInput = z.input<typeof importFromUrlSchema>;
export type ListArtifactsInput = z.input<typeof listArtifactsSchema>;
export type SetExpiryInput = z.input<typeof setExpirySchema>;
export type DownloadLinkInput = z.input<typeof downloadLinkSchema>;
