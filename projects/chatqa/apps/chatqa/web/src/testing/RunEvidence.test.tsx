import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ApiError } from '@shell/platform';
import { ARTIFACT_OPTIONS, buildCompile, buildDispatch, compileDevices, compileProblem, defaultPlatform, PLATFORM_OPTIONS, type CompileFormValue, type RunFormValue } from './RunForm';
import type { Device } from '../live/bridge';
import { ExportedPath, exportSpecWith, exportWith, openWith, RunDetailView, SHOT_NOTE, shotCache, TRACE_NOTE, validHistoryDays } from './RunDetail';
import { RetentionView, validRetention } from './TestSettingsPage';
import { InsightsView, MetricsView } from './MetricsPane';
import { SpecExportButton, TestingView } from './TestingPage';
import { pageOf } from './use-page-views';
import { testApi, type Insights, type MetricsSummary, type RunReport, type Stat } from './bridge';

/** Giả window.go.test.Service (Wails) cho các hàm Go được gọi; trả danh sách lần gọi Track. */
function stubGo(service: Record<string, (...a: unknown[]) => unknown>) {
  const tracked: unknown[][] = [];
  vi.stubGlobal('window', {
    go: {
      test: {
        Service: {
          Track: (...a: unknown[]) => {
            tracked.push(a);
            return Promise.resolve();
          },
          ...service,
        },
      },
    },
  });
  return tracked;
}

afterEach(() => {
  vi.unstubAllGlobals();
  shotCache.clear();
});

const form: RunFormValue = { app: 'mexpress', flows: [], secrets: ['PASSWORD'], repeat: '2', count: '', label: ' 1.4.2 ', artifacts: 'always', platform: '' };

describe('form chạy tay', () => {
  it('mặc định chụp mọi bước, có đủ 3 mức', () => {
    expect(ARTIFACT_OPTIONS.map((o) => o.key)).toEqual(['always', 'on-failure', 'never']);
    expect(ARTIFACT_OPTIONS[0].label).toBe('Mọi bước');
  });

  it('truyền artifacts đã chọn vào lệnh chạy, số lặp/số máy hợp lệ', () => {
    const req = buildDispatch(form);
    expect(req.artifacts).toBe('always');
    expect(req).toMatchObject({ app: 'mexpress', flows: [], secrets: ['PASSWORD'], repeat: 2, label: '1.4.2', devices: [] });
    expect(req.filter.count).toBe(0); // trống = mọi máy rảnh
    expect(buildDispatch({ ...form, artifacts: 'on-failure' }).artifacts).toBe('on-failure');
    expect(buildDispatch({ ...form, artifacts: 'never', repeat: '0', count: '-3' })).toMatchObject({ artifacts: 'never', repeat: 1, filter: { count: 0 } });
  });
});

const report: RunReport = {
  run: { id: '261118-1430-ab12', app: 'mexpress', startedAt: '2026-11-18T07:30:00Z', finishedAt: '2026-11-18T07:31:00Z', devices: 1, repeat: 1, passed: 0, failed: 1, canceled: false, artifacts: 'always' },
  flows: [
    {
      runId: '261118-1430-ab12',
      deviceId: 'R58N123',
      platform: 'android',
      driver: 'uiautomator2',
      flow: '01_login.yaml',
      iteration: 1,
      passed: false,
      durationMs: 9100,
      error: 'Không thấy nút Đăng nhập',
      steps: [
        { index: 0, depth: 0, command: 'launchApp', desc: 'mở app', passed: true, durationMs: 2100, shotBefore: 'shots/0-before.png', shotAfter: 'shots/0-after.png' },
        {
          index: 1,
          depth: 0,
          command: 'tapOn',
          desc: 'Đăng nhập',
          label: 'Bấm Đăng nhập',
          passed: false,
          durationMs: 7000,
          yaml: '- tapOn: "Đăng nhập"',
          selector: 'text=Đăng nhập',
          element: 'text="Đăng nhập" id=btn [10,20 100x40]',
          errorType: 'element_not_found',
          error: 'Không thấy phần tử',
          suggestion: 'Thêm waitForAnimationToEnd',
          shotAfter: 'shots/1-after.png',
        },
      ],
    },
  ],
};

