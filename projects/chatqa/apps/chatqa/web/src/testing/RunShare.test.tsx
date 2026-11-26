import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { RunDetailView, shareErrorText, shareRunWith } from './RunDetail';
import { TestingLinks } from './TestingPage';
import type { RunReport } from './bridge';

afterEach(() => vi.unstubAllGlobals());

const report: RunReport = {
  run: { id: '261119-1000-ab12', app: 'mexpress', startedAt: '2026-11-19T03:00:00Z', finishedAt: '2026-11-19T03:01:00Z', devices: 1, repeat: 1, passed: 1, failed: 0, canceled: false, artifacts: 'always' },
  flows: [],
};

/** Giả ShareRun theo thứ tự trả về; ghi lại tham số mỗi lần gọi. */
function stubShare(...results: unknown[]) {
  const calls: unknown[][] = [];
  vi.stubGlobal('window', {
    go: {
      test: {
        Service: {
          Track: () => Promise.resolve(),
          ShareRun: (...a: unknown[]) => {
            calls.push(a);
            const r = results.shift();
            return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
          },
        },
      },
    },
  });
  return calls;
}

const done = { runId: report.run.id, deviceId: 'MAC-LAN', files: 12, uploaded: 10, skipped: 2, sizeBytes: 5 * 1024 * 1024 };

describe('chia sẻ lượt lên nhóm', () => {
  it('nút Chia sẻ lên nhóm chỉ khi có hành động (đã cấu hình đồng bộ, có quyền), kèm cảnh báo ảnh/video', () => {
    const html = renderToStaticMarkup(<RunDetailView report={report} onShare={() => undefined} />);
    expect(html).toContain('Chia sẻ lên nhóm');
    expect(html).toContain('mọi người trong nhóm xem được');
    expect(renderToStaticMarkup(<RunDetailView report={report} onShare={() => undefined} sharing />)).toContain('Đang chia sẻ…');
    expect(renderToStaticMarkup(<RunDetailView report={report} />)).not.toContain('Chia sẻ lên nhóm');
  });

  it('gói nhỏ: đẩy ngay, báo số tệp và dung lượng', async () => {
    const calls = stubShare(done);
    const shown: string[] = [];
    const ask = vi.fn(() => true);
    expect(await shareRunWith(report.run.id, (m) => shown.push(m), ask)).toEqual(done);
    expect(calls).toEqual([[report.run.id, false]]);
    expect(ask).not.toHaveBeenCalled();
    expect(shown).toEqual(['Đã chia sẻ lượt lên nhóm: 12 tệp (tải lên 10, đã có 2), 5,0 MB.']);
  });

  it('gói quá ngưỡng: hỏi kèm dung lượng rồi gọi lại với confirm; không đồng ý thì không đẩy', async () => {
    const big = { ...done, files: 0, uploaded: 0, skipped: 0, sizeBytes: 320 * 1024 * 1024, confirmRequired: true, limitBytes: 200 * 1024 * 1024 };
    let calls = stubShare(big, { ...done, sizeBytes: big.sizeBytes });
    const asked: string[] = [];
    expect(await shareRunWith(report.run.id, () => undefined, (m) => (asked.push(m), true))).toMatchObject({ files: 12 });
    expect(asked[0]).toContain('320,0 MB');
    expect(asked[0]).toContain('ngưỡng 200,0 MB');
    expect(calls).toEqual([
      [report.run.id, false],
      [report.run.id, true],
    ]);

    calls = stubShare(big);
    const shown: string[] = [];
    expect(await shareRunWith(report.run.id, (m) => shown.push(m), () => false)).toBeNull();
    expect(calls).toEqual([[report.run.id, false]]);
    expect(shown).toEqual([]);
  });

  it('lượt che bí mật lỗi: câu rõ ràng là chứa bí mật chưa che, không chia sẻ được; lỗi khác dùng câu chung', async () => {
    stubShare(new Error('redaction_failed: lượt che bí mật chưa xong'));
    const shown: string[] = [];
    expect(await shareRunWith(report.run.id, (m) => shown.push(m))).toBeNull();
    expect(shown[0]).toContain('chứa giá trị bí mật chưa che');
    expect(shown[0]).toContain('Không chia sẻ được');
    expect(shareErrorText({ code: 'sync_not_configured' })).toContain('Chưa cấu hình đồng bộ nhóm');
    expect(shareErrorText({ code: 'permission_denied', params: { perm: 'cqs.run' } })).toContain('Bạn không có quyền');
  });
});

describe('lối vào trang con của Kiểm thử', () => {
  it('nút Tài liệu và Đồng bộ theo danh mục', () => {
    const html = renderToStaticMarkup(<TestingLinks onOpen={() => undefined} />);
    expect(html).toContain('Tài liệu');
    expect(html).toContain('Đồng bộ');
    expect(html).not.toContain('>Kiểm thử<');
  });
});
