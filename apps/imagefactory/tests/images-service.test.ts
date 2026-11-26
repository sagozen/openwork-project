import assert from "node:assert/strict";
import { test } from "node:test";
import { composeEdit, composeGenerate } from "../src/lib/images/compose";
import { ImageError } from "../src/lib/images/errors";
import type { JobContext } from "../src/lib/images/jobs";
import { PRESETS, resolveSize } from "../src/lib/images/presets";
import { editImageSchema, generateImageSchema } from "../src/lib/images/schemas";
import {
  addAsset,
  type Caller,
  createBrandKit,
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
  listPresets,
  removeAsset,
  type ServiceDeps,
  updateBrandKit,
} from "../src/lib/images/service";
import { DEFAULT_SETTINGS } from "../src/lib/images/settings";
import { sniffImageMime } from "../src/lib/images/storage";
import "../src/lib/platform";
import { createTestDb } from "./support/db";
import { FakeBucket, FakeProvider, fakeImageFetch, PNG_BYTES } from "./support/fakes";

const A: Caller = { tenantId: "ten_a", userId: "usr_a", scopes: ["images:read", "images:write"], via: "oauth" };
const B: Caller = { tenantId: "ten_b", userId: "usr_b", scopes: ["images:read", "images:write"], via: "api_key" };
const READ_ONLY: Caller = { ...A, scopes: ["images:read"] };

async function setup() {
  const { db, close } = createTestDb();
  for (const id of ["ten_a", "ten_b"]) {
    await db.run("INSERT INTO tenants (id, name, created_at) VALUES (?, ?, '2026-01-01T00:00:00Z')", [id, id]);
  }
  const bucket = new FakeBucket();
  const provider = new FakeProvider();
  let now = Date.parse("2026-11-06T00:00:00Z");
  const job: JobContext = {
    db,
    images: bucket.asBucket(),
    provider,
    publicBase: "https://imagefactory.test/i",
    webhookUrl: "https://imagefactory.test/api/v1/fal-webhook",
    fetchImage: fakeImageFetch,
    sleep: async (ms) => {
      now += ms;
    },
    now: () => now,
  };
  const deps: ServiceDeps = {
    job,
    settings: DEFAULT_SETTINGS,
    origin: "https://imagefactory.test",
    secret: "test-secret",
    fetch: (async () => new Response(PNG_BYTES, { status: 200 })) as unknown as typeof fetch,
  };
  const finishWith = (count: number, seed = 11) => {
    provider.status_ = { state: "done" };
    provider.result_ = {
      images: Array.from({ length: count }, () => ({
        url: "https://fal.test/o.png",
        width: 816,
        height: 1224,
        contentType: "image/png",
        blocked: false,
      })),
      seed,
    };
  };
  return { db, close, bucket, provider, deps, finishWith };
}

const generate = (overrides: Record<string, unknown> = {}) =>
  generateImageSchema.parse({ prompt: "A watercolor bird", ...overrides });

