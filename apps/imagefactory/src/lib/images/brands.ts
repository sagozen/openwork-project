import type { Db } from "@templatedesign/platform/db";
import { id, nowIso } from "@templatedesign/platform/db";
import type { BrandStyle, PaletteColor } from "./compose";
import { ImageError } from "./errors";
import { isModelId } from "./models";
import { isPresetId } from "./presets";
import { brandAssetKey, extensionFor, sniffImageMime } from "./storage";

export const MAX_BRANDS = 25;
export const MAX_ASSETS_PER_BRAND = 12;
export const MAX_ASSET_BYTES = 10 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;

export interface BrandRow {
  id: string;
  tenant_id: string;
  slug: string;
  name: string;
  description: string | null;
  style_prompt: string;
  negative_prompt: string | null;
  palette_json: string;
  typography: string | null;
  default_model: string | null;
  default_preset: string | null;
  lora_url: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface BrandAssetRow {
  id: string;
  tenant_id: string;
  brand_id: string;
  role: "reference" | "logo" | "example";
  r2_key: string;
  mime: string;
  width: number | null;
  height: number | null;
  bytes: number;
  note: string | null;
  sort: number;
  created_at: string;
  deleted_at: string | null;
}

export interface BrandInput {
  name: string;
  description?: string | null;
  stylePrompt?: string;
  negativePrompt?: string | null;
  palette?: PaletteColor[];
  typography?: string | null;
  defaultModel?: string | null;
  defaultPreset?: string | null;
}

export type BrandPatch = Partial<BrandInput>;

export function slugify(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "brand";
}

export function parsePalette(json: string): PaletteColor[] {
  try {
    const value = JSON.parse(json) as unknown;
    return Array.isArray(value) ? (value as PaletteColor[]) : [];
  } catch {
    return [];
  }
}

export function brandStyle(row: BrandRow): BrandStyle {
  return {
    name: row.name,
    stylePrompt: row.style_prompt,
    negativePrompt: row.negative_prompt,
    palette: parsePalette(row.palette_json),
    typography: row.typography,
  };
}

function validate(input: BrandPatch): void {
  if (input.defaultModel && !isModelId(input.defaultModel)) {
    throw new ImageError("INVALID_INPUT", `Unknown model "${input.defaultModel}".`);
  }
  if (input.defaultPreset && !isPresetId(input.defaultPreset)) {
    throw new ImageError("INVALID_INPUT", `Unknown preset "${input.defaultPreset}".`);
  }
  for (const color of input.palette ?? []) {
    if (!/^#[0-9a-fA-F]{6}$/.test(color.hex)) {
      throw new ImageError("INVALID_INPUT", `"${color.hex}" is not a hex colour like #1a73e8.`);
    }
  }
}

/* ---------------------------------------------------------------- brands */

export async function listBrands(db: Db, tenantId: string): Promise<Array<BrandRow & { asset_count: number }>> {
  return db.all<BrandRow & { asset_count: number }>(
    `SELECT b.*, (SELECT COUNT(*) FROM brand_assets a WHERE a.brand_id = b.id AND a.tenant_id = b.tenant_id AND a.deleted_at IS NULL) AS asset_count
     FROM brand_kits b WHERE b.tenant_id = ? AND b.deleted_at IS NULL ORDER BY b.created_at`,
    [tenantId],
  );
}

/** Looks a brand up by id or slug, always inside the tenant. */
export async function findBrand(db: Db, tenantId: string, idOrSlug: string): Promise<BrandRow | null> {
  return db.first<BrandRow>(
    "SELECT * FROM brand_kits WHERE tenant_id = ? AND deleted_at IS NULL AND (id = ? OR slug = ?)",
    [tenantId, idOrSlug, idOrSlug],
  );
}

export async function requireBrand(db: Db, tenantId: string, idOrSlug: string): Promise<BrandRow> {
  const brand = await findBrand(db, tenantId, idOrSlug);
  if (!brand) throw new ImageError("NOT_FOUND", `No brand kit "${idOrSlug}". Use list_brands to see yours.`);
  return brand;
}

async function uniqueSlug(db: Db, tenantId: string, base: string): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const slug = attempt === 0 ? base : `${base}-${attempt + 1}`;
    const taken = await db.first<{ id: string }>(
      "SELECT id FROM brand_kits WHERE tenant_id = ? AND slug = ? AND deleted_at IS NULL",
      [tenantId, slug],
    );
    if (!taken) return slug;
  }
  throw new ImageError("INVALID_INPUT", "Could not find a free slug for this brand name.");
}

