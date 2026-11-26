// Đo hiệu năng màn điều hành 3D bằng Chrome chạy ngầm (headless).
// Cần web (5174) và API (8765) đang chạy. Kết quả ghi ra ../bench/results.json.
// Chạy: node scripts/bench.mjs
import { chromium } from 'playwright-core'
import { mkdirSync, writeFileSync } from 'node:fs'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const APP_URL = process.env.APP_URL ?? 'http://localhost:5174/'
const OUT = new URL('../../bench/', import.meta.url)

const SCENARIOS = [
  { name: 'laptop-1440x900-gpu-h3r7', width: 1440, height: 900, dpr: 1, res: 7, angle: 'metal' },
  { name: 'laptop-1440x900-gpu-h3r6', width: 1440, height: 900, dpr: 1, res: 6, angle: 'metal' },
  { name: 'retina-1920x1080x2-gpu-h3r7', width: 1920, height: 1080, dpr: 2, res: 7, angle: 'metal' },
  { name: 'khong-gpu-1440x900-h3r7', width: 1440, height: 900, dpr: 1, res: 7, angle: 'swiftshader' },
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function runScenario(s) {
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: [`--use-angle=${s.angle}`, '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
  })
  const context = await browser.newContext({ viewport: { width: s.width, height: s.height }, deviceScaleFactor: s.dpr })
  const page = await context.newPage()
  await page.goto(APP_URL)
  await page.waitForFunction(() => window.__perf?.().firstFrameMs != null, null, { timeout: 60000 })
  await page.waitForFunction(() => window.__perf?.().mapIdleMs != null, null, { timeout: 60000 }).catch(() => {})
  const renderer = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2')
    const dbg = gl?.getExtension('WEBGL_debug_renderer_info')
    return dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown'
  })
  const load = await page.evaluate(() => window.__perf())

  await page.evaluate((res) => window.__setRes(res), s.res)
  await sleep(2000)
  const bench = await page.evaluate(() => window.__bench(10))
  const render = await page.evaluate(() => window.__renderCost(120))

  // Cập nhật trực tiếp: bật WebSocket, lấy mẫu độ trễ trong khoảng 5 lần đẩy.
  await page.getByLabel(/Cập nhật trực tiếp/).check()
  const samples = []
  const end = Date.now() + 20000
  let lastRender = null
  while (Date.now() < end) {
    const p = await page.evaluate(() => window.__perf())
    if (p.wsRenderMs != null && p.wsRenderMs !== lastRender) {
      samples.push({ receive_ms: p.wsReceiveMs, render_ms: p.wsRenderMs })
      lastRender = p.wsRenderMs
    }
    await sleep(200)
  }
  await browser.close()
  return {
    scenario: s,
    renderer,
    load: { first_frame_ms: load.firstFrameMs, map_idle_ms: load.mapIdleMs, snapshot_ms: load.snapshotMs, snapshot_kb: load.snapshotKb },
    bench,
    render,
    live: samples,
  }
}

mkdirSync(OUT, { recursive: true })
// Một lượt khởi động không tính, để bộ nhớ đệm của server không làm lệch kịch bản đầu.
await runScenario({ ...SCENARIOS[1], name: 'warmup' })
const results = []
for (const s of SCENARIOS) {
  process.stdout.write(`${s.name} ... `)
  const r = await runScenario(s)
  results.push(r)
  console.log(`rAF ${r.bench.avg_fps} fps; vẽ thật p50 ${r.render.render_ms_p50} ms, p95 ${r.render.render_ms_p95} ms (≈${r.render.max_fps_from_render} fps), khung đầu ${r.load.first_frame_ms} ms, live ${JSON.stringify(r.live.map((x) => x.render_ms))} — ${r.renderer}`)
}
writeFileSync(new URL(process.env.OUT_NAME ?? 'results.json', OUT), JSON.stringify(results, null, 2))
