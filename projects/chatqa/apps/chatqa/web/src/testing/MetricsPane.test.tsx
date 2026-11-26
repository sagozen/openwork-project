import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { fmtMs, MetricsView } from './MetricsPane';
import type { MetricsSummary, Stat } from './bridge';
import { Workspace } from '../workspace/Workspace';

const stat = (key: string, p50: number, p95: number, passed = 10, count = 10): Stat => ({ key, count, passed, p50Ms: p50, p95Ms: p95, passRate: passed / count });

const summary: MetricsSummary = {
  byDevice: [stat('R58N123', 8200, 9100), stat('00008101-BBB', 11800, 14250, 9)],
  byDeviceCount: [stat('3', 9000, 12000), stat('1', 8000, 9000)],
  coldVsWarm: [stat('cold', 21000, 23000, 2, 2), stat('warm', 8100, 9500, 17, 18)],
  driverStart: stat('driverStart', 12600, 13800, 2, 2),
  tapSteps: stat('tapOn', 410, 760, 60, 60),
  stepFailures: [{ ...stat('tapOn: text="Đăng nhập"', 8000, 8000, 9), key: 'tapOn: text="Đăng nhập"' }],
  maxParallelOk: 1,
  maxRssMB: 61.4,
  cpuMsPerRun: 900,
};

describe('ô số đo', () => {
  it('định dạng thời gian', () => {
    expect(fmtMs(840)).toBe('840 ms');
    expect(fmtMs(12345)).toBe('12,3 s');
  });

  it('chưa có lượt chạy: lời nhắc thay vì bảng rỗng', () => {
    const empty = { ...summary, byDevice: null, byDeviceCount: null, coldVsWarm: null, stepFailures: null };
    for (const html of [renderToStaticMarkup(<MetricsView summary={empty} />), renderToStaticMarkup(<MetricsView summary={null} />)]) {
      expect(html).toContain('Chưa có số đo');
      expect(html).not.toContain('<table');
    }
  });

  it('p50/p95 và tỉ lệ đạt theo máy, theo số máy, lạnh/ấm, bước hay lỗi', () => {
    const html = renderToStaticMarkup(
      <MetricsView summary={summary} lastRun={{ id: 'r1', app: 'mexpress', startedAt: '', finishedAt: '', devices: 2, repeat: 10, passed: 19, failed: 1, canceled: false, label: '1.4.2' }} />,
    );
    for (const s of ['R58N123', '00008101-BBB', '9,1 s', '14,3 s', '90%', '1 máy', '3 máy', '21 s / 8,1 s', '13,8 s', '760 ms', '61 MB', 'tapOn: text=&quot;Đăng nhập&quot;', '1/10', 'bản 1.4.2']) {
      expect(html, s).toContain(s);
    }
    // Theo số máy xếp tăng dần.
    expect(html.indexOf('1 máy')).toBeLessThan(html.indexOf('3 máy'));
  });

  it('ô 4 của màn làm việc hiện nội dung được truyền vào', () => {
    const html = renderToStaticMarkup(<Workspace devices={0} metrics={<p>bảng số đo</p>} />);
    expect(html).toContain('<p>bảng số đo</p>');
    expect(html).not.toContain('Chưa có số đo');
  });
});
