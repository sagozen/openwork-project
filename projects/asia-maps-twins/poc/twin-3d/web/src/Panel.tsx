import { fmt, formatHour, typeLabel, type FacilityDetail, type Meta, type TopRow } from './api'
import { agingColor } from './layers'

export function TopTable({ rows, onPick }: { rows: TopRow[]; onPick: (i: number) => void }) {
  return (
    <section>
      <h2>10 điểm tồn nhiều nhất</h2>
      <table className="top">
        <thead>
          <tr>
            <th>Điểm</th>
            <th className="num">Tồn</th>
            <th className="num">&gt;48h</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.i} onClick={() => onPick(r.i)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onPick(r.i)}>
              <td>
                <span className="dot" style={{ background: rgb(agingColor(r.backlog, r.aging48)) }} />
                <span className="name">{r.name}</span>
                <span className="code">{r.code}</span>
              </td>
              <td className="num">{fmt(r.backlog)}</td>
              <td className="num">{fmt(r.aging48)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hint">Bấm một dòng để bay tới điểm; bấm một cột trên bản đồ để xem chi tiết.</p>
    </section>
  )
}

export function DetailPanel({ detail, meta, onClose }: { detail: FacilityDetail; meta: Meta | null; onClose: () => void }) {
  const last = detail.backlog_72h.length - 1
  return (
    <section>
      <div className="detail-head">
        <h2>{detail.name}</h2>
        <button onClick={onClose} aria-label="Đóng chi tiết">✕</button>
      </div>
      <p className="code">
        {detail.code} · {typeLabel(detail.type)}
      </p>
      <div className="detail-kpis">
        <div>
          <span className="kpi-label">Đơn tồn</span>
          <span className="kpi-value">{fmt(detail.backlog_72h[last])}</span>
        </div>
        <div>
          <span className="kpi-label">Tồn quá 48h</span>
          <span className="kpi-value warn">{fmt(detail.aging48_72h[last])}</span>
        </div>
      </div>
      <h3>Đơn tồn 72 giờ qua</h3>
      <Spark series={[detail.backlog_72h, detail.aging48_72h]} />
      {meta && (
        <p className="hint">
          {formatHour(meta.start, detail.first_hour)} → {formatHour(meta.start, detail.first_hour + last)}
        </p>
      )}
      <h3>Đơn đến 7 ngày qua</h3>
      <Bars values={detail.daily_inbound_7d} />
    </section>
  )
}

export function Legend() {
  const stops = [0, 0.1, 0.2, 0.35, 0.5]
  return (
    <div className="legend">
      <span className="kpi-label">Màu cột: tỉ lệ đơn tồn quá 48h</span>
      <div className="ramp">
        {stops.map((s) => (
          <span key={s} style={{ background: rgb(agingColor(100, s * 100)) }} />
        ))}
      </div>
      <div className="ramp-labels">
        <span>0%</span>
        <span>≥ 50%</span>
      </div>
      <span className="kpi-label">Chiều cao cột tỉ lệ với căn bậc hai của số đơn tồn</span>
      <span className="kpi-label">
        <i className="ring red" /> tồn tăng vọt <i className="ring grey" /> mất dữ liệu
      </span>
    </div>
  )
}

function Spark({ series }: { series: number[][] }) {
  const w = 280
  const h = 70
  const max = Math.max(1, ...series[0])
  const path = (s: number[]) =>
    s.map((v, i) => `${i === 0 ? 'M' : 'L'}${(i / Math.max(1, s.length - 1)) * w},${h - (v / max) * h}`).join(' ')
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="spark" role="img" aria-label="Biểu đồ đơn tồn 72 giờ">
      <path d={path(series[0])} className="s-backlog" />
      <path d={path(series[1])} className="s-aging" />
    </svg>
  )
}

function Bars({ values }: { values: number[] }) {
  const max = Math.max(1, ...values)
  return (
    <div className="bars">
      {values.map((v, i) => (
        <div key={i} className="bar" title={fmt(v)}>
          <span style={{ height: `${(v / max) * 100}%` }} />
          <em>{fmt(v)}</em>
        </div>
      ))}
    </div>
  )
}

function rgb(c: number[]) {
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`
}