describe('chi tiết lượt chạy theo bước', () => {
  it('đủ lệnh/nhãn, YAML, selector, phần tử, thời gian, lỗi, gợi ý và ô ảnh chờ tải lười', () => {
    const html = renderToStaticMarkup(<RunDetailView report={report} onExport={() => undefined} />);
    for (const s of [
      'R58N123 · lần 1 · 01_login.yaml',
      'launchApp · mở app',
      'Bấm Đăng nhập',
      '- tapOn: &quot;Đăng nhập&quot;',
      'text=Đăng nhập',
      'id=btn [10,20 100x40]',
      '7 s',
      'element_not_found',
      'Không thấy phần tử',
      'Gợi ý: Thêm waitForAnimationToEnd',
      'Xuất gói báo cáo',
      'ảnh mọi bước',
      SHOT_NOTE,
    ]) {
      expect(html, s).toContain(s);
    }
    expect(html.match(/data-testid="step"/g)).toHaveLength(2);
    expect(html).toContain('data-shot="shots/0-before.png"');
    expect(html).toContain('data-shot="shots/1-after.png"');
    // Chưa tải ảnh: nút ảnh tắt, chưa có <img>.
    expect(html).not.toContain('<img');
    // Flow lỗi mở sẵn.
    expect(html).toMatch(/<details open=""[^>]*data-testid="flow-run"/);
  });

  it('ảnh đã tải trong phiên hiện ngay và bấm được để phóng to', () => {
    shotCache.set('261118-1430-ab12/shots/1-after.png', 'data:image/png;base64,AAAA');
    const html = renderToStaticMarkup(<RunDetailView report={report} />);
    expect(html).toContain('src="data:image/png;base64,AAAA"');
    expect(html).toContain('bấm để phóng to');
    // Không có nút xuất thì không có ghi chú ảnh.
    expect(html).not.toContain('Xuất gói báo cáo');
  });

  it('lượt cũ không có mức ảnh, flow không có bước', () => {
    const html = renderToStaticMarkup(
      <RunDetailView report={{ run: { ...report.run, artifacts: undefined }, flows: [{ ...report.flows![0], passed: true, error: undefined, steps: null }] }} />,
    );
    expect(html).toContain('chỉ khi lỗi (lượt cũ)');
    expect(html).toContain('Không có bước nào được ghi.');
  });

  it('danh sách lượt: chi tiết hiện ngay dưới lượt đang mở', () => {
    const html = renderToStaticMarkup(
      <TestingView
        data={{ apps: [], runs: [report.run, { ...report.run, id: 'r2' }] }}
        selected="r2"
        onSelect={() => undefined}
        detail={<p>chi-tiet</p>}
      />,
    );
    expect(html.match(/chi-tiet/g)).toHaveLength(1);
    expect(html).toContain('aria-expanded="true"');
    expect(html.indexOf('aria-expanded="false"')).toBeLessThan(html.indexOf('chi-tiet'));
  });

  it('mỗi dòng lượt và chi tiết lượt có nút Mở thư mục, Mở báo cáo (chỉ khi có hành động)', () => {
    const rows = renderToStaticMarkup(
      <TestingView data={{ apps: [], runs: [report.run, { ...report.run, id: 'r2' }] }} onOpenFolder={() => undefined} onOpenReport={() => undefined} />,
    );
    expect(rows.match(/Mở thư mục/g)).toHaveLength(2);
    expect(rows.match(/Mở báo cáo/g)).toHaveLength(2);
    expect(renderToStaticMarkup(<TestingView data={{ apps: [], runs: [report.run] }} />)).not.toContain('Mở thư mục');
    const detail = renderToStaticMarkup(<RunDetailView report={report} onOpenFolder={() => undefined} onOpenReport={() => undefined} />);
    for (const s of ['Mở thư mục', 'Mở báo cáo']) expect(detail, s).toContain(s);
    expect(detail).not.toMatch(/Drive/i);
  });
});

