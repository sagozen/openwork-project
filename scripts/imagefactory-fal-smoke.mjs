#!/usr/bin/env node
/**
 * Live check of the two fal.ai models ImageFactory uses. Manual: it spends real money, about
 * $0.02 for the generate call and $0.03 for the edit call at one megapixel.
 *
 *   FAL_KEY=... node scripts/imagefactory-fal-smoke.mjs [--skip-edit]
 *
 * Prints the queue timings, the output size and the byte size of each result, which is what
 * decides whether an inline preview fits under the MCP image-block limit.
 */
const key = process.env.FAL_KEY;
if (!key) {
  console.error("Set FAL_KEY first (the same key the Worker uses).");
  process.exit(2);
}

const headers = { authorization: `Key ${key}`, "content-type": "application/json", "x-fal-store-io": "0" };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function run(label, endpoint, body) {
  const started = Date.now();
  const submit = await fetch(`https://queue.fal.run/${endpoint}`, { method: "POST", headers, body: JSON.stringify(body) });
  if (!submit.ok) throw new Error(`${label} submit failed: ${submit.status} ${await submit.text()}`);
  const job = await submit.json();
  const submitted = Date.now() - started;
  let state = "IN_QUEUE";
  let polls = 0;
  while (state !== "COMPLETED") {
    await sleep(polls < 3 ? 1000 : 2000);
    const status = await fetch(job.status_url, { headers });
    state = (await status.json()).status;
    polls += 1;
    if (Date.now() - started > 120_000) throw new Error(`${label} did not finish in 120 s`);
  }
  const finished = Date.now() - started;
  const result = await (await fetch(job.response_url, { headers })).json();
  const out = [];
  for (const image of result.images ?? []) {
    const download = await fetch(image.url);
    const bytes = (await download.arrayBuffer()).byteLength;
    out.push({ url: image.url, width: image.width, height: image.height, type: image.content_type, kilobytes: Math.round(bytes / 1024) });
  }
  console.log(JSON.stringify({ label, submitMs: submitted, totalMs: finished, seed: result.seed, nsfw: result.has_nsfw_concepts, images: out }, null, 2));
  return out;
}

const generated = await run("generate (qwen-image-2512)", "fal-ai/qwen-image-2512", {
  prompt: "A tidy desk with a large-print puzzle book, flat design, warm palette. Text on image, exactly: \"Large Print\"",
  image_size: { width: 816, height: 1224 },
  num_images: 1,
  output_format: "png",
  acceleration: "regular",
});

if (!process.argv.includes("--skip-edit") && generated[0]) {
  await run("edit (qwen-image-edit-2511)", "fal-ai/qwen-image-edit-2511", {
    prompt: "Using image 1 as the style reference, the same desk at night with a lamp",
    image_urls: [generated[0].url],
    image_size: { width: 816, height: 1224 },
    num_images: 1,
    output_format: "png",
    acceleration: "regular",
  });
}
