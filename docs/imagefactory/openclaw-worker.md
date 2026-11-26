# ImageFactory OpenClaw worker

An agent running in OpenClaw makes the images; fal.ai is the backup. The design is the one TranscriptAnything uses
for its transcriber: the worker **pulls** jobs over outbound HTTPS from `/api/internal/worker/*`, the Cloudflare
Worker never calls it, and a crashed worker simply lets the lease expire. No inbound port, tunnel or fixed IP is
needed on the OpenClaw machine.

```
Claude / ChatGPT / n8n ──► ImageFactory (generate_image, edit_image)
                              │  reserve credits, queue the job
                              ▼
              ┌─── worker online? ───┐
        yes   ▼                      ▼  no, stalled, or failed twice
  OpenClaw host: worker.mjs ◄── lease     fal.ai queue API + webhook
        │  asks the agent to render
        ▼
  OpenClaw agent (image_generate or any tool it has) saves out-1.png …
        │
        ▼
  worker.mjs uploads the files ──► ImageFactory stores them in R2, settles credits
```

The agent only does the creative step. Leasing, lease extension, file checks and upload stay in
`services/openclaw-worker/worker.mjs`, because a language model is a poor choice for a polling loop.

## Setup

1. **Deploy** the Worker version that has the worker lane. `./deploy-cf.sh imagefactory` applies the migration
   `0008_worker_lane` first.
2. **Register the worker.** Sign in as an admin, open `/admin/workers/`, enter a name such as `openclaw-mac-mini`
   and press *Register worker*. Copy the `wkr_...` token: it is shown once and only its hash is stored.
3. **Install the poller** on the machine that runs OpenClaw. It needs Node 20 or newer and nothing else. In
   `services/openclaw-worker`, copy `env.example` to a private settings file, fill `IMAGEFACTORY_WORKER_TOKEN`, export
   its variables into the shell, then:

   ```bash
   node worker.mjs --check     # one heartbeat; prints the effective settings
   node worker.mjs             # run; use a service manager (launchd, systemd, pm2) for production
   ```

4. **Confirm** the worker shows *online* in `/admin/workers/` within about 20 seconds.
5. **Make one image** from Claude. While it runs the job shows lane `worker` in `/admin/workers/`, and the daily
   digest counts it under `worker_images`.

Keep the token out of chat, git and screenshots. Rotating it in admin keeps the old token valid for 24 hours so the
machine can be updated without dropping a running job.

## What the agent must be able to do

The default command is `openclaw agent --message "<task>"`, which runs one agent turn. Change `OPENCLAW_BIN` and
`OPENCLAW_ARGS` if your OpenClaw version or setup differs (for example to pick a dedicated agent). The task text is
always appended as the final argument. The agent needs:

- an image tool (OpenClaw's built-in `image_generate`, or any other model or API it has), with editing for
  `edit_image` jobs; if it cannot edit, set `KINDS=generate` and edits go to fal.ai;
- permission to write files into the job directory named in the task.

The task tells the agent the prompt, the negative prompt, the size, how many images, an optional seed, the local
paths of any reference images, and exactly where to save the result (`out-1.png`, `out-2.png`, ...). It must end
with one line: `DONE <model name>`, `FAILED <reason>` or `BLOCKED <reason>`. The files are the source of truth:
OpenClaw's image tool can finish as a background task after the agent's turn ended, so the worker keeps waiting for
the files for `OUTPUT_GRACE_SECONDS` after the turn is over.

The poller itself fetches reference images for edit jobs. Those links can come from users, so it only follows https links
to public addresses, refuses redirects and caps a download at 25 MB; a link into your own network fails the job.

A dedicated agent for this job, with its own workspace, only the image tool and file access, and no chat channels,
is the safest setup: prompts come from ImageFactory users, so treat them as untrusted input.

The agent does not have to hit the exact size. It should use the closest size with the same aspect ratio; the server
reads the real size from the file header. A prompt the agent refuses (`BLOCKED`) ends the job and returns the
credits; any other failure goes back to the queue.

## Lanes and fallback

| Situation | What happens |
|---|---|
| A worker that can take the job sent a heartbeat in the last 60 s | The job is queued for the worker |
| No such worker, or an edit while the worker declared `KINDS=generate`, or a size above `MAX_MEGAPIXELS` | The job goes to fal.ai at once |
| Queued but nobody leased it for *Seconds a job waits for a worker* (default 45) | fal.ai takes it |
| The worker went offline after the job was queued | fal.ai takes it at the next poll or sweep |
| A lease ran out (no extension for 180 s) | Offered again once; after two attempts fal.ai takes it |
| The worker reported a failure | Back to the queue once; the second failure goes to fal.ai |
| The worker reported `BLOCKED` or `INVALID_INPUT` | The job ends, nothing is charged |
| Not finished after 30 minutes | The sweep fails the job and releases the credits |

Credits are reserved when the job is created and are untouched by a move to fal.ai. Completion settles them in one
guarded database batch, so a late, duplicated or foreign completion changes nothing and cannot charge twice.
Pricing is the same on both lanes. If fal.ai is the fallback and its balance is empty, the job fails with fal's own
message and the credits are released.

## Worker API

All routes are `POST` with `Authorization: Bearer wkr_...` and answer 401 to anything else.

| Route | Body | Answer |
|---|---|---|
| `/api/internal/worker/heartbeat` | `{ version, capabilities: { kinds, maxMegapixels, concurrency, engine } }` | `200 { ok }`. Send every ~20 s |
| `/api/internal/worker/lease` | `{ wait_seconds }` (max 25) | `204`, or `200 { job, lease_token, lease_expires_at, lease_seconds }` |
| `/api/internal/worker/jobs/:id/extend` | `{ lease_token }` | `200`, or `409` when the lease is gone: stop |
| `/api/internal/worker/jobs/:id/complete` | multipart: `meta` JSON `{ lease_token, model, seed? }` plus files `image0`, `image1`, ... | `200 { accepted, job }`, `400` for bad files, `409` when the lease is gone |
| `/api/internal/worker/jobs/:id/fail` | `{ lease_token, code, message }` | `200 { accepted, outcome }` (`failed`, `requeued`, `rerouted`), or `409` |

The leased `job` carries `id`, `kind`, `prompt` (brand style already composed in), `negative_prompt`, `width`,
`height`, `num_images`, `seed`, `output_format`, `references` and `attempt`. Reference links for private brand
assets are signed for ten minutes at lease time, so download them straight away. Files must be PNG, JPEG or WebP and
at most 25 MB each; up to `num_images` are accepted and credits are charged per image received.

The lease lasts 180 s and the poller extends it every 60 s. A job may run for `JOB_TIMEOUT_SECONDS` (default 420)
before the poller gives up and reports a failure.

## Operating it

- **Logs:** the poller prints one JSON line per event (`worker_started`, `job_leased`, `job_finished`, `lease_lost`,
  `complete_refused`, ...). Server-side problems appear in `npx wrangler tail imagefactory-web --format json`.
- **Switch it off:** *Disable* the worker in `/admin/workers/`. Jobs go to fal.ai within the wait setting.
- **Go back to fal.ai only:** stop the poller. After a minute without a heartbeat every new job uses fal.ai.
- **More than one job at a time:** raise `CONCURRENCY` only after measuring; each job is a separate agent turn.
- **What is and is not tested:** the lane logic is covered by `apps/imagefactory/tests/worker-lane.test.ts`, the poller
  by `npm run test:openclaw-worker` against a stub server and a fake agent, and `scripts/smoke-imagefactory.sh` checks
  that the worker routes refuse anything without a worker token. Nothing automated runs a real OpenClaw agent, so the
  first real image is the check that the command line and task wording work on your install: make one and read the
  poller log.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `/admin/workers/` shows *offline* | The poller is not running, the token is wrong (`token_rejected` in its log), or the machine cannot reach `https://imagefactory.zhst.app` |
| Jobs always go to fal.ai | The worker is offline or disabled, `KINDS` excludes the job type, or the size is above `MAX_MEGAPIXELS` |
| `No image was produced` | The agent finished without saving `out-N` files: check its tool access and the job directory, or raise `OUTPUT_GRACE_SECONDS` for slow background tasks |
| `lease_lost` in the poller log | The job was moved to fal.ai or ended while the agent worked; nothing is charged twice |
| Every job fails twice and ends on fal.ai | Read the `fail` messages in the poller log; the agent command line is usually wrong (`node worker.mjs --check` prints it) |