describe('xuất gói báo cáo và lịch sử', () => {
  it('lưu xong: báo đường dẫn và ghi lịch sử sử dụng', async () => {
    const tracked = stubGo({});
    const show = vi.fn();
    expect(await exportWith(() => Promise.resolve('/Users/me/chatqa-run-r1.zip'), show, 'export_run', { runId: 'r1' })).toBe('/Users/me/chatqa-run-r1.zip');
    expect(show).toHaveBeenCalledWith('Đã lưu /Users/me/chatqa-run-r1.zip');
    await vi.waitFor(() => expect(tracked).toEqual([['export_run', { runId: 'r1', result: 'saved' }]]));
  });

  it('sau khi xuất: hiện đường dẫn kèm nút mở thư mục chứa file (RevealFile)', async () => {
    const html = renderToStaticMarkup(<RunDetailView report={report} onExport={() => undefined} exported="/data/exports/chatqa-run-r1.zip" onReveal={() => undefined} />);
    expect(html).toContain('Đã lưu /data/exports/chatqa-run-r1.zip');
    expect(renderToStaticMarkup(<ExportedPath path="/x.json" onReveal={() => undefined} />)).toContain('Mở thư mục');
    const revealed: unknown[] = [];
    const tracked = stubGo({ RevealFile: (p: unknown) => (revealed.push(p), Promise.resolve()) });
    const show = vi.fn();
    expect(await openWith(() => testApi.revealFile('/data/exports/chatqa-run-r1.zip'), show, 'reveal_export')).toBe(true);
    expect(revealed).toEqual(['/data/exports/chatqa-run-r1.zip']);
    expect(show).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(tracked).toEqual([['reveal_export', { result: 'ok' }]]));
  });

  it('mở báo cáo lỗi: câu lỗi chung; lượt che bí mật hỏng có câu riêng', async () => {
    stubGo({ OpenRunReport: () => Promise.reject(new ApiError('redaction_failed', 0)), OpenRunFolder: () => Promise.reject(new Error('not_found: lượt chạy r9')) });
    const show = vi.fn();
    expect(await openWith(() => testApi.openRunReport('r1'), show, 'open_run_report')).toBe(false);
    expect(show.mock.calls[0][0]).toContain('che bí mật lỗi');
    expect(await openWith(() => testApi.openRunFolder('r9'), show, 'open_run_folder')).toBe(false);
    expect(show).toHaveBeenCalledTimes(2);
  });

  it('lỗi Go hiện bằng câu lỗi chung; che bí mật hỏng có câu riêng', async () => {
    stubGo({ ExportRun: () => Promise.reject(new Error('permission_denied: cqs.reports')) });
    const show = vi.fn();
    expect(await exportWith(() => testApi.exportRun('r1'), show, 'export_run')).toBe('');
    expect(show.mock.calls[0][0]).toMatch(/^Bạn không có quyền/);
    show.mockClear();
    await exportWith(() => Promise.reject(new ApiError('redaction_failed', 0)), show, 'export_run');
    expect(show.mock.calls[0][0]).toContain('che bí mật lỗi');
  });

  it('số ngày lịch sử 1..3650', () => {
    for (const ok of [1, 30, 3650]) expect(validHistoryDays(ok)).toBe(true);
    for (const bad of [0, -1, 3651, 1.5, Number.NaN]) expect(validHistoryDays(bad)).toBe(false);
  });
});

describe('số ngày giữ dữ liệu', () => {
  it('chỉ nhận số nguyên 7..3650', () => {
    for (const ok of ['7', '90', '3650', ' 30 ']) expect(validRetention(ok), ok).toBe(true);
    for (const bad of ['', '6', '3651', '0', '-7', '7.5', 'abc', '1e3']) expect(validRetention(bad), bad).toBe(false);
  });

  it('ô số có giới hạn, hiện giá trị đã lưu, nút Lưu tắt khi chưa đổi', () => {
    const html = renderToStaticMarkup(<RetentionView saved={90} onSave={() => undefined} />);
    expect(html).toContain('Giữ dữ liệu');
    expect(html).toContain('min="7"');
    expect(html).toContain('max="3650"');
    expect(html).toContain('value="90"');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Lưu/);
  });
});

