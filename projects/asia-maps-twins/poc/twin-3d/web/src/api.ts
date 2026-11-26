export type Meta = {
  hours: number
  days: number
  start: string
  n: number
  types: string[]
  h3_res: number[]
  live_interval_s: number
  simulated: boolean
}

export type Facilities = {
  code: string[]
  name: string[]
  type: number[]
  lon: number[]
  lat: number[]
}

export type TopRow = { i: number; code: string; name: string; backlog: number; aging48: number }

export type Snapshot = {
  hour: number
  label: string
  backlog: number[]
  aging48: number[]
  stale: number[]
  spikes: number[]
  hex: { res: number; id: string[]; value: number[] }
  arcs: { src: number[]; dst: number[]; value: number[] }
  top: TopRow[]
  totals: { backlog: number; aging48: number; daily_inbound: number }
}

export type FacilityDetail = {
  i: number
  code: string
  name: string
  type: string
  lon: number
  lat: number
  backlog_72h: number[]
  aging48_72h: number[]
  daily_inbound_7d: number[]
  first_hour: number
}

export type LiveDelta = { sent_at_ms: number; hour: number; idx: number[]; backlog: number[]; aging48: number[] }

async function getJson<T>(url: string): Promise<{ data: T; ms: number; bytes: number }> {
  const t0 = performance.now()
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url}: ${res.status}`)
  const data = (await res.json()) as T
  const ms = performance.now() - t0
  const entry = performance.getEntriesByName(new URL(url, location.href).href).pop() as
    | PerformanceResourceTiming
    | undefined
  return { data, ms, bytes: entry?.transferSize ?? 0 }
}

export const api = {
  meta: () => getJson<Meta>('/api/meta'),
  facilities: () => getJson<Facilities>('/api/facilities'),
  snapshot: (hour: number, res: number) => getJson<Snapshot>(`/api/snapshot?hour=${hour}&res=${res}`),
  facility: (i: number, hour: number) => getJson<FacilityDetail>(`/api/facility/${i}?hour=${hour}`),
}

const TYPE_LABEL: Record<string, string> = {
  post_office: 'Bưu cục',
  agent: 'Đại lý',
  pickup_point: 'Điểm gửi nhận',
  hub: 'Hub',
}
export const typeLabel = (t: string) => TYPE_LABEL[t] ?? t

export function formatHour(startIso: string, hour: number): string {
  const d = new Date(new Date(startIso).getTime() + hour * 3600_000)
  return d.toLocaleString('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh',
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export const fmt = (n: number) => n.toLocaleString('vi-VN')
