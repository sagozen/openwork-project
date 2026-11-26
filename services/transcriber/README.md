# Transcriber worker

One Go program, two deployments:

| Deployment | Tier | Engine | Why |
|---|---|---|---|
| Home Windows desktop (Xeon E5-2678 v3, RX 6800 16 GB, 32 GB RAM) | `primary` | `whisper-cli.exe` with Vulkan | The GPU sits idle otherwise; roughly an order of magnitude faster than the VPS CPU |
| VPS (4 vCPU EPYC Zen 1, 8 GB) | `fallback` | `whisper-cli` CPU in Docker | Takes over when the desktop is off, asleep or backlogged |

The Worker never calls the desktop. Both processes **pull** work over outbound HTTPS from
`/api/internal/worker/*`, holding the lease request open for 20 s. No inbound port, no fixed home
IP, and a crash simply lets the lease expire so the minute cron requeues the job.

Lease numbers that matter while debugging: TTL **180 s**, extend every **60 s**, worst case before a
crashed job is retried **≈4 min** (see the Worker docs).

## Layout

```
cmd/transcriber        main: config, signal handling, manager
internal/config        environment → Config (all values have safe defaults)
internal/client        the worker API (heartbeat, lease, extend, urls, complete, fail)
internal/lease         heartbeat loop + dynamic slots; lease extension; graceful shutdown
internal/pipeline      probe | transcribe orchestration and typed failure codes
internal/sources       URL resolution, yt-dlp, Drive/OneDrive/RSS, SSRF guard
internal/media         ffmpeg → 16 kHz mono WAV, ffprobe duration
internal/whisper       whisper.cpp invocation and JSON parsing
internal/formats       normalised transcript JSON + SRT/VTT/TXT/word-SRT renderers
internal/metrics       host CPU/RAM/disk/temperatures + 24 h in-memory history
internal/dashboard     loopback UI (embedded HTML/CSS/JS, no external assets)
internal/jobs          in-memory active/finished job view for the dashboard
internal/runtimecfg    boot config + the remote-config subset, clamped twice
internal/update        release check, SHA-256 download, PowerShell swap + rollback
internal/logring       last 500 log lines for the dashboard
internal/version       version.txt (written by an update) over the env value
internal/disk, proc    free-space guard and process-tree control (unix/windows)
deploy/                Windows installer, CPU Dockerfile, VPS compose file
```

---

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `TRANSCRIBER_API_URL` | — | Required. `https://transcriptanything.zhst.app` |
| `TRANSCRIBER_WORKER_TOKEN` | — | Required. Admin → Workers → Register; rotate there |
| `TRANSCRIBER_TIER` | `primary` | `primary` or `fallback` |
| `TRANSCRIBER_NAME` | hostname | Shown in admin |
| `TRANSCRIBER_VERSION` | `dev` | Boot value only; `version.txt` written by an auto-update wins |
| `CONCURRENCY` | `1` | Job slots. Keep 1 on the VPS; >1 on the GPU only after measuring |
| `MAX_AUDIO_SECONDS` | `10800` | Longer jobs wait for a worker that can take them |
| `CAN_DOWNLOAD_YOUTUBE` | `true` | Set `false` where the IP gets challenged |
| `CAN_DOWNLOAD_TIKTOK` | `true` | Same idea |
| `WHISPER_BIN` | `whisper-cli` | Absolute path in the Windows service |
| `WHISPER_MODEL` | `models/ggml-large-v3-turbo-q5_0.bin` | Quantised large-v3-turbo |
| `WHISPER_THREADS` | `4` | CPU threads; irrelevant on the GPU path |
| `FFMPEG_BIN` / `FFPROBE_BIN` | `ffmpeg` / `ffprobe` | |
| `YTDLP_BIN` | `yt-dlp` | |
| `TRANSCRIBER_TEMP` | OS temp | Per-job directory, removed after every job |
| `MIN_FREE_DISK_GB` | `5` | Below this the worker refuses a job and reports `disk_full` |
| `HEARTBEAT_SECONDS` / `EXTEND_SECONDS` | `20` / `60` | |
| `JOB_TIMEOUT_MINUTES` | `240` | Hard stop for one job |
| `DASHBOARD_ADDR` | `127.0.0.1:8787` | Loopback only; `off` disables. A non-loopback bind is disabled (the worker keeps running) |
| `TRANSCRIBER_STATE_DIR` | executable directory | Version file, update staging, `update.log`, `update-worker.ps1` |
| `METRICS_SECONDS` | `15` | CPU/RAM/disk sample interval |
| `TEMP_SECONDS` | `30` | Sensor query interval (LibreHardwareMonitor / ACPI) |
| `SENSORS_URL` | `http://127.0.0.1:8085/data.json` | LibreHardwareMonitor JSON endpoint; empty disables it |
| `AUTO_UPDATE` | `false` | Installer sets `true`; a remote config can turn it off but not on where this is `false` |
| `UPDATE_SERVICE` | empty | Windows service that the updater stops and restarts. Installer sets `TranscriptWorker` |