const stat = (key: string): Stat => ({ key, count: 10, passed: 9, p50Ms: 800, p95Ms: 1200, passRate: 0.9 });

const insights: Insights = {
  failingSteps: [
    {
      flow: '01_login.yaml',
      step: 'tapOn text=Đăng nhập',
      command: 'tapOn',
      count: 10,
      failed: 4,
      failRate: 0.4,
      runs: 10,
      failedRuns: 4,
      p50Ms: 900,
      p95Ms: 7000,
      topErrorType: 'element_not_found',
      lastError: 'Không thấy phần tử',
      lastSuggestion: 'Chờ hết hiệu ứng',
    },
  ],
  slowSteps: [{ flow: '02_home.yaml', step: 'scrollUntilVisible text=Đơn', command: 'scrollUntilVisible', count: 8, failed: 0, failRate: 0, runs: 8, failedRuns: 0, p50Ms: 4000, p95Ms: 12345 }],
  flakySteps: [{ flow: '03_order.yaml', step: 'assertVisible text=Đã lưu', command: 'assertVisible', count: 6, failed: 2, failRate: 0.33, runs: 6, failedRuns: 2, p50Ms: 300, p95Ms: 500 }],
  repairFlows: [{ app: 'mexpress', flow: '01_login.yaml', calls: 3, errors: 1, costVnd: 4500 }],
};

describe('khối Insights', () => {
  it('bước hay lỗi, bước chậm p95, bước chập chờn, flow hay phải sửa', () => {
    const html = renderToStaticMarkup(<InsightsView insights={insights} />);
    for (const s of [
      'Bước hay lỗi',
      '01_login.yaml · tapOn text=Đăng nhập · element_not_found',
      '4/10',
      'Gợi ý: Chờ hết hiệu ứng',
      'Bước chậm (p95)',
      '12,3 s',
      'Bước chập chờn',
      '2/6 lượt',
      'Flow hay phải sửa',
      'mexpress · 01_login.yaml',
      '3 lần',
    ]) {
      expect(html, s).toContain(s);
    }
  });

  it('danh sách rỗng hoặc null thì ẩn mục; có Insights thì thay danh sách bước hay lỗi cũ', () => {
    expect(renderToStaticMarkup(<InsightsView insights={{ failingSteps: null, slowSteps: [], flakySteps: null, repairFlows: [] }} />)).not.toContain('<ul');
    const summary: MetricsSummary = {
      byDevice: [stat('R58N123')],
      byDeviceCount: null,
      coldVsWarm: null,
      driverStart: stat('d'),
      tapSteps: stat('t'),
      stepFailures: [stat('tapOn cũ')],
      maxParallelOk: 1,
      maxRssMB: 50,
      cpuMsPerRun: 0,
    };
    const withIns = renderToStaticMarkup(<MetricsView summary={summary} insights={insights} />);
    expect(withIns).toContain('data-testid="insights"');
    expect(withIns).not.toContain('tapOn cũ');
    expect(renderToStaticMarkup(<MetricsView summary={summary} />)).toContain('tapOn cũ');
  });
});

describe('lịch sử sử dụng', () => {
  it('Track hỏng không bao giờ ném lỗi', async () => {
    vi.stubGlobal('window', { go: { test: { Service: { Track: () => Promise.reject(new Error('invalid: kind')) } } } });
    await expect(testApi.track('page_view', { page: '/' })).resolves.toBeUndefined();
    vi.stubGlobal('window', {
      go: {
        test: {
          Service: {
            Track: () => {
              throw new Error('boom');
            },
          },
        },
      },
    });
    await expect(testApi.track('run_start')).resolves.toBeUndefined();
    // Bản web/exe cũ: không có hàm Go.
    vi.stubGlobal('window', {});
    await expect(testApi.track('page_view', { page: '/' })).resolves.toBeUndefined();
  });

  it('gửi đúng loại và chi tiết; trang theo đường dẫn route', async () => {
    const tracked = stubGo({});
    await testApi.track('page_view', { page: pageOf('/kiem-thu/') });
    expect(tracked).toEqual([['page_view', { page: '/kiem-thu' }]]);
    expect(pageOf('')).toBe('/');
    expect(pageOf('/')).toBe('/');
  });
});

