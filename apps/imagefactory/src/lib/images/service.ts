import { getWallet, listLedger } from "@templatedesign/platform/credits";
import type { Db } from "@templatedesign/platform/db";
import { nowIso } from "@templatedesign/platform/db";
import { HttpError } from "@templatedesign/platform/http";
import { takeRateLimit } from "@templatedesign/platform/rate-limit";
import type { Env } from "../types";
import {
  addBrandAsset,
  addBrandAssetFromImage,
  type BrandAssetRow,
  type BrandRow,
  brandStyle,
  createBrand,
  deleteBrand,
  fetchRemoteImage,
  findBrand,
  listAssets,
  listBrands,
  parsePalette,
  removeBrandAsset,
  requireBrand,
  updateBrand,
} from "./brands";
import { composeEdit, composeGenerate } from "./compose";
import { jobContext } from "./context";
import { ImageError } from "./errors";
import {
  type ImageRow,
  imageUrl,
  type JobContext,
  type JobParams,
  type JobRow,
  type JobSnapshot,
  pollJob,
  type ReferenceInput,
  startJob,
  waitForJob,
} from "./jobs";
import { MODELS, type ModelId } from "./models";
import { describePreset, PRESETS, resolveSize } from "./presets";
import { assertSize, creditsFor, creditsPerMp } from "./pricing";
import type {
  AddBrandAssetInput,
  CreateBrandInput,
  EditImageInput,
  EstimateCostInput,
  GenerateImageInput,
  ListImagesInput,
  UpdateBrandInput,
} from "./schemas";
import { type ImageSettings, loadImageSettings } from "./settings";
import { extensionFor, publicImageUrl, signedReferenceUrl } from "./storage";

/** Who is calling, resolved from an OAuth token, an API key or a browser session. */
export interface Caller {
  tenantId: string;
  userId: string;
  scopes: string[];
  via: "oauth" | "api_key" | "session";
}

export interface ServiceDeps {
  job: JobContext;
  settings: ImageSettings;
  /** Public origin, used to build signed links the provider fetches. */
  origin: string;
  /** Signing secret for private reference links. */
  secret: string;
  fetch?: typeof fetch;
}

export const SCOPE_READ = "images:read";
export const SCOPE_WRITE = "images:write";

/** Builds the dependencies for one request. Settings are read once, so a call sees one snapshot. */
export async function serviceDeps(env: Env): Promise<ServiceDeps> {
  const base = jobContext(env);
  const settings = await loadImageSettings(base.db);
  return {
    job: { ...base, pricing: settings.pricing, workerWaitSeconds: settings.workerWaitSeconds },
    settings,
    origin: env.APP_ORIGIN,
    secret: env.BETTER_AUTH_SECRET,
  };
}

export function assertScope(caller: Caller, scope: string): void {
  // A write grant implies read: a client that may generate may also look at what it made.
  const allowed = caller.scopes.includes(scope) || (scope === SCOPE_READ && caller.scopes.includes(SCOPE_WRITE));
  if (!allowed) {
    throw new ImageError("INSUFFICIENT_SCOPE", `This connection does not have the ${scope} permission.`, false, {
      required: scope,
    });
  }
}

const db = (deps: ServiceDeps): Db => deps.job.db;

/* ------------------------------------------------------------- results */

export interface ImageOut {
  id: string;
  url: string;
  width: number;
  height: number;
  seed: number | null;
  model: string;
  mime: string;
  bytes: number;
  title: string | null;
  created_at: string;
}

export interface GenerationResult {
  job_id: string;
  state: JobRow["state"];
  pending: boolean;
  queue_position?: number;
  images: ImageOut[];
  prompt: string;
  negative_prompt?: string;
  model: string;
  credits_reserved: number;
  credits_charged: number | null;
  blocked_count: number;
  message?: string;
}

function imageOut(deps: ServiceDeps, image: ImageRow, model: string): ImageOut {
  return {
    id: image.id,
    url: imageUrl(deps.job, image),
    width: image.width,
    height: image.height,
    seed: image.seed,
    model,
    mime: image.mime,
    bytes: image.bytes,
    title: image.title,
    created_at: image.created_at,
  };
}

