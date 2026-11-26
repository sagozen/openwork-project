import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { TestingView } from './TestingPage';

describe('Kiểm thử', () => {
  it('kho trống: hướng dẫn cách có flow', () => {
    const html = renderToStaticMarkup(<TestingView data={{ apps: [], runs: [] }} />);
    expect(html).toContain('Chưa có flow nào');
    expect(html).toContain('Chưa có lượt chạy nào');
  });

  it('flow theo app và lượt chạy gần nhất với trạng thái', () => {
    const html = renderToStaticMarkup(
      <TestingView
        data={{
          apps: [{ app: 'mexpress', flows: [{ name: '01_login.yaml' }, { name: '02_home.yaml', stale: true }] }],
          runs: [
            { id: 'r1', app: 'mexpress', startedAt: '2026-11-15T02:00:00Z', finishedAt: '', devices: 2, repeat: 3, passed: 6, failed: 0, canceled: false },
            { id: 'r2', app: 'mexpress', startedAt: '2026-11-15T03:00:00Z', finishedAt: '', devices: 1, repeat: 1, passed: 0, failed: 1, canceled: false },
          ],
        }}
      />,
    );
    expect(html).toContain('Flow · mexpress');
    expect(html).toContain('01_login.yaml');
    expect(html).toContain('2 máy × 3 lần · đạt 6, lỗi 0');
    expect(html).toContain('Đạt');
    expect(html).toContain('Lỗi');
  });
});
