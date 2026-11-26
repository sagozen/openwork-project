// MetricChart, BudgetMeter, AlertList.
import { MetricsView, fmtMs } from '../../testing/MetricsPane';
import type { MetricsSummary } from '../../testing/bridge';
import { Card, Muted, pct, vnd } from './shared';

interface Health {
  running: number;
  flows: number;
  successRate: number;
  events: number;
  failuresByClass: Record<string, number>;
  devices: Record<string, number>;
}

interface CompareRow {
  deviceId: string;
  oldP95Ms: number;
  newP95Ms: number;
  deltaP95Ms: number;
  deltaP95Pct: number;
  oldPassRate: number;
  newPassRate: number;
}

const CLASS_LABEL: Record<string, string> = { product: 'sản phẩm', automation: 'tự động hoá', environment: 'môi trường' };

export function MetricChart({ data }: { data: MetricsSummary | Health | { rows: CompareRow[] | null } }) {
  if ('byDevice' in data) {
    return (
      <Card title="Số đo">
        <MetricsView summary={data} />
      </Card>
    );
  }
  if ('rows' in data) {
    const rows = data.rows ?? [];
    return (
      <Card title="So sánh bản cũ và bản mới (p95)">
        <table className="w-full text-[12px]/[15px]">
          <thead>
            <tr className="text-[10.5px]/[13px] text-text-3">
              <th className="text-left font-normal">Máy</th>
              <th className="text-right font-normal">Cũ</th>
              <th className="text-right font-normal">Mới</th>
              <th className="text-right font-normal">Chênh</th>
              <th className="text-right font-normal">Đạt</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.deviceId} className="border-t border-divider">
                <td className="max-w-[140px] truncate py-[4px] font-mono text-text-2">{r.deviceId}</td>
                <td className="text-right font-mono text-text-2">{fmtMs(r.oldP95Ms)}</td>
                <td className="text-right font-mono font-semibold text-text">{fmtMs(r.newP95Ms)}</td>
                <td className={r.deltaP95Ms > 0 ? 'text-right font-mono text-red' : 'text-right font-mono text-green'}>
                  {r.deltaP95Ms > 0 ? '+' : ''}
                  {Math.round(r.deltaP95Pct)}%
                </td>
                <td className="text-right font-mono text-text-2">
                  {pct(r.oldPassRate)} → {pct(r.newPassRate)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    );
  }
  const classes = Object.entries(data.failuresByClass ?? {});
  return (
    <Card title="Sức khoẻ 7 ngày">
      <p className="text-[12px]/[16px] text-text-2">
        <b className="font-mono text-text">{data.flows}</b> lượt flow · đạt <b className="font-mono text-text">{pct(data.successRate)}</b> ·{' '}
        <b className="font-mono text-text">{data.running}</b> task đang chạy · {data.events} sự kiện
      </p>
      {classes.length > 0 && <Muted>Lỗi theo loại: {classes.map(([k, n]) => `${CLASS_LABEL[k] ?? k} ${n}`).join(', ')}</Muted>}
    </Card>
  );
}

interface Budget {
  month: string;
  spentVnd: number;
  calls?: number;
  leftVnd?: number;
  leftKnown: boolean;
  opCeilingVnd: number;
  machineMinutes?: number;
}

export function BudgetMeter({ data }: { data: Budget }) {
  const total = data.leftKnown ? data.spentVnd + (data.leftVnd ?? 0) : 0;
  const used = total > 0 ? Math.min(1, data.spentVnd / total) : 0;
  return (
    <Card title={`Ngân sách AI tháng ${data.month}`}>
      {data.leftKnown && (
        <div className="h-[8px] overflow-hidden rounded-full bg-muted-box" role="meter" aria-valuenow={Math.round(used * 100)} aria-valuemin={0} aria-valuemax={100}>
          <div className={used > 0.9 ? 'h-full bg-red' : 'h-full bg-accent'} style={{ width: `${used * 100}%` }} />
        </div>
      )}
      <p className="text-[12px]/[16px] text-text-2">
        Đã dùng <b className="font-mono text-text">{vnd(data.spentVnd)}</b>
        {data.calls !== undefined ? ` (${data.calls} lần gọi)` : ''} · còn{' '}
        <b className="font-mono text-text">{data.leftKnown ? vnd(data.leftVnd ?? 0) : 'chưa rõ'}</b>
      </p>
      <Muted>
        Quá {vnd(data.opCeilingVnd)} một thao tác thì hỏi xác nhận
        {data.machineMinutes !== undefined ? ` · ${Math.round(data.machineMinutes)} phút máy tháng này` : ''}
      </Muted>
    </Card>
  );
}

export function AlertList({ data }: { data: { level: string; kind: string; text: string; deviceId?: string }[] }) {
  return (
    <Card title="Cảnh báo" tone={data.some((a) => a.level === 'error') ? 'error' : data.length > 0 ? 'warn' : undefined}>
      {data.length === 0 ? (
        <Muted>Không có cảnh báo.</Muted>
      ) : (
        <ul className="flex flex-col gap-[4px]">
          {data.map((a, i) => (
            <li key={i} className="text-[12px]/[16px] text-text-2">
              <b className={a.level === 'error' ? 'text-red' : 'text-amber'}>{a.level === 'error' ? 'Lỗi' : 'Chú ý'}</b>
              {a.deviceId ? ` · ${a.deviceId}` : ''} · {a.text}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
