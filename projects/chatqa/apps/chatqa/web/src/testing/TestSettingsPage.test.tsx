import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { AdminProvider } from '@shell/pages/admin/admin-context';
import { TestSettingsView, validTeamId } from './TestSettingsPage';

const render = (saved: string) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <AdminProvider base="/cai-dat" extraTabs={[{ key: 'test', label: 'Kiểm thử', path: 'kiem-thu', element: null }]}>
        <TestSettingsView saved={saved} onSave={() => undefined} />
      </AdminProvider>
    </MemoryRouter>,
  );

describe('Cài đặt › Kiểm thử', () => {
  it('Team ID: đúng 10 chữ hoa hoặc số, để trống là xoá', () => {
    expect(validTeamId('RYGM3T4HUL')).toBe(true);
    expect(validTeamId('')).toBe(true);
    for (const bad of ['rygm3t4hul', 'RYGM3T4HU', 'RYGM3T4HULL', 'RYGM3T4H-L']) expect(validTeamId(bad)).toBe(false);
  });

  it('có tab Kiểm thử đang chọn, thẻ Apple Team ID và giá trị đã lưu', () => {
    const html = render('RYGM3T4HUL');
    expect(html).toContain('Cài đặt › Kiểm thử');
    expect(html).toMatch(/aria-selected="true"[^>]*>Kiểm thử/);
    expect(html).toContain('Apple Team ID');
    expect(html).toContain('value="RYGM3T4HUL"');
  });

  it('chưa lưu: ô trống, nút Lưu tắt', () => {
    const html = render('');
    expect(html).toContain('placeholder="ABCDE12345"');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Lưu/);
  });
});
