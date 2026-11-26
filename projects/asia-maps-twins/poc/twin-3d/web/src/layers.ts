import { ArcLayer, ColumnLayer, ScatterplotLayer } from '@deck.gl/layers'
import { H3HexagonLayer } from '@deck.gl/geo-layers'
import type { Facilities, Snapshot } from './api'

export type LayerToggles = { columns: boolean; hex: boolean; arcs: boolean; alerts: boolean }
type RGBA = [number, number, number, number]

const HUB = 3

/** Màu theo tỉ lệ đơn tồn quá 48h: xanh (0%) → vàng (20%) → đỏ (≥ 50%). */
export function agingColor(backlog: number, aging: number): RGBA {
  if (backlog === 0) return [90, 100, 110, 120]
  const r = Math.min(aging / backlog, 0.5) / 0.5
  if (r < 0.4) {
    const t = r / 0.4
    return [Math.round(46 + t * (240 - 46)), Math.round(204 - t * 24), Math.round(113 - t * 70), 230]
  }
  const t = (r - 0.4) / 0.6
  return [Math.round(240 + t * 10), Math.round(180 - t * 130), Math.round(43 + t * 20), 240]
}

function hexColor(value: number, max: number): RGBA {
  const t = max > 0 ? Math.log1p(value) / Math.log1p(max) : 0
  return [Math.round(40 + t * 60), Math.round(90 + t * 110), Math.round(160 + t * 95), Math.round(40 + t * 150)]
}

export function buildLayers(opts: {
  fac: Facilities
  snap: Snapshot
  backlog: Int32Array
  aging: Int32Array
  version: number
  toggles: LayerToggles
  elevationScale: number
  selected: number | null
  zoom: number
}) {
  const { fac, snap, backlog, aging, version, toggles, elevationScale, selected, zoom } = opts
  // Bán kính cột theo mức zoom: khoảng 3–4 điểm ảnh ở mọi mức, tối thiểu 120 m khi zoom sát.
  const radius = Math.max(120, 2200 * 2 ** (5.5 - zoom))
  const n = fac.code.length
  const layers = []

  if (toggles.hex) {
    const max = Math.max(...snap.hex.value)
    layers.push(
      new H3HexagonLayer<number>({
        id: 'hex-volume',
        data: snap.hex.id.map((_, i) => i),
        getHexagon: (i) => snap.hex.id[i],
        getFillColor: (i) => hexColor(snap.hex.value[i], max),
        filled: true,
        extruded: false,
        stroked: false,
        pickable: true,
        updateTriggers: { getFillColor: [snap.hour, snap.hex.res] },
      }),
    )
  }

  if (toggles.arcs) {
    const max = Math.max(...snap.arcs.value, 1)
    layers.push(
      new ArcLayer<number>({
        id: 'arcs-linehaul',
        data: snap.arcs.src.map((_, i) => i),
        getSourcePosition: (i) => [fac.lon[snap.arcs.src[i]], fac.lat[snap.arcs.src[i]]],
        getTargetPosition: (i) => [fac.lon[snap.arcs.dst[i]], fac.lat[snap.arcs.dst[i]]],
        getSourceColor: [0, 200, 255, 130],
        getTargetColor: [255, 80, 200, 130],
        getWidth: (i) => 0.5 + 3 * Math.sqrt(snap.arcs.value[i] / max),
        getHeight: 0.12,
        pickable: true,
        updateTriggers: { getWidth: [snap.hour] },
      }),
    )
  }

  if (toggles.columns) {
    layers.push(
      new ColumnLayer<unknown>({
        id: 'columns-backlog',
        data: { length: n },
        diskResolution: 6,
        radius,
        extruded: true,
        pickable: true,
        elevationScale,
        getPosition: (_, { index }) => [fac.lon[index], fac.lat[index]],
        // Chiều cao tỉ lệ với căn bậc hai của số đơn tồn, để hub và đại lý cùng nhìn được.
        getElevation: (_, { index }) => Math.sqrt(backlog[index]) * (fac.type[index] === HUB ? 1.2 : 1),
        getFillColor: (_, { index }) =>
          index === selected ? [255, 255, 255, 255] : agingColor(backlog[index], aging[index]),
        updateTriggers: { getElevation: [version], getFillColor: [version, selected] },
      }),
    )
  }

  if (toggles.alerts) {
    const alerts = [
      ...snap.stale.map((i) => ({ i, kind: 'stale' as const })),
      ...snap.spikes.map((i) => ({ i, kind: 'spike' as const })),
    ]
    layers.push(
      new ScatterplotLayer<(typeof alerts)[number]>({
        id: 'alerts',
        data: alerts,
        getPosition: (d) => [fac.lon[d.i], fac.lat[d.i]],
        getRadius: (d) => (d.kind === 'spike' ? 4500 : 3500),
        radiusMinPixels: 5,
        stroked: true,
        filled: false,
        getLineColor: (d) => (d.kind === 'spike' ? [255, 59, 48, 255] : [170, 170, 170, 230]),
        lineWidthMinPixels: 2,
        pickable: true,
        updateTriggers: { getPosition: [snap.hour] },
      }),
    )
  }
  return layers
}
