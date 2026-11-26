import type { Map as MlMap } from 'maplibre-gl'

/** Đếm khung hình mỗi giây bằng requestAnimationFrame. */
export function startFpsMeter(onFps: (fps: number) => void): () => void {
  let frames = 0
  let last = performance.now()
  let raf = 0
  const tick = (now: number) => {
    frames++
    if (now - last >= 1000) {
      onFps(Math.round((frames * 1000) / (now - last)))
      frames = 0
      last = now
    }
    raf = requestAnimationFrame(tick)
  }
  raf = requestAnimationFrame(tick)
  return () => cancelAnimationFrame(raf)
}

export type BenchResult = {
  seconds: number
  frames: number
  avg_fps: number
  p5_fps: number
  worst_frame_ms: number
  viewport: string
  device_pixel_ratio: number
  /** Thời gian vẽ thật của một khung (vẽ đồng bộ + chờ GPU xong), không phụ thuộc nhịp rAF. */
  render_ms_p50?: number
  render_ms_p95?: number
  max_fps_from_render?: number
}

/**
 * Đo thời gian vẽ thật: mỗi khung gọi map.redraw() (vẽ đồng bộ, gồm cả lớp deck.gl xen kẽ)
 * rồi readPixels 1 điểm để buộc GPU hoàn tất. Nhịp rAF trong trình duyệt headless luôn ~60 fps
 * nên không phản ánh chi phí GPU; con số này mới phản ánh.
 */
export function measureRenderCost(map: MlMap, frames = 120): BenchResult & { render_ms_p50: number } {
  const gl = map.getCanvas().getContext('webgl2') as WebGL2RenderingContext
  const pixel = new Uint8Array(4)
  map.jumpTo({ center: [106.0, 16.0], zoom: 5.2, pitch: 45, bearing: -10 })
  map.redraw()
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
  const times: number[] = []
  for (let k = 0; k < frames; k++) {
    const t = k / 12
    map.jumpTo({ bearing: -10 + t * 18, pitch: 40 + 15 * Math.sin(t), zoom: 5.2 + 1.3 * (0.5 - 0.5 * Math.cos(t * 0.8)) })
    const t0 = performance.now()
    map.redraw()
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
    times.push(performance.now() - t0)
  }
  times.sort((a, b) => a - b)
  const p50 = times[Math.floor(times.length * 0.5)]
  const p95 = times[Math.floor(times.length * 0.95)]
  const round = (x: number) => Math.round(x * 10) / 10
  return {
    seconds: round(times.reduce((a, b) => a + b, 0) / 1000),
    frames,
    avg_fps: 0,
    p5_fps: 0,
    worst_frame_ms: round(times[times.length - 1]),
    viewport: `${innerWidth}x${innerHeight}`,
    device_pixel_ratio: devicePixelRatio,
    render_ms_p50: round(p50),
    render_ms_p95: round(p95),
    max_fps_from_render: round(1000 / p95),
  }
}

/** Xoay, nghiêng, zoom bản đồ liên tục trong `seconds` giây và đo thời gian từng khung hình. */
export function runBenchmark(map: MlMap, seconds = 10): Promise<BenchResult> {
  return new Promise((resolve) => {
    const start = performance.now()
    const deltas: number[] = []
    let prev = start
    map.jumpTo({ center: [106.0, 16.0], zoom: 5.2, pitch: 45, bearing: -10 })
    const step = (now: number) => {
      const t = (now - start) / 1000
      deltas.push(now - prev)
      prev = now
      map.jumpTo({
        bearing: -10 + t * 18,
        pitch: 40 + 15 * Math.sin(t),
        zoom: 5.2 + 1.3 * (0.5 - 0.5 * Math.cos(t * 0.8)),
      })
      if (t < seconds) requestAnimationFrame(step)
      else {
        const body = deltas.slice(1)
        const fps = body.map((d) => 1000 / d).sort((a, b) => a - b)
        resolve({
          seconds,
          frames: body.length,
          avg_fps: Math.round((body.length / (body.reduce((a, b) => a + b, 0) / 1000)) * 10) / 10,
          p5_fps: Math.round(fps[Math.floor(fps.length * 0.05)] * 10) / 10,
          worst_frame_ms: Math.round(Math.max(...body) * 10) / 10,
          viewport: `${innerWidth}x${innerHeight}`,
          device_pixel_ratio: devicePixelRatio,
        })
      }
    }
    requestAnimationFrame(step)
  })
}