export async function createBrand(db: Db, tenantId: string, input: BrandInput): Promise<BrandRow> {
  validate(input);
  const count = await db.first<{ count: number }>(
    "SELECT COUNT(*) AS count FROM brand_kits WHERE tenant_id = ? AND deleted_at IS NULL",
    [tenantId],
  );
  if ((count?.count ?? 0) >= MAX_BRANDS) {
    throw new ImageError("INVALID_INPUT", `An account can hold ${MAX_BRANDS} brand kits. Delete one first.`);
  }
  const brandId = id("brd");
  const slug = await uniqueSlug(db, tenantId, slugify(input.name));
  const timestamp = nowIso();
  await db.run(
    `INSERT INTO brand_kits (id, tenant_id, slug, name, description, style_prompt, negative_prompt, palette_json,
       typography, default_model, default_preset, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      brandId,
      tenantId,
      slug,
      input.name.trim(),
      input.description ?? null,
      input.stylePrompt ?? "",
      input.negativePrompt ?? null,
      JSON.stringify(input.palette ?? []),
      input.typography ?? null,
      input.defaultModel ?? null,
      input.defaultPreset ?? null,
      timestamp,
      timestamp,
    ],
  );
  return requireBrand(db, tenantId, brandId);
}

export async function updateBrand(db: Db, tenantId: string, idOrSlug: string, patch: BrandPatch): Promise<BrandRow> {
  validate(patch);
  const brand = await requireBrand(db, tenantId, idOrSlug);
  const next = {
    name: patch.name?.trim() || brand.name,
    description: patch.description === undefined ? brand.description : patch.description,
    style_prompt: patch.stylePrompt ?? brand.style_prompt,
    negative_prompt: patch.negativePrompt === undefined ? brand.negative_prompt : patch.negativePrompt,
    palette_json: patch.palette ? JSON.stringify(patch.palette) : brand.palette_json,
    typography: patch.typography === undefined ? brand.typography : patch.typography,
    default_model: patch.defaultModel === undefined ? brand.default_model : patch.defaultModel,
    default_preset: patch.defaultPreset === undefined ? brand.default_preset : patch.defaultPreset,
  };
  await db.run(
    `UPDATE brand_kits SET name = ?, description = ?, style_prompt = ?, negative_prompt = ?, palette_json = ?,
       typography = ?, default_model = ?, default_preset = ?, updated_at = ?
     WHERE id = ? AND tenant_id = ?`,
    [
      next.name,
      next.description,
      next.style_prompt,
      next.negative_prompt,
      next.palette_json,
      next.typography,
      next.default_model,
      next.default_preset,
      nowIso(),
      brand.id,
      tenantId,
    ],
  );
  return requireBrand(db, tenantId, brand.id);
}

/** Soft delete: the kit and its assets disappear from every tool; generated images stay. */
export async function deleteBrand(db: Db, tenantId: string, idOrSlug: string): Promise<BrandRow> {
  const brand = await requireBrand(db, tenantId, idOrSlug);
  const timestamp = nowIso();
  await db.batch([
    {
      sql: "UPDATE brand_kits SET deleted_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ?",
      params: [timestamp, timestamp, brand.id, tenantId],
    },
    {
      sql: "UPDATE brand_assets SET deleted_at = ? WHERE brand_id = ? AND tenant_id = ? AND deleted_at IS NULL",
      params: [timestamp, brand.id, tenantId],
    },
  ]);
  return brand;
}

/* ---------------------------------------------------------------- assets */

export async function listAssets(db: Db, tenantId: string, brandId: string): Promise<BrandAssetRow[]> {
  return db.all<BrandAssetRow>(
    "SELECT * FROM brand_assets WHERE tenant_id = ? AND brand_id = ? AND deleted_at IS NULL ORDER BY sort, created_at, id",
    [tenantId, brandId],
  );
}

/** Pixel size from the file header, or null when it cannot be read cheaply. */
export function imageSize(bytes: Uint8Array, mime: string): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (mime === "image/png" && bytes.length >= 24) return { width: view.getUint32(16), height: view.getUint32(20) };
  if (mime === "image/jpeg") {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) return null;
      const marker = bytes[offset + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { width: view.getUint16(offset + 7), height: view.getUint16(offset + 5) };
      }
      offset += 2 + view.getUint16(offset + 2);
    }
    return null;
  }
  if (mime === "image/webp" && bytes.length >= 30 && String.fromCharCode(...bytes.slice(12, 16)) === "VP8X") {
    const read24 = (at: number) => bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16);
    return { width: read24(24) + 1, height: read24(27) + 1 };
  }
  return null;
}

export interface AssetDeps {
  db: Db;
  bucket: R2Bucket;
}

export async function addBrandAsset(
  deps: AssetDeps,
  tenantId: string,
  brandId: string,
  input: { role: BrandAssetRow["role"]; bytes: Uint8Array; note?: string | null },
): Promise<BrandAssetRow> {
  const brand = await requireBrand(deps.db, tenantId, brandId);
  if (input.bytes.byteLength === 0 || input.bytes.byteLength > MAX_ASSET_BYTES) {
    throw new ImageError("INVALID_INPUT", `Images must be between 1 byte and ${MAX_ASSET_BYTES / 1024 / 1024} MB.`);
  }
  const mime = sniffImageMime(input.bytes);
  if (!mime) throw new ImageError("INVALID_INPUT", "Only PNG, JPEG and WebP images are accepted.");
  const existing = await listAssets(deps.db, tenantId, brand.id);
  if (existing.length >= MAX_ASSETS_PER_BRAND) {
    throw new ImageError("INVALID_INPUT", `A brand kit holds ${MAX_ASSETS_PER_BRAND} images. Remove one first.`);
  }
  const assetId = id("bas");
  const key = brandAssetKey(tenantId, assetId, extensionFor(mime));
  const size = imageSize(input.bytes, mime);
  await deps.bucket.put(key, input.bytes, { httpMetadata: { contentType: mime } });
  try {
    await deps.db.run(
      `INSERT INTO brand_assets (id, tenant_id, brand_id, role, r2_key, mime, width, height, bytes, note, sort, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        assetId,
        tenantId,
        brand.id,
        input.role,
        key,
        mime,
        size?.width ?? null,
        size?.height ?? null,
        input.bytes.byteLength,
        input.note ?? null,
        existing.length,
        nowIso(),
      ],
    );
  } catch (error) {
    await deps.bucket.delete(key);
    throw error;
  }
  const row = await deps.db.first<BrandAssetRow>("SELECT * FROM brand_assets WHERE id = ? AND tenant_id = ?", [
    assetId,
    tenantId,
  ]);
  if (!row) throw new ImageError("PROVIDER_ERROR", "The asset was not stored.", true);
  return row;
}

