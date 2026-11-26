import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ImageError } from "../src/lib/images/errors";
import type { JobContext } from "../src/lib/images/jobs";
import { editImageSchema, generateImageSchema } from "../src/lib/images/schemas";
import {
  addAsset,
  type Caller,
  createBrandKit,
  deleteBrandKit,
  deleteImageById,
  editImages,
  estimateCost,
  generateImages,
  getBalance,
  getBrandKit,
  getImageDetail,
  getJobResult,
  listBrandKits,
  listImages,
  removeAsset,
  type ServiceDeps,
  updateBrandKit,
} from "../src/lib/images/service";
import { DEFAULT_SETTINGS } from "../src/lib/images/settings";
import "../src/lib/platform";
import { createTestDb } from "./support/db";
import { FakeBucket, FakeProvider, fakeImageFetch, PNG_BYTES } from "./support/fakes";

const here = dirname(fileURLToPath(import.meta.url));
const A: Caller = { tenantId: "ten_a", userId: "usr_a", scopes: ["images:read", "images:write"], via: "oauth" };
const B: Caller = { tenantId: "ten_b", userId: "usr_b", scopes: ["images:read", "images:write"], via: "api_key" };

const MARKER_STYLE = "MARKER-A-STYLE-7f3";
const MARKER_PROMPT = "MARKER-A-PROMPT-91c";

const TENANT_TABLES = ["image_jobs", "images", "brand_kits", "brand_assets", "wallets", "ledger_entries"];

async function setup() {
  const { db, raw, close } = createTestDb();
  for (const id of ["ten_a", "ten_b"]) {
    await db.run("INSERT INTO tenants (id, name, created_at) VALUES (?, ?, '2026-01-01T00:00:00Z')", [id, id]);
  }
  const bucket = new FakeBucket();
  const provider = new FakeProvider({
    status: { state: "done" },
    result: {
      seed: 3,
      images: [{ url: "https://fal.test/o.png", width: 816, height: 1224, contentType: "image/png", blocked: false }],
    },
  });
  const job: JobContext = {
    db,
    images: bucket.asBucket(),
    provider,
    publicBase: "https://imagefactory.test/i",
    webhookUrl: "https://imagefactory.test/api/v1/fal-webhook",
    fetchImage: fakeImageFetch,
    sleep: async () => undefined,
  };
  const deps: ServiceDeps = {
    job,
    settings: DEFAULT_SETTINGS,
    origin: "https://imagefactory.test",
    secret: "secret",
    fetch: (async () => new Response(PNG_BYTES)) as unknown as typeof fetch,
  };
  return { db, raw, close, bucket, deps };
}

/** Every row of every tenant table, as comparable text, for one tenant. */
async function snapshot(db: Awaited<ReturnType<typeof setup>>["db"], tenantId: string): Promise<string> {
  const out: Record<string, unknown[]> = {};
  for (const table of TENANT_TABLES) {
    out[table] = await db.all(`SELECT * FROM ${table} WHERE tenant_id = ? ORDER BY 1`, [tenantId]);
  }
  return JSON.stringify(out);
}