function resultFrom(deps: ServiceDeps, snap: JobSnapshot): GenerationResult {
  const { job } = snap;
  const params = JSON.parse(job.params_json) as JobParams;
  if (job.state === "failed") {
    throw new ImageError(
      (job.error_code as ImageError["code"]) ?? "PROVIDER_ERROR",
      job.error_message ?? "The image could not be made.",
      false,
      { job_id: job.id },
    );
  }
  const pending = job.state !== "done";
  return {
    job_id: job.id,
    state: job.state,
    pending,
    queue_position: snap.queuePosition,
    images: snap.images.map((image) => imageOut(deps, image, job.model)),
    prompt: params.prompt,
    negative_prompt: params.negativePrompt,
    model: job.model,
    credits_reserved: job.credits_reserved,
    credits_charged: job.credits_charged,
    blocked_count: job.blocked_count,
    message: pending
      ? `Still working${snap.queuePosition !== undefined ? ` (queue position ${snap.queuePosition})` : ""}. Call get_job with this job_id in a few seconds.`
      : undefined,
  };
}

/* ----------------------------------------------------------- generation */

async function guardWrite(deps: ServiceDeps, caller: Caller): Promise<void> {
  assertScope(caller, SCOPE_WRITE);
  if (!deps.settings.enabled) throw new ImageError("PROVIDER_ERROR", "Image generation is paused. Try again later.");
  try {
    await takeRateLimit(db(deps), `images:${caller.tenantId}`, deps.settings.ratePerMinute, 60, (retry) => {
      return `Too many image requests. Try again in ${retry} seconds.`;
    });
  } catch (error) {
    if (error instanceof HttpError && error.code === "rate_limited") {
      throw new ImageError("PROVIDER_ERROR", error.message, true, { retry_after: error.headers });
    }
    throw error;
  }
}

function checkCount(deps: ServiceDeps, count: number): void {
  if (count > deps.settings.maxImagesPerCall) {
    throw new ImageError("INVALID_INPUT", `At most ${deps.settings.maxImagesPerCall} images per call.`);
  }
}

async function brandFor(deps: ServiceDeps, caller: Caller, slug: string | undefined): Promise<BrandRow | null> {
  return slug ? requireBrand(db(deps), caller.tenantId, slug) : null;
}

function sizeFor(brand: BrandRow | null, input: { preset?: string; width?: number; height?: number }) {
  const usesDimensions = input.width !== undefined && input.height !== undefined;
  try {
    return resolveSize({
      preset: usesDimensions ? undefined : (input.preset ?? brand?.default_preset ?? undefined),
      width: input.width,
      height: input.height,
    });
  } catch (error) {
    throw new ImageError("INVALID_INPUT", error instanceof Error ? error.message : "Invalid size.");
  }
}

export async function generateImages(
  deps: ServiceDeps,
  caller: Caller,
  input: GenerateImageInput,
  options: { wait?: boolean } = {},
): Promise<GenerationResult> {
  await guardWrite(deps, caller);
  checkCount(deps, input.num_images);
  const brand = await brandFor(deps, caller, input.brand);
  const size = sizeFor(brand, input);
  const modelId: ModelId = "qwen-image";
  const composed = composeGenerate({
    brand: brand ? brandStyle(brand) : null,
    prompt: input.prompt,
    text: input.text,
    variation: input.variation,
  });
  const negative = [composed.negativePrompt, input.negative_prompt].filter(Boolean).join(", ") || undefined;

  const job = await startJob(deps.job, {
    tenantId: caller.tenantId,
    userId: caller.userId,
    brandId: brand?.id,
    kind: "generate",
    modelId,
    numImages: input.num_images,
    params: {
      prompt: composed.prompt,
      userPrompt: input.prompt,
      negativePrompt: negative,
      width: size.width,
      height: size.height,
      seed: input.seed,
      outputFormat: "png",
      preset: size.preset,
      text: input.text,
      title: input.title,
      tags: input.tags,
    },
  });
  return finish(deps, caller, job, options.wait ?? true);
}

