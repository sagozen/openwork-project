import { z } from "zod";
import { artifactId, MAX_EXPIRY_DAYS } from "../artifacts/schemas";

/** Passwords the owner types in must be at least this long; `"generate"` makes a strong one instead. */
export const MIN_PASSWORD_CHARS = 8;
export const GENERATE_PASSWORD = "generate";
export const MAX_SHARE_ITEMS = 50;

const title = z.string().min(1).max(120);
const password = z.union([z.literal(GENERATE_PASSWORD), z.string().min(MIN_PASSWORD_CHARS).max(200)]);
const expiresInDays = z.number().int().min(1).max(MAX_EXPIRY_DAYS);

export const createShareSchema = z
  .object({
    artifact_ids: z
      .array(artifactId)
      .min(1)
      .max(MAX_SHARE_ITEMS)
      .refine((ids) => new Set(ids).size === ids.length, "Each file can appear once."),
    title: title.nullish(),
    password: password.optional(),
    expires_in_days: expiresInDays.optional(),
  })
  .strict();

/** The fields an update can change; also reused by the tool and REST layers, which add the share id. */
export const updateShareFields = {
  title: title.nullable().optional(),
  /** Null clears the expiry: the link works until it is revoked. */
  expires_in_days: expiresInDays.nullable().optional(),
  /** A new password, `"generate"` for a random one, or null to remove the password. */
  password: password.nullable().optional(),
};

export const CHANGE_AT_LEAST_ONE = "Give at least one field to change.";

export const updateShareSchema = z
  .object(updateShareFields)
  .strict()
  .refine((value) => Object.keys(value).length > 0, CHANGE_AT_LEAST_ONE);

export const listSharesSchema = z
  .object({
    cursor: z.string().max(200).optional(),
    limit: z.number().int().min(1).max(100).default(25),
    include_revoked: z.boolean().default(false),
  })
  .strict();

export type CreateShareInput = z.input<typeof createShareSchema>;
export type UpdateShareInput = z.input<typeof updateShareSchema>;
export type ListSharesInput = z.input<typeof listSharesSchema>;
