import type { Db } from "@templatedesign/platform/db";

/** Admin-editable behaviour. Every key is registered in `platform.ts` as an extra admin setting. */
export const SETTING_KEYS = {
  enabled: "uploads.enabled",
  maxInlineBytes: "uploads.max_inline_bytes",
  maxImportBytes: "uploads.max_import_bytes",
} as const;

const MB = 1024 * 1024;
export const DEFAULT_MAX_INLINE_BYTES = 4 * MB;
export const DEFAULT_MAX_IMPORT_BYTES = 100 * MB;
/** Ceilings the admin form cannot raise past. Inline content travels in one MCP request of about 6 MB, which carries 4 MB decoded. */
export const HARD_MAX_INLINE_BYTES = 4 * MB;
export const HARD_MAX_IMPORT_BYTES = 500 * MB;

export interface UploadSettings {
  /** Kill switch: when false every new upload (presigned, inline or import) is refused. */
  enabled: boolean;
  maxInlineBytes: number;
  maxImportBytes: number;
}

export const DEFAULT_SETTINGS: UploadSettings = {
  enabled: true,
  maxInlineBytes: DEFAULT_MAX_INLINE_BYTES,
  maxImportBytes: DEFAULT_MAX_IMPORT_BYTES,
};

function parse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

export async function loadUploadSettings(db: Db): Promise<UploadSettings> {
  const keys = Object.values(SETTING_KEYS);
  const rows = await db.all<{ key: string; value_json: string }>(
    `SELECT key, value_json FROM admin_settings WHERE key IN (${keys.map(() => "?").join(", ")})`,
    keys,
  );
  const values = new Map(rows.map((row) => [row.key, parse(row.value_json)]));
  const positive = (key: string, fallback: number, max: number) => {
    const value = values.get(key);
    return typeof value === "number" && Number.isInteger(value) && value > 0 ? Math.min(value, max) : fallback;
  };
  return {
    enabled: values.get(SETTING_KEYS.enabled) !== false,
    maxInlineBytes: positive(SETTING_KEYS.maxInlineBytes, DEFAULT_MAX_INLINE_BYTES, HARD_MAX_INLINE_BYTES),
    maxImportBytes: positive(SETTING_KEYS.maxImportBytes, DEFAULT_MAX_IMPORT_BYTES, HARD_MAX_IMPORT_BYTES),
  };
}