test("account B cannot read, change, spend against or delete anything account A owns", async () => {
  const { db, deps, close, bucket } = await setup();
  try {
    const brand = await createBrandKit(deps, A, {
      name: "Secret Brand",
      style_prompt: MARKER_STYLE,
      palette: [{ name: "primary", hex: "#112233" }],
    });
    const asset = await addAsset(deps, A, {
      brand: brand.slug,
      image_url: "https://example.com/a.png",
      role: "reference",
    });
    const made = await generateImages(deps, A, generateImageSchema.parse({ prompt: MARKER_PROMPT, brand: brand.slug }));
    const image = made.images[0];
    const privateObjects = [...bucket.objects.keys()].filter((key) => key.startsWith("brand/ten_a/"));
    assert.equal(privateObjects.length, 1);

    const before = await snapshot(db, "ten_a");
    const bBefore = await snapshot(db, "ten_b");
    const walletBefore = await getBalance(deps, A);

    const refusals: Array<[string, () => Promise<unknown>]> = [
      ["get_brand by id", () => getBrandKit(deps, B, brand.id)],
      ["get_brand by slug", () => getBrandKit(deps, B, brand.slug)],
      ["update_brand", () => updateBrandKit(deps, B, { brand: brand.slug, name: "Taken over", style_prompt: "x" })],
      ["delete_brand", () => deleteBrandKit(deps, B, brand.slug)],
      [
        "add_brand_asset to A's brand",
        () => addAsset(deps, B, { brand: brand.slug, image_url: "https://example.com/b.png", role: "reference" }),
      ],
      [
        "add_brand_asset from A's image",
        async () => {
          const mine = await createBrandKit(deps, B, { name: "Mine" });
          return addAsset(deps, B, { brand: mine.slug, image_id: image.id, role: "example" });
        },
      ],
      ["remove_brand_asset", () => removeAsset(deps, B, brand.slug, asset.id)],
      [
        "generate_image with A's brand",
        () => generateImages(deps, B, generateImageSchema.parse({ prompt: "x", brand: brand.slug })),
      ],
      [
        "edit_image of A's image",
        () => editImages(deps, B, editImageSchema.parse({ instruction: "x", image_ids: [image.id] })),
      ],
      [
        "edit_image with A's brand",
        () =>
          editImages(deps, B, editImageSchema.parse({ instruction: "x", image_ids: [image.id], brand: brand.slug })),
      ],
      ["get_job", () => getJobResult(deps, B, made.job_id)],
      ["get_image", () => getImageDetail(deps, B, image.id)],
      ["delete_image", () => deleteImageById(deps, B, image.id)],
      ["list_images filtered by A's brand", () => listImages(deps, B, { limit: 20, brand: brand.slug })],
    ];
    for (const [name, run] of refusals) {
      await assert.rejects(run, (error: unknown) => error instanceof ImageError && error.code === "NOT_FOUND", name);
    }

    // Listings simply show B nothing of A's.
    const listed = JSON.stringify([
      await listBrandKits(deps, B),
      await listImages(deps, B, { limit: 50 }),
      await getBalance(deps, B),
      await estimateCost(deps, B, { preset: "pin", num_images: 1, mode: "generate" }),
    ]);
    for (const secret of [MARKER_STYLE, MARKER_PROMPT, brand.id, brand.slug, asset.id, image.id, made.job_id]) {
      assert.ok(!listed.includes(secret), `B's listings leak ${secret}`);
    }

    // Nothing of A's moved, and A still has its credits and its image.
    assert.equal(await snapshot(db, "ten_a"), before);
    assert.deepEqual(await getBalance(deps, A), walletBefore);
    assert.equal((await getImageDetail(deps, A, image.id)).id, image.id);
    // B only gained the brand kit it made itself.
    assert.notEqual(await snapshot(db, "ten_b"), bBefore);
    assert.equal((await listBrandKits(deps, B)).brands.length, 1);
    assert.equal((await listBrandKits(deps, B)).brands[0].name, "Mine");
  } finally {
    close();
  }
});

/**
 * Static guard: every statement on a tenant table names tenant_id, so a hand-written query that
 * forgets the predicate fails here. Each exception is a lookup that is keyed by an id the server
 * made and that cannot be reached with a caller-supplied id.
 */
const ALLOWED: Array<{ file: string; pattern: RegExp; reason: string }> = [
  { file: "pages/i/[file].ts", pattern: /FROM images/, reason: "public image host: the 128-bit id is the capability" },
  {
    file: "pages/i/ref/[id].ts",
    pattern: /FROM brand_assets/,
    reason: "reference link: the HMAC signature is the capability",
  },
  {
    file: "lib/images/jobs.ts",
    pattern: /\bimage_jobs\b/,
    reason: "internal job transitions keyed by a server-made job id (webhook, sweep, claim)",
  },
  {
    file: "lib/images/jobs.ts",
    pattern: /\bimages\b/,
    reason: "image rows are inserted for the job's own tenant under the claim guard",
  },
  {
    file: "lib/images/worker-jobs.ts",
    pattern: /\bimage_jobs\b/,
    reason:
      "the worker lane serves every account's queue; each transition is keyed by a server-made job id and lease token",
  },
  {
    file: "pages/admin/jobs.astro",
    pattern: /FROM image_jobs/,
    reason: "admin console: aggregate view across accounts, behind requireAdmin",
  },
  {
    file: "pages/admin/workers.astro",
    pattern: /FROM image_jobs/,
    reason: "admin console: open jobs counted per lane, behind requireAdmin",
  },
  { file: "lib/platform.ts", pattern: /image_jobs/, reason: "admin metrics aggregate across accounts" },
  { file: "lib/ops.ts", pattern: /FROM image_jobs/, reason: "daily digest totals the whole service" },
  {
    file: "lib/ops.ts",
    pattern: /FROM images|DELETE FROM images/,
    reason: "retention removes expired deletions for every account",
  },
];

function* sources(directory: string): Generator<string> {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) yield* sources(path);
    else if (/\.(?:ts|tsx|astro)$/.test(name)) yield path;
  }
}

test("every query on a tenant table carries a tenant_id predicate unless it is a listed exception", () => {
  const root = join(here, "..", "src");
  const tables = ["image_jobs", "images", "brand_kits", "brand_assets"];
  const pattern = new RegExp(`\\b(?:FROM|JOIN|INTO|UPDATE)\\s+(${tables.join("|")})\\b`);
  const offenders: string[] = [];
  for (const file of sources(root)) {
    const rel = relative(root, file);
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((text, index) => {
      const match = pattern.exec(text);
      if (!match) return;
      const window = lines.slice(index, index + 8).join("\n");
      if (/tenant_id/.test(window)) return;
      if (ALLOWED.some((entry) => entry.file === rel && entry.pattern.test(text))) return;
      offenders.push(`${rel}:${index + 1} ${text.trim()}`);
    });
  }
  assert.deepEqual(offenders, []);
});