There is no local state: everything the worker needs is in the job it leased. Two workers on one
machine with the same token would double-book the GPU — register one worker per machine.

---

## Build

```bash
cd services/transcriber
go test ./... && go vet ./...

# Linux (VPS image does this itself)
CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o transcriber ./cmd/transcriber

# Windows (home desktop)
GOOS=windows GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o deploy/windows/transcriber.exe ./cmd/transcriber
```

CI runs `go test`, `go vet` and `GOOS=windows go build`, because process-tree control and path
handling are the parts that break only on Windows.

---

## Home Windows desktop (primary)

### What must already be on the machine

- Windows 10/11 64-bit, an AMD Adrenalin driver new enough to ship the Vulkan ICD.
- ~20 GB free disk (model ~1.1 GB quantised, plus per-job temp files).
- The Microsoft Visual C++ runtime, which the whisper.cpp release needs (`vc_redist.x64.exe`).
- Outbound HTTPS only. No firewall rule, no port, no tunnel on the job path.
- [LibreHardwareMonitor](https://github.com/LibreHardwareMonitor/LibreHardwareMonitor) for CPU and
  RX 6800 temperatures (the installer registers it as the **TranscriptWorkerSensors** service). Without
  it the worker falls back to the ACPI thermal zone: CPU temperature may be missing and GPU
  temperature is reported as unavailable.

### Install

Register the worker in Admin → Workers first (name `home-gpu`, tier `primary`) and copy the
`wkr_…` token; it is shown once.

```powershell
# from services/transcriber/deploy/windows/, elevated PowerShell
powershell -ExecutionPolicy Bypass -File install-worker.ps1 `
  -ApiUrl "https://transcriptanything.zhst.app" `
  -WorkerToken "wkr_..." `
  -WhisperModel "large-v3-turbo-q5_0" `
  -Concurrency 1
```

Pass `-WorkerVersion "1.9.0"` if you want the first heartbeat to report the build you copied.
Without it the worker reports `0.0.0` until the first published release auto-updates it.

The script:

1. downloads whisper.cpp (Vulkan build), ffmpeg/ffprobe, yt-dlp and the model into
   `%ProgramData%\TranscriptWorker`;
2. writes `worker.env` with every absolute path;
3. registers **TranscriptWorker** via NSSM with auto-start, restart-on-exit and 10 MB log rotation;
4. registers **TranscriptWorkerSensors** (LibreHardwareMonitor) with its loopback sensor API enabled at boot;
5. writes the dashboard, metrics and auto-update settings;
6. prints the BIOS/Windows settings you still have to apply by hand.

### First checks

```powershell
Get-Service TranscriptWorker
Get-Content "$env:ProgramData\TranscriptWorker\worker.log" -Tail 40
```

Expected lines: `worker_started` with `tier:"primary"`, then a heartbeat every 20 s. Admin → Workers
must show `online`, the version, `maxAudioSeconds`, `canDownloadYoutube=yes`, and CPU/RAM/disk
values. Open **http://127.0.0.1:8787/** on the machine for the local dashboard: live metrics,
sparklines, running/finished jobs, the applied remote config and the log tail.

The installer enables LibreHardwareMonitor's local web server and adds the HTTP URL reservation.
Check it with:

```powershell
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8085/data.json | Select-Object StatusCode
```

A `200` means the worker can read CPU and GPU temperatures. If it fails, start
**TranscriptWorkerSensors**, check `%ProgramData%\TranscriptWorker\sensors.log`, and confirm
`LibreHardwareMonitor.exe.config` has `runWebServerMenuItem=true` and `listenerPort=8085`. The worker
keeps transcribing either way and falls back to WMI (older LHM builds) and ACPI.

Then run one short job and confirm the **GPU** did the work: the whisper log line must name
`AMD Radeon RX 6800`. If it names the CPU, Vulkan is missing — the worker still runs, at maybe a
tenth of the speed, which looks like "the queue is always busy".

### Existing installations

Workers installed before this version have no dashboard, sensor service or auto-update. Rerun
`install-worker.ps1` once with the same token (it is safe: it stops the service, updates files and
restarts), or add `AUTO_UPDATE`, `UPDATE_SERVICE`, `DASHBOARD_ADDR` and `SENSORS_URL` to
`worker.env` by hand.

### Change configuration

Most values are now edited in **Admin → Workers → Remote configuration** and applied on the next
heartbeat (about 20 s): tier, job slots (resized live), max audio, YouTube/TikTok downloads, minimum
free disk, auto-update and the warning thresholds.

Boot-only values (paths, whisper model, threads, temp root, token) still live in `worker.env`:

```powershell
notepad "$env:ProgramData\TranscriptWorker\worker.env"
Restart-Service TranscriptWorker
```

### Upgrade, rollback and auto-update

Build and publish a release in **Admin → Workers → Worker releases** (Windows/amd64). The worker
learns about it from the heartbeat, downloads it from a short-lived signed R2 URL, verifies the
SHA-256 and stages it. It only applies the update when **no job is running**:

1. the worker starts a detached `update-worker.ps1`, which stops **TranscriptWorker**;
2. the script copies the current exe to `transcriber.previous.exe`, moves the staged exe into place
   and writes `version.txt`;
3. it starts the service and waits 10 s; if the service is not running, it restores
   `transcriber.previous.exe` and starts that instead.

Check progress in the local dashboard (updater pill) or in
`%ProgramData%\TranscriptWorker\update.log`. A nightly build can also be installed by hand:

```powershell
Stop-Service TranscriptWorker
Copy-Item .\transcriber.exe "$env:ProgramData\TranscriptWorker\transcriber.exe" -Force
Set-Content "$env:ProgramData\TranscriptWorker\version.txt" "1.9.0" -NoNewline
Start-Service TranscriptWorker
```

Auto-update is disabled by default outside the installer; the VPS container never replaces its own
binary (deploy a new image there).

### Do not run it in WSL or Docker

Inside WSL2 the RX 6800 is only reachable through a D3D12 translation layer and ROCm does not
support RX 6000 cards. WSL keeps only `cloudflared` for remote admin; it is not on the job path.

---

## VPS fallback

### Install

```bash
cd services/transcriber

cat > deploy/.env <<'ENV'
TRANSCRIBER_API_URL=https://transcriptanything.zhst.app
TRANSCRIBER_WORKER_TOKEN=wkr_...        # Admin → Workers → Register, tier=fallback
TRANSCRIBER_NAME=vps-cpu
MAX_AUDIO_SECONDS=3600
CONCURRENCY=1
ENV
chmod 600 deploy/.env

docker compose -f deploy/docker-compose.vps.yml build
docker compose -f deploy/docker-compose.vps.yml up -d
```

The image builds whisper.cpp without Vulkan (`-t 4`), installs ffmpeg + yt-dlp, and caps memory at
6 GB so it cannot OOM the container that keeps the tunnel alive.

### Model

The first start expects `/models/ggml-large-v3-turbo-q5_0.bin` in the `models` volume:

```bash
docker compose -f deploy/docker-compose.vps.yml run --rm --entrypoint sh transcriber -c \
  'apt-get update && apt-get install -y curl && \
   curl -L -o /models/ggml-large-v3-turbo-q5_0.bin \
   https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin'
```

### Checks

```bash
docker compose -f deploy/docker-compose.vps.yml ps
docker compose -f deploy/docker-compose.vps.yml logs --tail 40 transcriber
docker stats --no-stream            # stay under the 6 GB cap
```

Admin → Workers must show `tier=fallback`, `online`. With the home worker healthy, the VPS should
take **no** transcription work — only probes. If it starts transcribing while the GPU is online,
check the fallback threshold (`transcript.fallback_after_seconds`, default 90 s).

### Maintenance

- The container has no dashboard (`DASHBOARD_ADDR=off`) and never self-updates; remote config still
  applies the tier, caps, thresholds and concurrency. Ship a new image for code changes.
- `yt-dlp -U` inside the container (or rebuild the image) when a source breaks.
- Raise `MAX_AUDIO_SECONDS` only after the phase-0 benchmark says the box keeps up; long media on a
  Zen 1 CPU is how the queue-age alert starts.
- Log rotation is in the compose file; `docker system prune` monthly for old images.

---

## Metrics, warnings and remote config

Every heartbeat (20 s) carries `metrics`: CPU %, RAM used/total, disk free/total on the temp volume,
CPU temperature, GPU temperature/usage and the active job count. The Worker stores one row per
worker per minute in `worker_metrics` (14 days) and keeps `workers.metrics_json` for the admin view.
The worker keeps 24 h of samples in memory, resets them with the process, and the dashboard renders the last hour.

Warnings are transition-based, not sample-based: after two consecutive minutes over a threshold the
Worker emails `ADMIN_EMAILS` with the `worker_alert` template, and after three consecutive minutes
under threshold minus 5 points it emails a recovery. The defaults are CPU 95%, RAM 92%, free disk
10%, CPU 90 °C and GPU 90 °C; all are editable per worker. Email still needs the platform provider
(`EMAIL_PROVIDER` / `RESEND_API_KEY` / `POSTMARK_TOKEN` / the `EMAIL` binding) and `ADMIN_EMAILS`.

Remote config is validated twice: the Worker clamps everything again, so a bad admin value can
never raise concurrency above 8 or the audio cap above 12 h. `tier` from the config also updates the
registry column, which is what the lease router reads.

---

## Failure codes

The worker reports one typed code; the UI turns it into a per-platform fix instruction.

| Code | Retry | Meaning |
|---|---|---|
| `not_public` | no | Drive/OneDrive/YouTube link is not shared publicly |
| `login_required` | no | source needs a sign-in |
| `removed` | no | file or video is gone |
| `geo_blocked` | no | blocked from this worker's region |
| `no_media` | no | no audio/video stream at the URL |
| `unsupported` | no | source we do not handle |
| `private_address` / `insecure_url` | no | SSRF guard |
| `source_unavailable` | **yes** | transient network/5xx — retried up to 3 attempts |
| `disk_full` | **yes** | below `MIN_FREE_DISK_GB`; job goes back to the queue |
| `media_too_large` → `too_long` | no | above the 4 GB download guard |

Deterministic failures fail on the first attempt, so a corrupt file does not burn three GPU runs.
Only `source_unavailable` and `disk_full` are retried.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Service starts then stops (1067) | `worker.env` unreadable or paths wrong | Run `transcriber.exe` in a console with the same env; the log line says which variable is missing |
| `EPERM`/exit `0xC0000135` | missing DLLs next to `whisper-cli.exe` or no VC++ runtime | Copy the release DLLs into `bin\`, install `vc_redist.x64.exe` |
| Log shows CPU, not RX 6800 | Vulkan ICD not found | Install/repair Adrenalin; `vulkaninfo` must list the GPU |
| `401 unauthenticated` from the API | token revoked/rotated past the 24 h overlap | Register or rotate again, update `worker.env`, restart |
| Worker online but never leases | `maxAudioSeconds` below every queued job, or the VPS is waiting for the primary | Admin → Workers shows capabilities; check `/admin/jobs` |
| `disk_full` loop | temp dir on a small volume | Set `TRANSCRIBER_TEMP` to a larger disk; the worker deletes per-job dirs itself |
| `yt-dlp` 403 / "sign in to confirm" | datacenter IP challenge | `yt-dlp -U`; set `CAN_DOWNLOAD_YOUTUBE=false` on that machine |
| Jobs finish but no transcript | result upload rejected | R2 S3 credentials (`R2_*`) missing on the Worker, not the transcriber |
| Heartbeat every 20 s but admin shows silent | clock skew | Sync time (`w32tm /resync` / `chronyd`) |
| Dashboard shows "sensor unavailable" | LHM missing, stopped, or its web server is off | `Invoke-WebRequest http://127.0.0.1:8085/data.json`; start **TranscriptWorkerSensors**; check `sensors.log` and the URL reservation |
| Auto-update stuck at `staged` | `UPDATE_SERVICE` empty or not a Windows service | Install with the installer (sets `TranscriptWorker`); read `update.log` |
| `update failed: ...` in `update.log` | service did not come back | The script already restored `transcriber.previous.exe`; check the Windows service log, then publish a fixed release |
| Email warnings stop after three | intentional throttle (3/hour/kind) | The condition is still recorded in Admin → Workers; the next recovery always emails |

---

## Tests

```bash
go test ./...
go vet ./...
GOOS=windows GOARCH=amd64 go build ./...
```

Unit coverage: SRT/VTT timing and word grouping, URL classification and the SSRF guard, whisper JSON
and timestamp parsing, LHM/ACPI sensor parsing, CPU-percent maths, config clamping, the update
downloader/checksum/version comparison, the job registry and dashboard handlers. The lease protocol
and the remote config/metrics/alerts contract are covered by the Worker's TypeScript tests
(`npm run test:transcript`). Windows-only sensor and updater code is cross-compiled in CI
(`GOOS=windows go build`).
