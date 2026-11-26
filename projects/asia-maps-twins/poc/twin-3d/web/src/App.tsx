import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import maplibregl, { type Map as MlMap } from 'maplibre-gl'
import { MapboxOverlay } from '@deck.gl/mapbox'
import type { PickingInfo } from '@deck.gl/core'
import 'maplibre-gl/dist/maplibre-gl.css'
import { api, fmt, formatHour, type Facilities, type FacilityDetail, type LiveDelta, type Meta, type Snapshot } from './api'
import { buildLayers, type LayerToggles } from './layers'
import { measureRenderCost, runBenchmark, startFpsMeter, type BenchResult } from './perf'
import { DetailPanel, Legend, TopTable } from './Panel'

const STYLE_URL = 'https://tiles.openfreemap.org/styles/dark'

type Perf = {
  fps: number
  firstFrameMs: number | null
  mapIdleMs: number | null
  snapshotMs: number | null
  snapshotKb: number | null
  wsReceiveMs: number | null
  wsRenderMs: number | null
}

declare global {
  interface Window {
    __bench?: (seconds?: number) => Promise<BenchResult>
    __renderCost?: (frames?: number) => BenchResult
    __perf?: () => Perf
    __setRes?: (res: number) => void
    __jumpTo?: (v: { center: [number, number]; zoom: number; pitch: number; bearing: number }) => void
  }
}

