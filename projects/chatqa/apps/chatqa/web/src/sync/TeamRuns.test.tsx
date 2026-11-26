import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { openTeamRunWith, TeamRunsView } from './TeamRuns';
import type { TeamRun } from './sync-api';

afterEach(() => vi.unstubAllGlobals());

const runs: TeamRun[] = [
  {
    runId: '261119-1000-ab12',
    deviceId: 'MAC-LAN',
    author: 'Lan',
    app: 'mexpress',
    label: '1.4.2',
    flows: 6,
    passed: 5,
    failed: 1,
    startedAt: '2026-11-19T03:00:00Z',
    finishedAt: '2026-11-19T03:05:00Z',
    sizeBytes: 12 * 1024 * 1024,
    sharedAt: '2026-11-19T03:06:00Z',
    mine: false,
  },
  { runId: '261119-0900-cd34', deviceId: 'MAC-MINH', author: 'Minh', app: 'vipo', flows: 2, passed: 2, failed: 0, startedAt: '', finishedAt: '', sizeBytes: 2048, sharedAt: '', mine: true },
];

describe('lượt của nhóm', () => {
  it('ai, máy nào, app/nhãn, đạt/lỗi, dung lượng, đánh dấu của tôi, nút mở evidence', () => {
    const html = renderToStaticMarkup(<TeamRunsView runs={runs} onOpen={() => undefined} />);
    expect(html).toContain('mexpress · 1.4.2');
    expect(html).toContain('Lan · máy <span class="font-mono">MAC-LAN</span>');
    expect(html).toContain('6 lượt flow · đạt 5, lỗi 1 · 12,0 MB');
    expect(html.match(/của tôi/g)).toHaveLength(1);
    expect(html.match(/Mở evidence/g)).toHaveLength(2);
    expect(renderToStaticMarkup(<TeamRunsView runs={runs} opening="MAC-LAN/261119-1000-ab12" onOpen={() => undefined} />)).toContain('Đang tải…');
    expect(renderToStaticMarkup(<TeamRunsView runs={[]} />)).toContain('Chưa có lượt nào được chia sẻ');
  });

  it('mở evidence gọi OpenTeamRun với máy và mã lượt; lỗi thành câu báo', async () => {
    const calls: unknown[][] = [];
    vi.stubGlobal('window', {
      go: {
        test: {
          Service: {
            Track: () => Promise.resolve(),
            OpenTeamRun: (...a: unknown[]) => (calls.push(a), Promise.resolve('/data/team/MAC-LAN/261119-1000-ab12/evidence.html')),
          },
        },
      },
    });
    const shown: string[] = [];
    expect(await openTeamRunWith(runs[0], (m) => shown.push(m))).toBe('/data/team/MAC-LAN/261119-1000-ab12/evidence.html');
    expect(calls).toEqual([['MAC-LAN', '261119-1000-ab12']]);
    expect(shown).toEqual([]);
    vi.stubGlobal('window', { go: { test: { Service: { Track: () => Promise.resolve(), OpenTeamRun: () => Promise.reject(new Error('network: không kết nối được kho S3')) } } } });
    expect(await openTeamRunWith(runs[0], (m) => shown.push(m))).toBe('');
    expect(shown).toEqual(['Không kết nối được máy chủ. Kiểm tra mạng.']);
  });
});