describe('flow web', () => {
  it('chọn nền tảng: Tất cả, Android, iOS, Web thành filter.platform', () => {
    expect(PLATFORM_OPTIONS.map((o) => [o.key, o.label])).toEqual([
      ['', 'Tất cả'],
      ['android', 'Android'],
      ['ios', 'iOS'],
      ['web', 'Web'],
    ]);
    expect(buildDispatch({ ...form, platform: 'web', flows: ['10_checkout.spec.ts'] }).filter).toEqual({ platform: 'web', model: '', count: 0 });
    expect(buildDispatch(form).filter.platform).toBe('');
  });

  it('chỉ chọn flow .spec.ts thì mặc định chạy trên Web; có flow .yaml hoặc chưa chọn flow thì mọi máy', () => {
    expect(defaultPlatform(['10_checkout.spec.ts', 'web/20_search.spec.ts'])).toBe('web');
    expect(defaultPlatform(['10_checkout.spec.ts', '01_login.yaml'])).toBe('');
    expect(defaultPlatform([])).toBe('');
  });

  const webReport: RunReport = {
    run: { ...report.run, id: 'r-web' },
    flows: [
      {
        runId: 'r-web',
        deviceId: 'web-staging',
        platform: 'web',
        driver: 'playwright',
        flow: '10_checkout.spec.ts',
        iteration: 1,
        passed: false,
        durationMs: 4200,
        error: 'web_host_blocked: evil.example.net',
        trace: '/data/runs/r-web/web-staging/r01-10_checkout/trace.zip',
        steps: [
          { index: 0, depth: 0, command: 'step', desc: 'Mở giỏ hàng', passed: true, durationMs: 900 },
          { index: 1, depth: 1, command: 'pw:api', desc: "locator.click(getByRole('button', { name: 'Thanh toán' }))", passed: true, durationMs: 300 },
          {
            index: 2,
            depth: 0,
            command: 'step',
            desc: 'Thanh toán',
            passed: false,
            durationMs: 3000,
            error: 'Timeout 5000ms',
            shotAfter: 'web-staging/r01-10_checkout/assets/failure-1.png',
            hierarchy: '- main:\n  - button "Thanh toán" [ref=e5]',
          },
        ],
      },
    ],
  };

  it('chi tiết flow web: bước con lồng, cây aria lúc lỗi thu gọn, trace kèm ghi chú và nút mở thư mục lượt', () => {
    const html = renderToStaticMarkup(<RunDetailView report={webReport} onOpenFolder={() => undefined} />);
    expect(html).toContain('Mở giỏ hàng');
    expect(html).toContain('padding-left:14px');
    expect(html).toContain('data-testid="aria-snapshot"');
    expect(html).toContain('Cây aria lúc lỗi');
    expect(html).toContain('button &quot;Thanh toán&quot; [ref=e5]');
    expect(html).toContain('data-testid="trace-row"');
    expect(html).toContain(TRACE_NOTE);
    expect(html).toContain('Mở thư mục lượt chạy');
    // Trace không bao giờ hiện đường dẫn để gửi đi, chỉ mở thư mục
    expect(html).not.toContain('trace.zip</');
  });

  it('cây aria Go lưu ra file: chỉ chỗ lưu và nút mở thư mục lượt; flow điện thoại không có khối aria, không có trace', () => {
    const steps = webReport.flows![0].steps!.map((st) => (st.passed ? st : { ...st, hierarchy: 'web-staging/r01-10_checkout/assets/failure-aria-1.txt' }));
    const html = renderToStaticMarkup(<RunDetailView report={{ ...webReport, flows: [{ ...webReport.flows![0], steps }] }} onOpenFolder={() => undefined} />);
    expect(html).toContain('web-staging/r01-10_checkout/assets/failure-aria-1.txt');
    expect(html).not.toContain('<pre class="mt-[4px] max-h-[260px]');
    const mobile = renderToStaticMarkup(<RunDetailView report={report} onOpenFolder={() => undefined} />);
    expect(mobile).not.toContain('aria-snapshot');
    expect(mobile).not.toContain('trace-row');
  });

  it('nút Xuất chạy độc lập chỉ ở flow .spec.ts và chỉ khi có quyền (có hành động)', () => {
    expect(renderToStaticMarkup(<RunDetailView report={webReport} onExportSpec={() => undefined} />)).toContain('Xuất chạy độc lập');
    expect(renderToStaticMarkup(<RunDetailView report={webReport} />)).not.toContain('Xuất chạy độc lập');
    expect(renderToStaticMarkup(<RunDetailView report={report} onExportSpec={() => undefined} />)).not.toContain('Xuất chạy độc lập');
    const apps = [{ app: 'shop', flows: [{ name: '01_login.yaml' }, { name: '10_checkout.spec.ts' }] }];
    const list = renderToStaticMarkup(
      <TestingView
        data={{ apps, runs: [] }}
        flowAction={(_app, f) => (f.name.endsWith('.spec.ts') ? <SpecExportButton profiles={[]} onExport={async () => ''} /> : null)}
      />,
    );
    expect(list.match(/Xuất chạy độc lập/g)).toHaveLength(1);
    expect(renderToStaticMarkup(<TestingView data={{ apps, runs: [] }} />)).not.toContain('Xuất chạy độc lập');
  });

  it('nhiều hồ sơ trình duyệt: chọn hồ sơ cho bản xuất, mặc định hồ sơ đầu', () => {
    const p = { id: 'web-a', name: 'Staging', browser: 'chromium', channel: '', width: 1280, height: 800, baseURL: 'https://a.example.com', headless: true, allowedHosts: [], testIdAttribute: 'data-testid' };
    const html = renderToStaticMarkup(<SpecExportButton profiles={[p, { ...p, id: 'web-b', name: 'Prod' }]} onExport={async () => ''} />);
    expect(html).toMatch(/<option value="web-a" selected="">Staging/);
    expect(html).toContain('Không dùng hồ sơ');
    expect(renderToStaticMarkup(<SpecExportButton profiles={[p]} onExport={async () => ''} />)).not.toContain('<select');
  });

  it('xuất chạy độc lập: gọi ExportSpec với app, flow, hồ sơ rồi mở thư mục chứa zip', async () => {
    const calls: unknown[][] = [];
    const tracked = stubGo({
      ExportSpec: (...a: unknown[]) => {
        calls.push(['ExportSpec', ...a]);
        return Promise.resolve('/data/exports/shop-10_checkout-standalone-20261119.zip');
      },
      RevealFile: (...a: unknown[]) => {
        calls.push(['RevealFile', ...a]);
        return Promise.resolve();
      },
    });
    const show = vi.fn();
    expect(await exportSpecWith('shop', '10_checkout.spec.ts', 'web-staging', show)).toBe('/data/exports/shop-10_checkout-standalone-20261119.zip');
    expect(calls).toEqual([
      ['ExportSpec', 'shop', '10_checkout.spec.ts', 'web-staging'],
      ['RevealFile', '/data/exports/shop-10_checkout-standalone-20261119.zip'],
    ]);
    expect(show).toHaveBeenCalledWith('Đã lưu /data/exports/shop-10_checkout-standalone-20261119.zip');
    expect(tracked.map((t) => t[0])).toEqual(['export_spec', 'reveal_export']);
  });

  it('xuất lỗi (flow không phải .spec.ts, thiếu quyền): câu lỗi, không mở thư mục', async () => {
    const reveal = vi.fn();
    stubGo({ ExportSpec: () => Promise.reject(new Error('permission_denied: cqs.run')), RevealFile: reveal });
    const show = vi.fn();
    expect(await exportSpecWith('shop', '10_checkout.spec.ts', '', show)).toBe('');
    expect(reveal).not.toHaveBeenCalled();
    expect(show.mock.calls[0][0]).not.toContain('Đã lưu');
  });
});

