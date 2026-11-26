// TaskTimeline, RunProgress, ReportCard, DeliveryLog.
import { Button } from '@shell/components/ui';
import { fmtMs } from '../../testing/MetricsPane';
import type { Stat } from '../../testing/bridge';
import { Card, Muted, StateBadge, pct, timeOf, type ChatActions } from './shared';

export interface Task {
  id: string;
  kind: string;
  status: string;
  passed?: number;
  failed?: number;
  createdAt?: string;
  error?: string;
  parent?: string;
  runId?: string;
}

/** Nút mở thư mục lượt / báo cáo trên máy (chỉ khi app cung cấp actions.openRun). */
function RunLinks({ runId, actions }: { runId?: string; actions: ChatActions }) {
  if (!runId || !actions.openRun) return null;
  return (
    <div className="flex flex-wrap gap-[6px]">
      <Button size="xs" variant="secondary" onClick={() => actions.openRun?.(runId, 'folder')}>
        Mở thư mục
      </Button>
      <Button size="xs" variant="secondary" onClick={() => actions.openRun?.(runId, 'report')}>
        Mở báo cáo
      </Button>
    </div>
  );
}

function TaskRow({ t, actions }: { t: Task; actions: ChatActions }) {
  return (
    <li className="flex items-center gap-[8px] border-t border-divider py-[6px] first:border-t-0">
      <StateBadge state={t.status} />
      <span className="min-w-0 flex-1 truncate text-[12px]/[16px] text-text-2">
        {t.kind === 'replay' ? 'Chạy lại lượt lỗi' : 'Điều phối'} · <span className="font-mono">{t.id}</span>
        {t.error ? ` · ${t.error}` : ''}
      </span>
      <span className="shrink-0 font-mono text-[11.5px]/[15px] text-text-2">
        {t.passed ?? 0}✓ {t.failed ?? 0}✗ {timeOf(t.createdAt)}
      </span>
      {t.status === 'failed' && (
        <Button size="xs" variant="secondary" onClick={() => actions.runTool('tower_replay_failed', { id: t.id })}>
          Chạy lại lỗi
        </Button>
      )}
    </li>
  );
}

export function TaskTimeline({ data, actions }: { data: Task[] | { canceled: number; tasks: Task[] }; actions: ChatActions }) {
  const tasks = Array.isArray(data) ? data : data.tasks;
  const title = Array.isArray(data) ? 'Task gần đây' : `Đã dừng ${data.canceled} lượt chạy`;
  return (
    <Card title={title}>
      {tasks.length === 0 ? <Muted>Chưa có task nào.</Muted> : <ul>{tasks.map((t) => <TaskRow key={t.id} t={t} actions={actions} />)}</ul>}
    </Card>
  );
}

interface RunSummary {
  run: { id: string; passed: number; failed: number; canceled?: boolean; devices?: number; label?: string };
  flows: { deviceId: string; flow: string; passed: boolean; durationMs: number; failureClass?: string; error?: string }[] | null;
}

export function RunProgress({ data, actions }: { data: Task | RunSummary | { runId: string; stopped: boolean }; actions: ChatActions }) {
  if ('stopped' in data) {
    return (
      <Card title="Dừng lượt chạy">
        <Muted>{data.stopped ? `Đã dừng ${data.runId}.` : `Không có lượt ${data.runId} đang chạy.`}</Muted>
      </Card>
    );
  }
  if ('run' in data) {
    const flows = data.flows ?? [];
    return (
      <Card title={`Lượt chạy ${data.run.id}`} aside={<StateBadge state={data.run.canceled ? 'canceled' : data.run.failed > 0 ? 'failed' : 'passed'} />}>
        <p className="text-[12px]/[16px] text-text-2">
          <b className="font-mono text-text">{data.run.passed}</b> đạt · <b className="font-mono text-text">{data.run.failed}</b> lỗi
          {data.run.label ? ` · bản ${data.run.label}` : ''}
        </p>
        <ul>
          {flows.slice(0, 20).map((f, i) => (
            <li key={i} className="flex gap-[8px] border-t border-divider py-[4px] text-[11.5px]/[15px] first:border-t-0">
              <StateBadge state={f.passed ? 'passed' : 'failed'} />
              <span className="min-w-0 flex-1 truncate font-mono text-text-2">
                {f.deviceId} · {f.flow}
                {f.error ? ` · ${f.error}` : ''}
              </span>
              <span className="shrink-0 font-mono text-text-2">{fmtMs(f.durationMs)}</span>
            </li>
          ))}
        </ul>
        <RunLinks runId={data.run.id} actions={actions} />
      </Card>
    );
  }
  return (
    <Card
      title="Đã điều phối"
      aside={
        data.status === 'running' ? (
          <Button size="sm" variant="secondary" onClick={() => actions.runTool('tower_wait_task', { id: data.id, timeout_sec: 600 })}>
            Theo dõi đến khi xong
          </Button>
        ) : undefined
      }
    >
      <ul>
        <TaskRow t={data} actions={actions} />
      </ul>
    </Card>
  );
}

