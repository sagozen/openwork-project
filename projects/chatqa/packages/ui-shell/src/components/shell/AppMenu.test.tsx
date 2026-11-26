import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MODULES, moduleByCode } from '@product/modules/registry';
import type { AppItem } from '../../platform/types';
import { WindowsShell } from './WindowsShell';

// Lấy app từ danh mục của sản phẩm đang chạy để test chạy được ở cả hai app.
const [first, second, third] = MODULES;
const APPS: AppItem[] = [
  { code: first.code, name: first.name, state: 'activated', errorCode: '' },
  { code: second.code, name: second.name, state: 'not_granted', errorCode: 'app_forbidden' },
  ...(third ? [{ code: third.code, name: third.name, state: 'not_activated', errorCode: 'module_locked' } as AppItem] : []),
];

const html = (apps?: AppItem[]) =>
  renderToStaticMarkup(
    <WindowsShell appName="HS Desk" sections={[{ label: 'APP 01', items: [] }]} apps={apps} activeApp={first.code} onPickApp={() => undefined} />,
  );

describe('hàng đổi app trên thanh tiêu đề', () => {
  it('mỗi app một tab trên cùng một hàng, app đang mở làm nổi, có ổ khoá và app chưa kích hoạt bị mờ', () => {
    const h = html(APPS);
    expect(h).toContain('aria-label="Đổi app"');
    for (const a of APPS) expect(h).toContain(moduleByCode(a.code).short);
    expect(h).toContain('aria-current="page"'); // app đang mở
    expect(h).toContain('lucide-lock'); // not_granted
    expect(h).toContain('opacity-45'); // not_activated
    expect(h).toContain('Chưa được cấp'); // tooltip nói rõ trạng thái
  });

  it('không có danh sách app thì thanh tiêu đề giữ logo + tên app như cũ', () => {
    const h = html();
    expect(h).not.toContain('aria-label="Đổi app"');
    expect(h).toContain('HS Desk');
  });
});