async function finish(deps: ServiceDeps, caller: Caller, job: JobRow, wait: boolean): Promise<GenerationResult> {
  const snap = wait ? await waitForJob(deps.job, caller.tenantId, job.id) : ({ job, images: [] } satisfies JobSnapshot);
  if (!snap) throw new ImageError("NOT_FOUND", "The job disappeared.");
  return resultFrom(deps, snap);
}

interface ReferenceSet {
  urls: string[];
  /** The same references as stored descriptors, so a worker gets fresh signed links when it leases the job. */
  descriptors: ReferenceInput[];
  ids: string[];
  /** Size of the first own image, used as the default output size. */
  firstSize?: { width: number; height: number };
}

async function resolveReferences(
  deps: ServiceDeps,
  caller: Caller,
  input: EditImageInput,
  brand: BrandRow | null,
): Promise<{ refs: ReferenceSet; givenCount: number; brandCount: number }> {
  const urls: string[] = [];
  const descriptors: ReferenceInput[] = [];
  const ids: string[] = [];
  let firstSize: ReferenceSet["firstSize"];
  for (const imageId of input.image_ids ?? []) {
    const row = await db(deps).first<ImageRow>(
      "SELECT * FROM images WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL",
      [imageId, caller.tenantId],
    );
    if (!row) throw new ImageError("NOT_FOUND", `No image "${imageId}" in this account.`);
    const publicUrl = publicImageUrl(deps.job.publicBase, row.id, extensionFor(row.mime));
    urls.push(publicUrl);
    descriptors.push({ url: publicUrl });
    ids.push(row.id);
    firstSize ??= { width: row.width, height: row.height };
  }
  for (const url of input.image_urls ?? []) {
    if (!url.startsWith("https://")) throw new ImageError("INVALID_INPUT", "Image URLs must use https.");
    urls.push(url);
    descriptors.push({ url });
    ids.push(url);
  }
  const givenCount = urls.length;
  if (givenCount === 0) {
    throw new ImageError("INVALID_INPUT", "Give at least one image: image_ids or image_urls.");
  }
  const limit = MODELS["qwen-edit"].referenceImages?.max ?? 3;
  let brandCount = 0;
  if (brand) {
    const assets = await listAssets(db(deps), caller.tenantId, brand.id);
    for (const asset of assets.slice(0, Math.max(0, limit - givenCount))) {
      urls.push(await signedReferenceUrl(deps.origin, deps.secret, asset.id));
      descriptors.push({ assetId: asset.id });
      ids.push(asset.id);
      brandCount += 1;
    }
  }
  return { refs: { urls, descriptors, ids, firstSize }, givenCount, brandCount };
}

export async function editImages(
  deps: ServiceDeps,
  caller: Caller,
  input: EditImageInput,
  options: { wait?: boolean } = {},
): Promise<GenerationResult> {
  await guardWrite(deps, caller);
  checkCount(deps, input.num_images);
  const brand = await brandFor(deps, caller, input.brand);
  const { refs, givenCount, brandCount } = await resolveReferences(deps, caller, input, brand);

  const explicit = input.preset !== undefined || (input.width !== undefined && input.height !== undefined);
  const fallback = brand?.default_preset ? undefined : refs.firstSize;
  const size =
    explicit || !fallback
      ? sizeFor(brand, input)
      : { width: fallback.width, height: fallback.height, preset: undefined };
  const composed = composeEdit({
    brand: brand ? brandStyle(brand) : null,
    prompt: input.instruction,
    text: input.text,
    variation: input.variation,
    givenCount,
    brandReferenceCount: brandCount,
  });
  const negative = [composed.negativePrompt, input.negative_prompt].filter(Boolean).join(", ") || undefined;

  const job = await startJob(deps.job, {
    tenantId: caller.tenantId,
    userId: caller.userId,
    brandId: brand?.id,
    kind: "edit",
    modelId: "qwen-edit",
    numImages: input.num_images,
    imageUrls: refs.urls,
    references: refs.descriptors,
    params: {
      prompt: composed.prompt,
      userPrompt: input.instruction,
      negativePrompt: negative,
      width: size.width,
      height: size.height,
      seed: input.seed,
      outputFormat: "png",
      referenceIds: refs.ids,
      preset: size.preset,
      text: input.text,
      title: input.title,
      tags: input.tags,
    },
  });
  return finish(deps, caller, job, options.wait ?? true);
}