function StatTable({ rows }: { rows: Stat[] }) {
  return (
    <table className="w-full text-[12px]/[15px]">
      <thead>
        <tr className="text-[10.5px]/[13px] text-text-3">
          <th className="text-left font-normal">Máy</th>
          <th className="text-right font-normal">p50</th>
          <th className="text-right font-normal">p95</th>
          <th className="text-right font-normal">Đạt</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((s) => (
          <tr key={s.key} className="border-t border-divider">
            <td className="max-w-[160px] truncate py-[4px] font-mono text-text-2">{s.key}</td>
            <td className="text-right font-mono text-text-2">{fmtMs(s.p50Ms)}</td>
            <td className="text-right font-mono font-semibold text-text">{fmtMs(s.p95Ms)}</td>
            <td className={s.passRate < 1 ? 'text-right font-mono text-red' : 'text-right font-mono text-green'}>{pct(s.passRate)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const CLASS_LABEL: Record<string, string> = { product: 'Lỗi sản phẩm', automation: 'Lỗi tự động hoá', environment: 'Lỗi môi trường' };

interface TowerReport {
  task: Task;
  byDevice: Stat[] | null;
  failuresByClass: Record<string, number>;
  failures?: { deviceId: string; flow: string; failureClass: string; error?: string }[] | null;
  reports?: string[] | null;
  videos?: string[] | null;
  videosTruncated?: number;
}

export function ReportCard({ data, actions }: { data: TowerReport | RunSummary; actions: ChatActions }) {
  if ('run' in data) return <RunProgress data={data} actions={actions} />;
  const classes = Object.entries(data.failuresByClass ?? {});
  return (
    <Card title={`Báo cáo task ${data.task.id}`} aside={<StateBadge state={data.task.status} />}>
      {(data.byDevice ?? []).length > 0 && <StatTable rows={data.byDevice ?? []} />}
      {classes.length > 0 && (
        <p className="text-[12px]/[16px] text-text-2">{classes.map(([k, n]) => `${CLASS_LABEL[k] ?? k}: ${n}`).join(' · ')}</p>
      )}
      <ul>
        {(data.failures ?? []).slice(0, 10).map((f, i) => (
          <li key={i} className="truncate border-t border-divider py-[4px] font-mono text-[11.5px]/[15px] text-text-2">
            {f.deviceId} · {f.flow} · {f.error}
          </li>
        ))}
      </ul>
      <Muted>
        {(data.reports ?? []).length} báo cáo HTML · {(data.videos ?? []).length} video
        {data.videosTruncated ? ` (${data.videosTruncated} video chỉ giữ 3 phút đầu)` : ''} · nằm trong thư mục lượt trên máy
      </Muted>
      <RunLinks runId={data.task.runId} actions={actions} />
      {data.task.status === 'failed' && (
        <Button size="sm" variant="secondary" className="self-start" onClick={() => actions.runTool('tower_replay_failed', { id: data.task.id })}>
          Chạy lại lượt lỗi
        </Button>
      )}
    </Card>
  );
}

export function DeliveryLog({ data }: { data: { at: string; status: string; target?: string }[] }) {
  return (
    <Card title="Lượt gửi webhook">
      {data.length === 0 ? (
        <Muted>Chưa có lượt gửi nào.</Muted>
      ) : (
        <ul>
          {data.map((d, i) => (
            <li key={i} className="flex gap-[8px] border-t border-divider py-[4px] text-[12px]/[16px] first:border-t-0">
              <span className="font-mono text-text-3">{timeOf(d.at)}</span>
              <span className="min-w-0 flex-1 truncate text-text-2">{d.target ?? ''}</span>
              <StateBadge state={d.status} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
