// Ô 4 "Số đo": chỉ xem. p50/p95 và tỉ lệ đạt theo máy, lạnh/ấm, chạm, số máy song song, Insights theo bước.
// MetricsView thuần (render và test độc lập); MetricsPane tải từ Go và tải lại khi một lượt chạy kết thúc.
import { useCallback, useEffect, useState } from 'react';
import { errorText } from '@shell/lib/session';
import { cx } from '@shell/components/ui/cx';
import { Empty } from '../workspace/Workspace';
import { vnd } from '../chat/components/shared';
import { onTestEvent, testApi, type Insights, type MetricsSummary, type RepairInsight, type RunRecord, type Stat, type StepInsight } from './bridge';

/** 840 => "840 ms", 12345 => "12,3 s". */
export function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toLocaleString('vi-VN', { maximumFractionDigits: 1 })} s`;
}

const pct = (r: number) => `${Math.round(r * 100)}%`;

function Row({ label, stat, emphasise }: { label: string; stat: Stat; emphasise?: boolean }) {
  return (
    <tr className="border-t border-divider first:border-t-0">
      <td className="max-w-[120px] truncate py-[5px] pr-[8px] text-text-2" title={label}>
        {label}
      </td>
      <td className="py-[5px] text-right font-mono text-text-2">{fmtMs(stat.p50Ms)}</td>
      <td className={cx('py-[5px] text-right font-mono', emphasise ? 'font-semibold text-text' : 'text-text-2')}>{fmtMs(stat.p95Ms)}</td>
      <td className={cx('py-[5px] pl-[8px] text-right font-mono', stat.passRate < 1 ? 'text-red' : 'text-green')}>{pct(stat.passRate)}</td>
    </tr>
  );
}

function Table({ title, rows }: { title: string; rows: { label: string; stat: Stat }[] }) {
  if (rows.length === 0) return null;
  return (
    <div>
      <p className="mb-[4px] text-[11px]/[14px] font-semibold uppercase tracking-[0.04em] text-text-3">{title}</p>
      <table className="w-full text-[12px]/[15px]">
        <thead>
          <tr className="text-[10.5px]/[13px] text-text-3">
            <th className="pb-[3px] text-left font-normal" />
            <th className="pb-[3px] text-right font-normal">p50</th>
            <th className="pb-[3px] text-right font-normal">p95</th>
            <th className="pb-[3px] text-right font-normal">Đạt</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <Row key={r.label} label={r.label} stat={r.stat} emphasise />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function InsightList<T>({ title, rows, item }: { title: string; rows: T[] | null | undefined; item: (r: T) => { key: string; label: string; value: string; tone?: string; hint?: string } }) {
  const list = (rows ?? []).slice(0, 5);
  if (list.length === 0) return null;
  return (
    <div>
      <p className="mb-[4px] text-[11px]/[14px] font-semibold uppercase tracking-[0.04em] text-text-3">{title}</p>
      <ul className="flex flex-col gap-[3px] text-[12px]/[15px]">
        {list.map((r) => {
          const x = item(r);
          return (
            <li key={x.key} className="flex gap-[8px]" title={x.hint || x.label}>
              <span className="min-w-0 flex-1 truncate font-mono text-text-2">{x.label}</span>
              <span className={cx('shrink-0 font-mono', x.tone ?? 'text-text')}>{x.value}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const stepKey = (s: StepInsight) => `${s.flow}|${s.step}`;
const stepLabel = (s: StepInsight) => `${s.flow} · ${s.step}`;

/** Khối Insights: bước hay lỗi (kèm loại lỗi, gợi ý), bước chậm p95, bước chập chờn, flow hay phải nhờ AI sửa. Mỗi mục 5 dòng đầu. */
export function InsightsView({ insights }: { insights: Insights }) {
  return (
    <div className="flex flex-col gap-[12px]" data-testid="insights">
      <InsightList
        title="Bước hay lỗi"
        rows={insights.failingSteps}
        item={(s: StepInsight) => ({
          key: stepKey(s),
          label: `${stepLabel(s)}${s.topErrorType ? ` · ${s.topErrorType}` : ''}`,
          value: `${s.failed}/${s.count}`,
          tone: 'text-red',
          hint: [stepLabel(s), s.lastError, s.lastSuggestion && `Gợi ý: ${s.lastSuggestion}`].filter(Boolean).join('\n'),
        })}
      />
      <InsightList title="Bước chậm (p95)" rows={insights.slowSteps} item={(s: StepInsight) => ({ key: stepKey(s), label: stepLabel(s), value: fmtMs(s.p95Ms) })} />
      <InsightList
        title="Bước chập chờn"
        rows={insights.flakySteps}
        item={(s: StepInsight) => ({ key: stepKey(s), label: stepLabel(s), value: `${s.failedRuns}/${s.runs} lượt`, tone: 'text-amber' })}
      />
      <InsightList
        title="Flow hay phải sửa"
        rows={insights.repairFlows}
        item={(r: RepairInsight) => ({ key: `${r.app}|${r.flow}`, label: `${r.app} · ${r.flow}`, value: `${r.calls} lần · ${vnd(r.costVnd)}` })}
      />
    </div>
  );
}

export function MetricsView({ summary, lastRun, insights }: { summary: MetricsSummary | null; lastRun?: RunRecord; insights?: Insights | null }) {
  const byDevice = summary?.byDevice ?? [];
  if (!summary || byDevice.length === 0) {
    return <Empty title="Chưa có số đo" text="p50, p95, tỉ lệ đạt theo từng máy sẽ hiện sau lượt chạy đầu tiên." />;
  }
  const cold = summary.coldVsWarm?.find((s) => s.key === 'cold');
  const warm = summary.coldVsWarm?.find((s) => s.key === 'warm');
  const counts = [...(summary.byDeviceCount ?? [])].sort((a, b) => Number(a.key) - Number(b.key));
  const failures = (summary.stepFailures ?? []).slice(0, 3);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-[12px] overflow-auto px-[14px] py-[10px]">
      {lastRun && (
        <p className="text-[12px]/[16px] text-text-2" data-testid="last-run">
          Lượt gần nhất: <b className="font-mono font-semibold text-text">{lastRun.passed}</b> đạt,{' '}
          <b className={cx('font-mono font-semibold', lastRun.failed > 0 ? 'text-red' : 'text-text')}>{lastRun.failed}</b> lỗi
          {lastRun.canceled ? ' (đã dừng)' : ''}
          {lastRun.label ? ` · bản ${lastRun.label}` : ''}
        </p>
      )}
      <Table title="Theo máy" rows={byDevice.map((s) => ({ label: s.key, stat: s }))} />
      <Table title="Theo số máy song song" rows={counts.map((s) => ({ label: `${s.key} máy`, stat: s }))} />
      <dl className="grid grid-cols-2 gap-x-[10px] gap-y-[6px] text-[12px]/[15px]">
        {cold && warm && (
          <>
            <dt className="text-text-3">Lần đầu / dùng lại driver (p50)</dt>
            <dd className="text-right font-mono text-text">
              {fmtMs(cold.p50Ms)} / {fmtMs(warm.p50Ms)}
            </dd>
          </>
        )}
        {summary.driverStart.count > 0 && (
          <>
            <dt className="text-text-3">Khởi động driver (p95)</dt>
            <dd className="text-right font-mono text-text">{fmtMs(summary.driverStart.p95Ms)}</dd>
          </>
        )}
        {summary.tapSteps.count > 0 && (
          <>
            <dt className="text-text-3">Bước chạm (p95)</dt>
            <dd className="text-right font-mono text-text">{fmtMs(summary.tapSteps.p95Ms)}</dd>
          </>
        )}
        <dt className="text-text-3">Song song tối đa, đạt hết</dt>
        <dd className="text-right font-mono text-text">{summary.maxParallelOk} máy</dd>
        <dt className="text-text-3">RAM app (đỉnh)</dt>
        <dd className="text-right font-mono text-text">{Math.round(summary.maxRssMB)} MB</dd>
      </dl>
      {insights && <InsightsView insights={insights} />}
      {/* Exe cũ chưa có Insights: giữ danh sách bước hay lỗi từ Metrics */}
      {!insights && failures.length > 0 && (
        <div>
          <p className="mb-[4px] text-[11px]/[14px] font-semibold uppercase tracking-[0.04em] text-text-3">Bước hay lỗi</p>
          <ul className="flex flex-col gap-[3px] text-[12px]/[15px]">
            {failures.map((f) => (
              <li key={f.key} className="flex gap-[8px]">
                <span className="min-w-0 flex-1 truncate font-mono text-text-2" title={f.key}>
                  {f.key}
                </span>
                <span className="shrink-0 font-mono text-red">
                  {f.count - f.passed}/{f.count}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Ô số đo trên desktop: tải lúc mở và sau mỗi lượt chạy. */
export function MetricsPane() {
  const [summary, setSummary] = useState<MetricsSummary | null>(); // null = Go chưa có số đo nào
  const [lastRun, setLastRun] = useState<RunRecord>();
  const [insights, setInsights] = useState<Insights | null>(null);
  const [error, setError] = useState<unknown>();

  const load = useCallback(async () => {
    try {
      // Insights hỏng (exe cũ, DB bận) không được che mất số đo: chỉ ẩn khối Insights.
      const [s, runs, ins] = await Promise.all([testApi.metrics(), testApi.runs(1), testApi.insights().catch(() => null)]);
      setSummary(s ?? null);
      setLastRun(runs[0]);
      setInsights(ins);
      setError(undefined);
    } catch (e) {
      setError(e);
    }
  }, []);

  useEffect(() => {
    void load();
    return onTestEvent((ev) => {
      if (ev.kind === 'run_end') void load();
    });
  }, [load]);

  if (error) return <p className="px-[14px] py-[24px] text-center text-[12px]/[17px] text-text-3">{errorText(error)}</p>;
  if (summary === undefined) return <p className="px-[14px] py-[24px] text-center text-[12px]/[17px] text-text-3">Đang tải số đo…</p>;
  return <MetricsView summary={summary} lastRun={lastRun} insights={insights} />;
}