export async function getJobResult(deps: ServiceDeps, caller: Caller, jobId: string): Promise<GenerationResult> {
  assertScope(caller, SCOPE_READ);
  const snap = await pollJob(deps.job, caller.tenantId, jobId);
  if (!snap) throw new ImageError("NOT_FOUND", `No job "${jobId}" in this account.`);
  return resultFrom(deps, snap);
}

/* -------------------------------------------------------------- pricing */

export async function estimateCost(deps: ServiceDeps, caller: Caller, input: EstimateCostInput) {
  assertScope(caller, SCOPE_READ);
  const model = MODELS[input.mode === "edit" ? "qwen-edit" : "qwen-image"];
  const size = sizeFor(null, input);
  assertSize(model, size.width, size.height, input.num_images);
  const credits = creditsFor(model, size.width, size.height, input.num_images, deps.settings.pricing);
  const wallet = await getWallet(db(deps), caller.tenantId);
  return {
    model: model.id,
    width: size.width,
    height: size.height,
    num_images: input.num_images,
    credits,
    balance: wallet.available,
    can_afford: wallet.available >= credits,
  };
}

export function listPresets(deps: ServiceDeps, caller: Caller) {
  assertScope(caller, SCOPE_READ);
  const generate = creditsPerMp(MODELS["qwen-image"], deps.settings.pricing);
  const edit = creditsPerMp(MODELS["qwen-edit"], deps.settings.pricing);
  return {
    presets: Object.values(PRESETS).map((preset) => ({
      ...describePreset(preset, generate),
      credits_per_image_edit: describePreset(preset, edit).credits_per_image,
    })),
    note: "credits_per_image is for generate_image; credits_per_image_edit is for edit_image. Custom sizes are billed per started megapixel.",
  };
}

export async function getBalance(deps: ServiceDeps, caller: Caller) {
  assertScope(caller, SCOPE_READ);
  const wallet = await getWallet(db(deps), caller.tenantId);
  const ledger = await listLedger(db(deps), caller.tenantId, 10);
  return {
    available: wallet.available,
    reserved: wallet.reserved,
    free: wallet.free,
    purchased: wallet.purchased,
    recent: ledger.map((row) => ({
      kind: row.kind,
      credits: row.credits,
      job_id: row.job_id,
      at: row.created_at,
    })),
  };
}

/* --------------------------------------------------------------- brands */

function brandView(row: BrandRow, assetCount?: number) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    style_prompt: row.style_prompt,
    negative_prompt: row.negative_prompt,
    palette: parsePalette(row.palette_json),
    typography: row.typography,
    default_model: row.default_model,
    default_preset: row.default_preset,
    asset_count: assetCount,
    updated_at: row.updated_at,
  };
}

export async function listBrandKits(deps: ServiceDeps, caller: Caller) {
  assertScope(caller, SCOPE_READ);
  const rows = await listBrands(db(deps), caller.tenantId);
  return { brands: rows.map((row) => brandView(row, row.asset_count)) };
}

async function assetView(deps: ServiceDeps, asset: BrandAssetRow) {
  return {
    id: asset.id,
    role: asset.role,
    note: asset.note,
    width: asset.width,
    height: asset.height,
    preview_url: await signedReferenceUrl(deps.origin, deps.secret, asset.id),
  };
}

