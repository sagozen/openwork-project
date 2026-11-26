"use strict";

const REFRESH_MS = 2000;

const el = (id) => document.getElementById(id);

function bytes(value) {
  if (typeof value !== "number" || !isFinite(value) || value <= 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 10 || unit === 0 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`;
}

function percent(value) {
  return typeof value === "number" && isFinite(value) ? value : null;
}

function fixed(value, digits = 1) {
  return typeof value === "number" && isFinite(value) ? value.toFixed(digits) : "—";
}

function memoryPercent(metrics) {
  if (!metrics || !metrics.memTotalBytes) return null;
  return (metrics.memUsedBytes / metrics.memTotalBytes) * 100;
}

function diskFreePercent(metrics) {
  if (!metrics || !metrics.diskTotalBytes) return null;
  return (metrics.diskFreeBytes / metrics.diskTotalBytes) * 100;
}

function duration(seconds) {
  if (typeof seconds !== "number" || seconds < 0) return "—";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${Math.round(seconds % 60)}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function clock(value) {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "—";
  return parsed.toLocaleTimeString();
}

function sparkline(points, values) {
  const numbers = values.filter((value) => typeof value === "number" && isFinite(value));
  if (numbers.length < 2) {
    points.setAttribute("points", "");
    return;
  }
  const max = Math.max(...numbers, 1);
  const min = Math.min(...numbers, 0);
  const span = max - min || 1;
  const step = 100 / (values.length - 1 || 1);
  const coordinates = [];
  values.forEach((value, index) => {
    if (typeof value !== "number" || !isFinite(value)) return;
    const x = index * step;
    const y = 34 - ((value - min) / span) * 30;
    coordinates.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  });
  points.setAttribute("points", coordinates.join(" "));
}

function setWarn(card, warn) {
  card.classList.toggle("warn", Boolean(warn));
}

function renderCards(data) {
  const metrics = data.metrics || {};
  const history = Array.isArray(data.history) ? data.history : [];
  const config = data.config || {};
  const alerts = config.alerts || {};

  const cpu = percent(metrics.cpuPercent);
  el("cpu-value").textContent = cpu === null ? "—" : Math.round(cpu);
  el("cpu-sub").textContent = `${metrics.cpuCount || "—"} cores`;
  sparkline(el("cpu-spark"), history.map((sample) => sample.cpuPercent));
  setWarn(el("card-cpu"), alerts.enabled && cpu !== null && cpu >= alerts.cpuPercent);

  const memory = memoryPercent(metrics);
  el("mem-value").textContent = memory === null ? "—" : Math.round(memory);
  el("mem-sub").textContent =
    metrics.memTotalBytes > 0 ? `${bytes(metrics.memUsedBytes)} of ${bytes(metrics.memTotalBytes)}` : "—";
  sparkline(el("mem-spark"), history.map(memoryPercent));
  setWarn(el("card-mem"), alerts.enabled && memory !== null && memory >= alerts.memPercent);

  const disk = diskFreePercent(metrics);
  el("disk-value").textContent = disk === null ? "—" : Math.round(disk);
  el("disk-sub").textContent =
    metrics.diskTotalBytes > 0 ? `${bytes(metrics.diskFreeBytes)} free of ${bytes(metrics.diskTotalBytes)}` : "—";
  sparkline(el("disk-spark"), history.map(diskFreePercent));
  setWarn(el("card-disk"), alerts.enabled && disk !== null && disk <= alerts.diskFreePercent);

  const cpuTemp = percent(metrics.cpuTempC);
  el("cpu-temp-value").textContent = fixed(cpuTemp, 1);
  el("cpu-temp-sub").textContent = metrics.tempSource
    ? `source: ${metrics.tempSource.replace("librehardwaremonitor", "LibreHardwareMonitor")}`
    : "sensor unavailable";
  sparkline(el("cpu-temp-spark"), history.map((sample) => sample.cpuTempC));
  setWarn(el("card-cpu-temp"), alerts.enabled && cpuTemp !== null && cpuTemp >= alerts.cpuTempC);

  const gpuTemp = percent(metrics.gpuTempC);
  el("gpu-temp-value").textContent = fixed(gpuTemp, 1);
  const gpuParts = [];
  if (metrics.gpuName) gpuParts.push(metrics.gpuName);
  if (typeof metrics.gpuUsagePercent === "number") gpuParts.push(`load ${Math.round(metrics.gpuUsagePercent)}%`);
  if (!gpuTemp) gpuParts.push("install LibreHardwareMonitor for GPU temperature");
  el("gpu-temp-sub").textContent = gpuParts.join(" · ");
  sparkline(el("gpu-temp-spark"), history.map((sample) => sample.gpuTempC));
  setWarn(el("card-gpu-temp"), alerts.enabled && gpuTemp !== null && gpuTemp >= alerts.gpuTempC);

  const active = (data.jobs && data.jobs.active) || [];
  el("job-value").textContent = String(active.length);
  el("job-limit").textContent = String(config.concurrency || 1);
  el("job-sub").textContent = active.length === 0 ? "idle" : `${active.length} running`;
  el("card-jobs").classList.toggle("busy", active.length > 0);
}

function renderActive(data) {
  const container = el("active-jobs");
  const active = (data.jobs && data.jobs.active) || [];
  container.textContent = "";
  if (active.length === 0) {
    container.className = "empty";
    container.textContent = "No job is running.";
    return;
  }
  container.className = "";
  const list = document.createElement("ul");
  list.className = "job-list";
  for (const job of active) {
    const item = document.createElement("li");
    const title = document.createElement("span");
    title.className = "job-title";
    title.textContent = job.title || job.sourceRef || job.id;
    const meta = document.createElement("span");
    meta.className = "muted small";
    const parts = [job.stage, job.sourceKind, `slot ${job.slot}`, `attempt ${job.attempts || 1}`];
    if (job.durationSeconds) parts.push(`${Math.round(job.durationSeconds / 60)} min audio`);
    parts.push(`running ${duration(job.elapsedSeconds)}`);
    meta.textContent = parts.join(" · ");
    item.append(title, meta);
    list.append(item);
  }
  container.append(list);
}

function renderFinished(data) {
  const body = el("finished-jobs");
  const empty = el("finished-empty");
  const rows = (data.jobs && data.jobs.finished) || [];
  body.textContent = "";
  empty.hidden = rows.length > 0;
  el("finished-count").textContent = rows.length ? `(${rows.length})` : "";
  for (const job of rows.slice().reverse().slice(0, 20)) {
    const row = document.createElement("tr");
    const cells = [
      job.title || (job.id || "").slice(0, 12),
      job.stage || "—",
      job.sourceKind || "—",
      job.outcome === "ok" ? "ok" : `failed${job.errorCode ? ` (${job.errorCode})` : ""}`,
      duration(job.elapsedSeconds),
      clock(job.endedAt),
    ];
    cells.forEach((value, index) => {
      const cell = document.createElement(index === 0 ? "th" : "td");
      if (index === 0) cell.scope = "row";
      if (index === 4) cell.className = "num";
      cell.textContent = value;
      if (index === 3) cell.classList.add(job.outcome === "ok" ? "ok" : "bad");
      row.append(cell);
    });
    body.append(row);
  }
}

function renderConfig(data) {
  const config = data.config || {};
  const alerts = config.alerts || {};
  const list = el("config");
  list.textContent = "";
  const rows = [
    ["Tier", config.tier || "—"],
    ["Slots", String(config.concurrency ?? "—")],
    ["Max audio", config.maxAudioSeconds ? `${Math.round(config.maxAudioSeconds / 60)} min` : "—"],
    ["YouTube / TikTok", `${config.canDownloadYoutube ? "yes" : "no"} / ${config.canDownloadTiktok ? "yes" : "no"}`],
    ["Min free disk", `${config.minFreeDiskGb ?? "—"} GB`],
    ["Auto update", config.autoUpdate ? "on" : "off"],
    [
      "Alert thresholds",
      alerts.enabled
        ? `CPU ${alerts.cpuPercent}% · RAM ${alerts.memPercent}% · disk ${alerts.diskFreePercent}% · CPU ${alerts.cpuTempC}°C · GPU ${alerts.gpuTempC}°C`
        : "disabled",
    ],
    ["Applied config", data.configVersion ? `v${data.configVersion}` : "environment only"],
  ];
  for (const [key, value] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = key;
    const dd = document.createElement("dd");
    dd.textContent = value;
    list.append(dt, dd);
  }
  const note = el("config-note");
  const update = data.update || {};
  if (update.error) {
    note.textContent = `Updater: ${update.state} — ${update.error}`;
    note.classList.toggle("bad", update.state === "failed");
  } else {
    note.textContent = "Applied from the heartbeat; changes arrive within about 20 seconds.";
    note.classList.remove("bad");
  }
}

function renderUpdate(data) {
  const update = data.update || { state: "disabled" };
  const pill = el("update-pill");
  const version = update.version ? ` ${update.version}` : "";
  pill.textContent = `update: ${update.state}${version}`;
  pill.className = "pill";
  if (update.state === "failed") pill.classList.add("bad");
  if (update.state === "staged" || update.state === "downloading" || update.state === "applying") {
    pill.classList.add("busy");
  }
  pill.title = update.error || update.notes || "";
}

function renderLogs(data) {
  const logs = data.logs || [];
  el("logs").textContent = logs.length ? logs.join("\n") : "—";
}

function renderWorker(data) {
  const worker = data.worker || {};
  el("worker-name").textContent = worker.name || "worker";
  el("host").textContent = `${worker.hostname || "—"} · ${worker.platform || "—"}`;
  el("version").textContent = worker.version || "—";
  const parts = [worker.tier || "primary"];
  if (worker.uptimeSeconds) parts.push(`up ${duration(worker.uptimeSeconds)}`);
  if (worker.serviceName) parts.push(worker.serviceName);
  el("worker-sub").textContent = parts.join(" · ");
}

let lastGood = 0;

async function refresh() {
  try {
    const response = await fetch("/api/snapshot", { cache: "no-store" });
    if (!response.ok) throw new Error(`status ${response.status}`);
    const data = await response.json();
    renderWorker(data);
    renderCards(data);
    renderActive(data);
    renderFinished(data);
    renderConfig(data);
    renderUpdate(data);
    renderLogs(data);
    el("status-dot").className = "dot ok";
    lastGood = Date.now();
  } catch (error) {
    el("status-dot").className = "dot bad";
    const suffix = lastGood ? ` (last update ${Math.round((Date.now() - lastGood) / 1000)}s ago)` : "";
    el("worker-sub").textContent = `dashboard disconnected${suffix}`;
  }
}

el("check-now").addEventListener("click", async () => {
  const button = el("check-now");
  button.disabled = true;
  try {
    const response = await fetch("/api/actions/check-update", { method: "POST" });
    if (!response.ok) throw new Error(`status ${response.status}`);
    button.textContent = "Check queued";
    await refresh();
  } catch (error) {
    button.textContent = "Check failed";
  } finally {
    setTimeout(() => {
      button.disabled = false;
      button.textContent = "Check now";
    }, 2500);
  }
});

refresh();
setInterval(() => {
  if (!document.hidden) refresh();
}, REFRESH_MS);