export default function App() {
  const mapDiv = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MlMap | null>(null)
  const overlayRef = useRef<MapboxOverlay | null>(null)
  const pendingLive = useRef<number | null>(null)
  const wsRef = useRef<WebSocket | null>(null)

  const [meta, setMeta] = useState<Meta | null>(null)
  const [fac, setFac] = useState<Facilities | null>(null)
  const [snap, setSnap] = useState<Snapshot | null>(null)
  const [arrays, setArrays] = useState<{ backlog: Int32Array; aging: Int32Array; version: number } | null>(null)
  const [hour, setHour] = useState<number | null>(null)
  const [res, setRes] = useState(6)
  const [toggles, setToggles] = useState<LayerToggles>({ columns: true, hex: true, arcs: true, alerts: true })
  const [elevationScale, setElevationScale] = useState(400)
  const [playing, setPlaying] = useState(false)
  const [live, setLive] = useState(false)
  const [selected, setSelected] = useState<number | null>(null)
  const [detail, setDetail] = useState<FacilityDetail | null>(null)
  const [hoverText, setHoverText] = useState<string | null>(null)
  const [zoom, setZoom] = useState(5.25)
  const [perf, setPerf] = useState<Perf>({
    fps: 0, firstFrameMs: null, mapIdleMs: null, snapshotMs: null, snapshotKb: null, wsReceiveMs: null, wsRenderMs: null,
  })
  const perfRef = useRef(perf)
  perfRef.current = perf

  // ---------- bản đồ ----------
  useEffect(() => {
    const map = new maplibregl.Map({
      container: mapDiv.current!,
      style: STYLE_URL,
      center: [106.0, 16.0],
      zoom: 5.2,
      pitch: 45,
      bearing: -10,
      maxPitch: 70,
      attributionControl: { compact: true },
    })
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right')
    const overlay = new MapboxOverlay({ interleaved: true, layers: [] })
    map.addControl(overlay)
    map.once('idle', () => setPerf((p) => ({ ...p, mapIdleMs: Math.round(performance.now()) })))
    // Làm tròn theo bước 0,25 để không dựng lại lớp ở mọi khung hình khi zoom.
    map.on('zoom', () => setZoom(Math.round(map.getZoom() * 4) / 4))
    mapRef.current = map
    overlayRef.current = overlay
    window.__bench = (seconds = 10) => runBenchmark(map, seconds)
    window.__renderCost = (frames = 120) => measureRenderCost(map, frames)
    window.__perf = () => perfRef.current
    window.__setRes = (r: number) => setRes(r)
    window.__jumpTo = (v) => map.jumpTo(v)
    const stop = startFpsMeter((fps) => setPerf((p) => ({ ...p, fps })))
    return () => {
      stop()
      map.remove()
      mapRef.current = null
      overlayRef.current = null
    }
  }, [])

  // ---------- dữ liệu ban đầu ----------
  useEffect(() => {
    Promise.all([api.meta(), api.facilities()]).then(([m, f]) => {
      setMeta(m.data)
      setFac(f.data)
      setHour(m.data.hours - 1)
    })
  }, [])

  // ---------- ảnh chụp theo giờ ----------
  useEffect(() => {
    if (hour === null) return
    const timer = setTimeout(async () => {
      const { data, ms, bytes } = await api.snapshot(hour, res)
      setSnap(data)
      setArrays((prev) => ({
        backlog: Int32Array.from(data.backlog),
        aging: Int32Array.from(data.aging48),
        version: (prev?.version ?? 0) + 1,
      }))
      setPerf((p) => ({ ...p, snapshotMs: Math.round(ms), snapshotKb: Math.round(bytes / 1024) }))
      wsRef.current?.readyState === WebSocket.OPEN && wsRef.current.send(JSON.stringify({ hour }))
    }, playing ? 0 : 120)
    return () => clearTimeout(timer)
  }, [hour, res, playing])

  // ---------- phát lại ----------
  useEffect(() => {
    if (!playing || !meta) return
    const id = setInterval(() => setHour((h) => (h === null || h >= meta.hours - 1 ? 0 : h + 1)), 600)
    return () => clearInterval(id)
  }, [playing, meta])

  // ---------- cập nhật trực tiếp qua WebSocket ----------
  useEffect(() => {
    if (!live) return
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/live`)
    wsRef.current = ws
    ws.onopen = () => hour !== null && ws.send(JSON.stringify({ hour }))
    ws.onmessage = (ev) => {
      const d = JSON.parse(ev.data) as LiveDelta
      const receiveMs = Date.now() - d.sent_at_ms
      setArrays((prev) => {
        if (!prev) return prev
        const backlog = prev.backlog.slice()
        const aging = prev.aging.slice()
        d.idx.forEach((i, k) => {
          backlog[i] = d.backlog[k]
          aging[i] = d.aging48[k]
        })
        return { backlog, aging, version: prev.version + 1 }
      })
      pendingLive.current = d.sent_at_ms
      setPerf((p) => ({ ...p, wsReceiveMs: receiveMs }))
    }
    return () => {
      ws.close()
      wsRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live])

  // ---------- chọn điểm ----------
  const selectFacility = useCallback(
    async (i: number, fly: boolean) => {
      if (hour === null || !fac) return
      setSelected(i)
      const { data } = await api.facility(i, hour)
      setDetail(data)
      if (fly) mapRef.current?.flyTo({ center: [fac.lon[i], fac.lat[i]], zoom: 11, pitch: 55, duration: 1500 })
    },
    [hour, fac],
  )

  useEffect(() => {
    if (selected !== null && hour !== null) selectFacility(selected, false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hour])

  // ---------- lớp deck.gl ----------
  const layers = useMemo(() => {
    if (!fac || !snap || !arrays) return []
    return buildLayers({ fac, snap, ...arrays, toggles, elevationScale, selected, zoom })
  }, [fac, snap, arrays, toggles, elevationScale, selected, zoom])

  useEffect(() => {
    const overlay = overlayRef.current
    if (!overlay || !fac) return
    overlay.setProps({
      layers,
      onClick: (info: PickingInfo) => {
        if (info.layer?.id === 'columns-backlog' && info.index >= 0) selectFacility(info.index, false)
      },
      onHover: (info: PickingInfo) => setHoverText(describe(info, fac, snap, arrays)),
      onAfterRender: () => {
        if (layers.length && perfRef.current.firstFrameMs === null)
          setPerf((p) => ({ ...p, firstFrameMs: Math.round(performance.now()) }))
        if (pendingLive.current !== null) {
          const ms = Date.now() - pendingLive.current
          pendingLive.current = null
          setPerf((p) => ({ ...p, wsRenderMs: ms }))
        }
      },
    })
  }, [layers, fac, snap, arrays, selectFacility])

  return (
    <div className="app">
      <div ref={mapDiv} className="map" />

      <header className="topbar">
        <div className="title">
          <h1>Điều hành mạng lưới</h1>
          <span className="badge">DỮ LIỆU MÔ PHỎNG</span>
        </div>
        {snap && meta && (
          <div className="kpis">
            <Kpi label="Đơn tồn toàn mạng" value={fmt(arrays ? sum(arrays.backlog) : snap.totals.backlog)} />
            <Kpi label="Tồn quá 48h" value={fmt(arrays ? sum(arrays.aging) : snap.totals.aging48)} tone="warn" />
            <Kpi label="Đơn đến trong ngày" value={fmt(snap.totals.daily_inbound)} />
            <Kpi label="Cảnh báo" value={`${snap.spikes.length} tăng vọt · ${snap.stale.length} mất dữ liệu`} tone="alert" />
          </div>
        )}
        <div className="perf" aria-label="Chỉ số hiệu năng">
          <span>{perf.fps} fps</span>
          <span>khung đầu {perf.firstFrameMs ?? '…'} ms</span>
          <span>ảnh chụp {perf.snapshotMs ?? '…'} ms / {perf.snapshotKb ?? '…'} KB</span>
          {live && (
            <span>
              live nhận {perf.wsReceiveMs === null ? '…' : Math.round(perf.wsReceiveMs)} ms · vẽ{' '}
              {perf.wsRenderMs === null ? '…' : Math.round(perf.wsRenderMs)} ms
            </span>
          )}
        </div>
      </header>

      <aside className="side">
        <section>
          <h2>Lớp hiển thị</h2>
          {(
            [
              ['columns', 'Cột đơn tồn theo điểm'],
              ['hex', 'Lưới H3 sản lượng ngày'],
              ['arcs', 'Luồng trung chuyển hub'],
              ['alerts', 'Cảnh báo'],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="toggle">
              <input type="checkbox" checked={toggles[key]} onChange={(e) => setToggles({ ...toggles, [key]: e.target.checked })} />
              {label}
            </label>
          ))}
          <label className="row">
            Độ phân giải H3
            <select value={res} onChange={(e) => setRes(Number(e.target.value))}>
              {(meta?.h3_res ?? [5, 6, 7]).map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
          <label className="row">
            Độ cao cột
            <input type="range" min={100} max={1500} step={50} value={elevationScale} onChange={(e) => setElevationScale(Number(e.target.value))} />
          </label>
          <Legend />
        </section>
        {detail ? (
          <DetailPanel detail={detail} meta={meta} onClose={() => { setSelected(null); setDetail(null) }} />
        ) : (
          snap && <TopTable rows={snap.top} onPick={(i) => selectFacility(i, true)} />
        )}
      </aside>

      {meta && hour !== null && (
        <footer className="timebar">
          <button onClick={() => setPlaying(!playing)} aria-label={playing ? 'Tạm dừng' : 'Phát lại'}>
            {playing ? '❚❚' : '▶'}
          </button>
          <input type="range" min={0} max={meta.hours - 1} value={hour} onChange={(e) => setHour(Number(e.target.value))} aria-label="Thời điểm" />
          <span className="when">{formatHour(meta.start, hour)}</span>
          <label className="toggle live">
            <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} />
            Cập nhật trực tiếp ({meta.live_interval_s}s)
          </label>
        </footer>
      )}

      {hoverText && <div className="hover">{hoverText}</div>}
    </div>
  )
}

function Kpi({ label, value, tone }: { label: string; value: string; tone?: 'warn' | 'alert' }) {
  return (
    <div className={`kpi ${tone ?? ''}`}>
      <span className="kpi-label">{label}</span>
      <span className="kpi-value">{value}</span>
    </div>
  )
}

const sum = (a: Int32Array) => a.reduce((s, v) => s + v, 0)

function describe(
  info: PickingInfo,
  fac: Facilities,
  snap: Snapshot | null,
  arrays: { backlog: Int32Array; aging: Int32Array } | null,
): string | null {
  if (!info.layer || info.index < 0 || !snap || !arrays) return null
  if (info.layer.id === 'columns-backlog') {
    const i = info.index
    return `${fac.code[i]} · ${fac.name[i]} — tồn ${fmt(arrays.backlog[i])}, quá 48h ${fmt(arrays.aging[i])}`
  }
  if (info.layer.id === 'hex-volume') return `Ô H3 ${snap.hex.id[info.index]} — ${fmt(snap.hex.value[info.index])} đơn đến trong ngày`
  if (info.layer.id === 'arcs-linehaul') {
    const k = info.index
    return `${fac.name[snap.arcs.src[k]]} ↔ ${fac.name[snap.arcs.dst[k]]} — ${fmt(snap.arcs.value[k])} đơn/ngày`
  }
  return null
}