test("generate composes the brand style and returns public urls", async () => {
  const { deps, close, finishWith, provider } = await setup();
  try {
    await createBrandKit(deps, A, {
      name: "LargePrint Puzzles",
      style_prompt: "Friendly flat illustration with thick outlines",
      palette: [{ name: "primary", hex: "#1a73e8" }],
      typography: "bold rounded sans-serif",
      negative_prompt: "photo, clutter",
    });
    finishWith(2);
    const result = await generateImages(
      deps,
      A,
      generate({ brand: "largeprint-puzzles", num_images: 2, text: "Birds" }),
    );
    assert.equal(result.pending, false);
    assert.equal(result.images.length, 2);
    assert.match(result.images[0].url, /^https:\/\/imagefactory\.test\/i\/[a-z2-7]{26}\.png$/);
    assert.equal(result.credits_charged, 8);
    assert.match(result.prompt, /Style: Friendly flat illustration/);
    assert.match(result.prompt, /primary #1a73e8/);
    assert.match(result.prompt, /Text on image, exactly: "Birds"\./);
    assert.equal(provider.submits[0].negativePrompt, "photo, clutter");
    assert.equal(provider.submits[0].width, 816);
  } finally {
    close();
  }
});

test("a slow job comes back pending with a job id, and get_job finishes it", async () => {
  const { deps, close, provider, finishWith } = await setup();
  try {
    provider.status_ = { state: "queued", queuePosition: 2 };
    const pending = await generateImages(deps, A, generate());
    assert.equal(pending.pending, true);
    assert.equal(pending.queue_position, 2);
    assert.equal(pending.images.length, 0);
    finishWith(1);
    const done = await getJobResult(deps, A, pending.job_id);
    assert.equal(done.pending, false);
    assert.equal(done.images.length, 1);
  } finally {
    close();
  }
});

test("a failed job is reported as an error with its code", async () => {
  const { deps, close, provider } = await setup();
  try {
    provider.status_ = { state: "done" };
    provider.result_ = async () => {
      throw new ImageError("INVALID_INPUT", "prompt rejected", false);
    };
    await assert.rejects(
      () => generateImages(deps, A, generate()),
      (error: unknown) => error instanceof ImageError && error.code === "INVALID_INPUT",
    );
    assert.equal((await getBalance(deps, A)).available, 50);
  } finally {
    close();
  }
});

test("the kill switch and the read-only scope both stop a generate before any credit moves", async () => {
  const { deps, close } = await setup();
  try {
    await assert.rejects(
      () => generateImages({ ...deps, settings: { ...DEFAULT_SETTINGS, enabled: false } }, A, generate()),
      (error: unknown) => error instanceof ImageError && /paused/.test(error.message),
    );
    await assert.rejects(
      () => generateImages(deps, READ_ONLY, generate()),
      (error: unknown) => error instanceof ImageError && error.code === "INSUFFICIENT_SCOPE",
    );
    assert.equal((await getBalance(deps, A)).available, 50);
    assert.ok((await getBalance(deps, READ_ONLY)).available === 50, "a write grant is not needed to read");
  } finally {
    close();
  }
});

test("the per-account rate limit refuses the call after the allowance is used", async () => {
  const { deps, close, finishWith } = await setup();
  try {
    finishWith(1);
    const limited = { ...deps, settings: { ...DEFAULT_SETTINGS, ratePerMinute: 2 } };
    await generateImages(limited, A, generate());
    await generateImages(limited, A, generate());
    await assert.rejects(
      () => generateImages(limited, A, generate()),
      (error: unknown) => error instanceof ImageError && /Too many/.test(error.message),
    );
    // Another account has its own bucket.
    await generateImages(limited, B, generate());
  } finally {
    close();
  }
});

test("edit puts the supplied images first and the brand references after them", async () => {
  const { deps, close, finishWith, provider } = await setup();
  try {
    await createBrandKit(deps, A, { name: "Brand", style_prompt: "Flat" });
    await addAsset(deps, A, { brand: "brand", image_url: "https://example.com/logo.png", role: "reference" });
    finishWith(1);
    const first = await generateImages(deps, A, generate());
    const edited = await editImages(
      deps,
      A,
      editImageSchema.parse({ instruction: "Make the sky purple", image_ids: [first.images[0].id], brand: "brand" }),
    );
    const request = provider.submits.at(-1);
    assert.equal(request?.imageUrls?.length, 2);
    assert.equal(request?.imageUrls?.[0], first.images[0].url);
    assert.match(
      request?.imageUrls?.[1] ?? "",
      /^https:\/\/imagefactory\.test\/i\/ref\/bas_[a-f0-9]{32}\?exp=\d+&sig=[a-f0-9]{64}$/,
    );
    assert.match(
      edited.prompt,
      /^Using image 2 as the brand style reference and image 1 as the subject, make the sky purple\./,
    );
    assert.equal(edited.model, "qwen-edit");
    // 816 x 1224 edit at 6 credits per MP.
    assert.equal(edited.credits_charged, 6);
    const detail = await getImageDetail(deps, A, edited.images[0].id);
    assert.equal(detail.brand, "brand");
    assert.equal(detail.references.length, 2);
  } finally {
    close();
  }
});

test("edit needs an image and refuses one that belongs to another account", async () => {
  const { deps, close, finishWith } = await setup();
  try {
    finishWith(1);
    const theirs = await generateImages(deps, B, generate());
    await assert.rejects(
      () => editImages(deps, A, editImageSchema.parse({ instruction: "Change it", image_ids: [theirs.images[0].id] })),
      (error: unknown) => error instanceof ImageError && error.code === "NOT_FOUND",
    );
    await assert.rejects(
      () => editImages(deps, A, editImageSchema.parse({ instruction: "Change it" })),
      (error: unknown) => error instanceof ImageError && error.code === "INVALID_INPUT",
    );
    assert.equal((await getBalance(deps, A)).available, 50);
  } finally {
    close();
  }
});

test("brand kits are private to their account", async () => {
  const { deps, close, finishWith } = await setup();
  try {
    const mine = await createBrandKit(deps, A, { name: "Mine" });
    await addAsset(deps, A, { brand: mine.slug, image_url: "https://example.com/a.png", role: "logo" });
    assert.equal((await listBrandKits(deps, B)).brands.length, 0);
    await assert.rejects(() => getBrandKit(deps, B, mine.slug), /No brand kit/);
    await assert.rejects(() => updateBrandKit(deps, B, { brand: mine.id, name: "Stolen" }), /No brand kit/);
    await assert.rejects(
      () => generateImages(deps, B, generate({ brand: mine.slug })),
      (error: unknown) => error instanceof ImageError && error.code === "NOT_FOUND",
    );
    const asset = (await getBrandKit(deps, A, mine.slug)).assets[0];
    await assert.rejects(() => removeAsset(deps, B, mine.slug, asset.id), /No brand kit/);
    // The same slug is free in the other account.
    const theirs = await createBrandKit(deps, B, { name: "Mine" });
    assert.equal(theirs.slug, "mine");
    finishWith(1);
  } finally {
    close();
  }
});

test("brand assets are checked by their bytes and capped per kit", async () => {
  const { deps, close } = await setup();
  try {
    const brand = await createBrandKit(deps, A, { name: "Assets" });
    const svgFetch = (async () =>
      new Response("<svg xmlns='http://www.w3.org/2000/svg'/>", {
        headers: { "content-type": "image/png" },
      })) as unknown as typeof fetch;
    await assert.rejects(
      () =>
        addAsset({ ...deps, fetch: svgFetch }, A, {
          brand: brand.slug,
          image_url: "https://example.com/x.png",
          role: "reference",
        }),
      /Only PNG, JPEG and WebP/,
    );
    await assert.rejects(
      () => addAsset(deps, A, { brand: brand.slug, image_url: "http://example.com/x.png", role: "reference" }),
      /https/,
    );
    for (let index = 0; index < 12; index += 1) {
      await addAsset(deps, A, { brand: brand.slug, image_url: `https://example.com/${index}.png`, role: "example" });
    }
    await assert.rejects(
      () => addAsset(deps, A, { brand: brand.slug, image_url: "https://example.com/13.png", role: "example" }),
      /holds 12 images/,
    );
    assert.equal(sniffImageMime(PNG_BYTES), "image/png");
  } finally {
    close();
  }
});

test("a generated image can become a brand reference, but only from the same account", async () => {
  const { deps, close, finishWith } = await setup();
  try {
    finishWith(1);
    const mine = await generateImages(deps, A, generate());
    const theirs = await generateImages(deps, B, generate());
    const brand = await createBrandKit(deps, A, { name: "From images" });
    const asset = await addAsset(deps, A, { brand: brand.slug, image_id: mine.images[0].id, role: "example" });
    assert.match(asset.preview_url, /\/i\/ref\//);
    await assert.rejects(
      () => addAsset(deps, A, { brand: brand.slug, image_id: theirs.images[0].id, role: "example" }),
      /No image/,
    );
  } finally {
    close();
  }
});

test("images list newest first with a cursor, filter by tag and brand, and disappear when deleted", async () => {
  const { deps, close, finishWith } = await setup();
  try {
    const brand = await createBrandKit(deps, A, { name: "List" });
    finishWith(1);
    const first = await generateImages(deps, A, generate({ tags: ["pin", "birds"] }));
    const second = await generateImages(deps, A, generate({ tags: ["blog"], brand: brand.slug }));
    await generateImages(deps, B, generate({ tags: ["pin"] }));

    const all = await listImages(deps, A, { limit: 20 });
    assert.equal(all.images.length, 2);

    const page = await listImages(deps, A, { limit: 1 });
    assert.equal(page.images.length, 1);
    assert.ok(page.next_cursor);
    const next = await listImages(deps, A, { limit: 1, cursor: page.next_cursor ?? undefined });
    assert.equal(next.images.length, 1);
    assert.notEqual(next.images[0].id, page.images[0].id);
    assert.equal(next.next_cursor, null);

    assert.deepEqual(
      (await listImages(deps, A, { limit: 20, tag: "birds" })).images.map((image) => image.id),
      [first.images[0].id],
    );
    assert.deepEqual(
      (await listImages(deps, A, { limit: 20, brand: brand.slug })).images.map((image) => image.id),
      [second.images[0].id],
    );

    await assert.rejects(() => deleteImageById(deps, B, first.images[0].id), /No image/);
    await deleteImageById(deps, A, first.images[0].id);
    assert.equal((await listImages(deps, A, { limit: 20 })).images.length, 1);
    await assert.rejects(() => getImageDetail(deps, A, first.images[0].id), /No image/);
  } finally {
    close();
  }
});

test("jobs are private to their account", async () => {
  const { deps, close, finishWith } = await setup();
  try {
    finishWith(1);
    const mine = await generateImages(deps, A, generate());
    await assert.rejects(
      () => getJobResult(deps, B, mine.job_id),
      (error: unknown) => error instanceof ImageError && error.code === "NOT_FOUND",
    );
  } finally {
    close();
  }
});

test("estimate reports the credits for a size and whether the balance covers it", async () => {
  const { deps, close } = await setup();
  try {
    const small = await estimateCost(deps, A, { preset: "pin", num_images: 3, mode: "generate" });
    assert.equal(small.credits, 12);
    assert.equal(small.can_afford, true);
    const big = await estimateCost(deps, A, { width: 2048, height: 1536, num_images: 4, mode: "edit" });
    assert.equal(big.credits, 96);
    assert.equal(big.can_afford, false);
    const presets = listPresets(deps, A).presets;
    assert.deepEqual(
      presets.map((preset) => [preset.id, preset.credits_per_image]),
      [
        ["pin", 4],
        ["pin_hd", 8],
        ["square", 4],
        ["blog_hero", 4],
        ["cover_6x9", 8],
      ],
    );
  } finally {
    close();
  }
});

test("schemas reject unknown fields, and presets stay at or under the megapixel they are billed at", () => {
  assert.throws(() => generateImageSchema.parse({ prompt: "x", tenant_id: "ten_b" }));
  assert.throws(() => editImageSchema.parse({ instruction: "x", user_id: "usr_b" }));
  assert.throws(() => generateImageSchema.parse({ prompt: "x", image_urls: ["https://a.test/x.png"] }));
  assert.equal(generateImageSchema.parse({ prompt: "x" }).num_images, 1);
  assert.deepEqual(resolveSize({}), { width: 816, height: 1224, preset: "pin" });
  assert.deepEqual(resolveSize({ preset: "square" }), { width: 992, height: 992, preset: "square" });
  assert.throws(() => resolveSize({ preset: "poster" }));
  for (const preset of Object.values(PRESETS)) {
    assert.equal(preset.width % 8, 0);
    assert.equal(preset.height % 8, 0);
  }
});

test("compose output for each shape of request", () => {
  const brand = {
    name: "LargePrint",
    stylePrompt: "Friendly flat illustration",
    negativePrompt: "photo",
    palette: [
      { name: "primary", hex: "#1a73e8" },
      { name: "accent", hex: "#fbbc04" },
    ],
    typography: "bold rounded sans-serif",
  };
  assert.deepEqual(composeGenerate({ prompt: "A pin about birds" }), {
    prompt: "A pin about birds. No text.",
    negativePrompt: undefined,
  });
  assert.deepEqual(
    composeGenerate({ prompt: "A pin about birds", brand, text: 'Big "Bird" Search', variation: "night version" }),
    {
      prompt:
        "A pin about birds. Style: Friendly flat illustration. Colour palette: primary #1a73e8, accent #fbbc04. Typography: bold rounded sans-serif. Variation: night version. Text on image, exactly: \"Big 'Bird' Search\".",
      negativePrompt: "photo",
    },
  );
  assert.equal(
    composeEdit({ prompt: "Make it night", givenCount: 1, brandReferenceCount: 0 }).prompt,
    "Using image 1 as the reference, make it night.",
  );
  assert.equal(
    composeEdit({ prompt: "Same style, new topic", givenCount: 0, brandReferenceCount: 2, brand }).prompt,
    "Using images 1 to 2 as the brand style reference, same style, new topic. Style: Friendly flat illustration. Colour palette: primary #1a73e8, accent #fbbc04. Typography: bold rounded sans-serif.",
  );
});