export async function getBrandKit(deps: ServiceDeps, caller: Caller, idOrSlug: string) {
  assertScope(caller, SCOPE_READ);
  const brand = await requireBrand(db(deps), caller.tenantId, idOrSlug);
  const assets = await listAssets(db(deps), caller.tenantId, brand.id);
  return {
    ...brandView(brand, assets.length),
    assets: await Promise.all(assets.map((asset) => assetView(deps, asset))),
    preview_note: "preview_url links expire after 10 minutes.",
  };
}

export async function createBrandKit(deps: ServiceDeps, caller: Caller, input: CreateBrandInput) {
  assertScope(caller, SCOPE_WRITE);
  const row = await createBrand(db(deps), caller.tenantId, {
    name: input.name,
    description: input.description,
    stylePrompt: input.style_prompt,
    negativePrompt: input.negative_prompt,
    palette: input.palette,
    typography: input.typography,
    defaultModel: input.default_model,
    defaultPreset: input.default_preset,
  });
  return brandView(row, 0);
}

export async function updateBrandKit(deps: ServiceDeps, caller: Caller, input: UpdateBrandInput) {
  assertScope(caller, SCOPE_WRITE);
  const row = await updateBrand(db(deps), caller.tenantId, input.brand, {
    name: input.name,
    description: input.description,
    stylePrompt: input.style_prompt,
    negativePrompt: input.negative_prompt,
    palette: input.palette,
    typography: input.typography,
    defaultModel: input.default_model,
    defaultPreset: input.default_preset,
  });
  const assets = await listAssets(db(deps), caller.tenantId, row.id);
  return brandView(row, assets.length);
}

export async function deleteBrandKit(deps: ServiceDeps, caller: Caller, idOrSlug: string) {
  assertScope(caller, SCOPE_WRITE);
  const row = await deleteBrand(db(deps), caller.tenantId, idOrSlug);
  return { deleted: true, slug: row.slug };
}

export async function addAsset(deps: ServiceDeps, caller: Caller, input: AddBrandAssetInput) {
  assertScope(caller, SCOPE_WRITE);
  if (!input.image_url === !input.image_id) {
    throw new ImageError("INVALID_INPUT", "Give exactly one of image_url or image_id.");
  }
  const assetDeps = { db: db(deps), bucket: deps.job.images };
  const brand = await requireBrand(db(deps), caller.tenantId, input.brand);
  const asset = input.image_id
    ? await addBrandAssetFromImage(assetDeps, caller.tenantId, brand.id, input.image_id, input.role, input.note)
    : await addBrandAsset(assetDeps, caller.tenantId, brand.id, {
        role: input.role,
        note: input.note,
        bytes: await fetchRemoteImage(input.image_url as string, deps.fetch),
      });
  return assetView(deps, asset);
}

export async function removeAsset(deps: ServiceDeps, caller: Caller, brand: string, assetId: string) {
  assertScope(caller, SCOPE_WRITE);
  const asset = await removeBrandAsset({ db: db(deps), bucket: deps.job.images }, caller.tenantId, brand, assetId);
  return { removed: true, asset_id: asset.id };
}

/* --------------------------------------------------------------- images */

function encodeCursor(row: Pick<ImageRow, "created_at" | "id">): string {
  return btoa(`${row.created_at}|${row.id}`).replace(/=+$/, "");
}

function decodeCursor(cursor: string): { createdAt: string; id: string } | null {
  try {
    const [createdAt, id] = atob(cursor).split("|");
    return createdAt && id ? { createdAt, id } : null;
  } catch {
    return null;
  }
}