/** Reuses one of the account's own generated images as a brand reference. */
export async function addBrandAssetFromImage(
  deps: AssetDeps,
  tenantId: string,
  brandId: string,
  imageId: string,
  role: BrandAssetRow["role"],
  note?: string | null,
): Promise<BrandAssetRow> {
  const image = await deps.db.first<{ r2_key: string }>(
    "SELECT r2_key FROM images WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL",
    [imageId, tenantId],
  );
  if (!image) throw new ImageError("NOT_FOUND", `No image "${imageId}" in this account.`);
  const object = await deps.bucket.get(image.r2_key);
  if (!object) throw new ImageError("NOT_FOUND", `The file for image "${imageId}" is missing.`);
  return addBrandAsset(deps, tenantId, brandId, { role, bytes: new Uint8Array(await object.arrayBuffer()), note });
}

export async function removeBrandAsset(deps: AssetDeps, tenantId: string, brandId: string, assetId: string) {
  const brand = await requireBrand(deps.db, tenantId, brandId);
  const asset = await deps.db.first<BrandAssetRow>(
    "SELECT * FROM brand_assets WHERE id = ? AND tenant_id = ? AND brand_id = ? AND deleted_at IS NULL",
    [assetId, tenantId, brand.id],
  );
  if (!asset) throw new ImageError("NOT_FOUND", `No asset "${assetId}" in this brand kit.`);
  await deps.db.run("UPDATE brand_assets SET deleted_at = ? WHERE id = ? AND tenant_id = ?", [
    nowIso(),
    asset.id,
    tenantId,
  ]);
  await deps.bucket.delete(asset.r2_key);
  return asset;
}

/**
 * Downloads an image from a public HTTPS URL for use as a brand asset. Redirects are followed a few
 * times, the body is capped, and the bytes are checked by `addBrandAsset`, not the content type.
 */
export async function fetchRemoteImage(url: string, fetcher: typeof fetch = fetch): Promise<Uint8Array> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new ImageError("INVALID_INPUT", "That is not a valid image URL.");
  }
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (target.protocol !== "https:" || target.username || target.password) {
      throw new ImageError("INVALID_INPUT", "Image URLs must use https and carry no credentials.");
    }
    let response: Response;
    try {
      response = await fetcher(target, { redirect: "manual", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    } catch {
      throw new ImageError("INVALID_INPUT", "The image URL could not be fetched.");
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new ImageError("INVALID_INPUT", "The image URL redirected without a destination.");
      target = new URL(location, target);
      continue;
    }
    if (!response.ok) throw new ImageError("INVALID_INPUT", `The image URL answered ${response.status}.`);
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > MAX_ASSET_BYTES) throw new ImageError("INVALID_INPUT", "That image is larger than 10 MB.");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_ASSET_BYTES) throw new ImageError("INVALID_INPUT", "That image is larger than 10 MB.");
    return bytes;
  }
  throw new ImageError("INVALID_INPUT", "The image URL redirected too many times.");
}