describe('nguồn có thể sai và sinh ca từ yêu cầu', () => {
  it('nút Nguồn có thể sai chỉ ở flow lỗi nối yêu cầu và chỉ khi có quyền', () => {
    const passed = { ...report.flows![0], flow: '02_home.yaml', passed: true, error: undefined };
    const r: RunReport = { ...report, flows: [report.flows![0], passed] };
    const noteReqs = { '01_login.yaml': ['REQ-001'], '02_home.yaml': ['REQ-002'] };
    const withNote = renderToStaticMarkup(<RunDetailView report={r} noteReqs={noteReqs} onNote={() => undefined} />);
    expect(withNote.match(/Nguồn có thể sai/g)).toHaveLength(1);
    expect(withNote).toContain('Yêu cầu: REQ-001');
    expect(renderToStaticMarkup(<RunDetailView report={r} noteReqs={noteReqs} />)).not.toContain('Nguồn có thể sai');
    expect(renderToStaticMarkup(<RunDetailView report={r} noteReqs={{}} onNote={() => undefined} />)).not.toContain('Nguồn có thể sai');
  });

  const phone: Device = { id: 'R58N123', platform: 'android', state: 'ready', driver: 'uiautomator2' };
  const iphone: Device = { id: '00008101-AAA', platform: 'ios', state: 'ready', driver: 'wda', simulator: false };
  const web: Device = { id: 'web-staging', platform: 'web', state: 'ready', driver: 'playwright' };
  const v: CompileFormValue = { app: 'mexpress', reqs: ['REQ-001', 'AC-02'], deviceId: 'R58N123', appId: ' com.example.app ', startPath: '', secrets: ['PASSWORD'] };

  it('lệnh biên dịch mang reqs, nguồn trống; App ID chỉ cho điện thoại, trang mở đầu chỉ cho web, Team ID chỉ cho iPhone thật', () => {
    expect(buildCompile(v, phone, 'TEAM123456')).toEqual({
      app: 'mexpress',
      source: '',
      appId: 'com.example.app',
      device: { ID: 'R58N123', Platform: 'android', Driver: 'uiautomator2' },
      env: {},
      secrets: ['PASSWORD'],
      confirmToken: '',
      startPath: '',
      reqs: ['REQ-001', 'AC-02'],
    });
    expect(buildCompile(v, iphone, 'TEAM123456', 'tok').device).toEqual({ ID: '00008101-AAA', Platform: 'ios', Driver: 'wda', TeamID: 'TEAM123456' });
    expect(buildCompile(v, iphone, 'TEAM123456', 'tok').confirmToken).toBe('tok');
    expect(buildCompile({ ...v, startPath: ' /login ' }, web, '')).toMatchObject({ appId: '', startPath: '/login', device: { ID: 'web-staging', Platform: 'web' } });
  });

  it('kiểm form như Go trước khi gửi; máy đã rút không chọn được', () => {
    expect(compileProblem(v, phone)).toBe('');
    expect(compileProblem({ ...v, reqs: [] }, phone)).toContain('mã yêu cầu');
    expect(compileProblem(v, undefined)).toContain('Chọn máy');
    expect(compileProblem({ ...v, appId: 'example' }, phone)).toContain('App ID');
    expect(compileProblem({ ...v, appId: '' }, web)).toBe('');
    expect(compileProblem({ ...v, startPath: 'login' }, web)).toContain('bắt đầu bằng /');
    expect(compileProblem({ ...v, startPath: '//evil.com' }, web)).toContain('bắt đầu bằng /');
    expect(compileDevices([phone, { ...web, state: 'disconnected' }]).map((d) => d.id)).toEqual(['R58N123']);
  });
});