export async function listImages(deps: ServiceDeps, caller: Caller, input: ListImagesInput) {
  assertScope(caller, SCOPE_READ);
  const clauses = ["i.tenant_id = ?", "i.deleted_at IS NULL"];
  const params: unknown[] = [caller.tenantId];
  if (input.brand) {
    const brand = await findBrand(db(deps), caller.tenantId, input.brand);
    if (!brand) throw new ImageError("NOT_FOUND", `No brand kit "${input.brand}".`);
    clauses.push("i.brand_id = ?");
    params.push(brand.id);
  }
  if (input.tag) {
    clauses.push("instr(i.tags, ?) > 0");
    params.push(JSON.stringify(input.tag));
  }
  if (input.cursor) {
    const cursor = decodeCursor(input.cursor);
    if (!cursor) throw new ImageError("INVALID_INPUT", "That cursor is not valid.");
    clauses.push("(i.created_at < ? OR (i.created_at = ? AND i.id < ?))");
    params.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }
  const rows = await db(deps).all<ImageRow & { model: string }>(
    `SELECT i.*, j.model AS model FROM images i JOIN image_jobs j ON j.id = i.job_id AND j.tenant_id = i.tenant_id
     WHERE ${clauses.join(" AND ")} ORDER BY i.created_at DESC, i.id DESC LIMIT ?`,
    [...params, input.limit + 1],
  );
  const page = rows.slice(0, input.limit);
  return {
    images: page.map((row) => imageOut(deps, row, row.model)),
    next_cursor: rows.length > input.limit ? encodeCursor(page[page.length - 1]) : null,
  };
}

export async function getImageDetail(deps: ServiceDeps, caller: Caller, imageId: string) {
  assertScope(caller, SCOPE_READ);
  const row = await db(deps).first<ImageRow & { model: string; params_json: string; brand_slug: string | null }>(
    `SELECT i.*, j.model AS model, j.params_json AS params_json, b.slug AS brand_slug
     FROM images i JOIN image_jobs j ON j.id = i.job_id AND j.tenant_id = i.tenant_id
     LEFT JOIN brand_kits b ON b.id = i.brand_id AND b.tenant_id = i.tenant_id
     WHERE i.id = ? AND i.tenant_id = ? AND i.deleted_at IS NULL`,
    [imageId, caller.tenantId],
  );
  if (!row) throw new ImageError("NOT_FOUND", `No image "${imageId}" in this account.`);
  const params = JSON.parse(row.params_json) as JobParams;
  return {
    ...imageOut(deps, row, row.model),
    job_id: row.job_id,
    brand: row.brand_slug,
    prompt: params.prompt,
    your_prompt: params.userPrompt ?? null,
    negative_prompt: params.negativePrompt ?? null,
    preset: params.preset ?? null,
    references: params.referenceIds ?? [],
    tags: row.tags ? (JSON.parse(row.tags) as string[]) : [],
    remix_hint: "Pass this seed and prompt to generate_image, or this image_id to edit_image, to make variations.",
  };
}

export async function deleteImageById(deps: ServiceDeps, caller: Caller, imageId: string) {
  assertScope(caller, SCOPE_WRITE);
  const result = await db(deps).run(
    "UPDATE images SET deleted_at = ? WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL",
    [nowIso(), imageId, caller.tenantId],
  );
  if (result.changes === 0) throw new ImageError("NOT_FOUND", `No image "${imageId}" in this account.`);
  return { deleted: true, image_id: imageId };
}

/** Most bytes one preview may carry, and the budget for all previews in one reply. */
export const PREVIEW_MAX_BYTES = 750 * 1024;
export const PREVIEW_TOTAL_BYTES = 1536 * 1024;

export interface PreviewBlock {
  data: string;
  mimeType: string;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

/**
 * Inline previews for the images small enough to send in a tool reply. Larger images are left
 * out: the reply always carries the public URL, and some clients render only that.
 */
export async function loadPreviews(deps: ServiceDeps, caller: Caller, images: ImageOut[]): Promise<PreviewBlock[]> {
  const previews: PreviewBlock[] = [];
  let total = 0;
  for (const image of images) {
    if (image.bytes > PREVIEW_MAX_BYTES || total + image.bytes > PREVIEW_TOTAL_BYTES) continue;
    const row = await db(deps).first<{ r2_key: string }>(
      "SELECT r2_key FROM images WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL",
      [image.id, caller.tenantId],
    );
    const object = row ? await deps.job.images.get(row.r2_key) : null;
    if (!object) continue;
    previews.push({ data: toBase64(new Uint8Array(await object.arrayBuffer())), mimeType: image.mime });
    total += image.bytes;
  }
  return previews;
}
