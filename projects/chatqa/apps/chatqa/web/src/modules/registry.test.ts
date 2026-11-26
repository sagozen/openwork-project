import { describe, expect, it } from 'vitest';
import catalog from '@contracts/apps.json';
import products from '@contracts/products.json';
import { APP_CODES } from '@shell/platform/types';
import { PRODUCT } from '../product';
import { ALL_MODULES, MODULE_UI, MODULES, moduleByCode, moduleOfPath, pagePath } from './registry';

// Chỉ app của ChatQASoftware: contracts/apps.json có app của mọi sản phẩm.
const apps = catalog.apps.filter((a) => a.product === 'chatqa');

describe('danh mục phân hệ ChatQASoftware', () => {
  it('PRODUCT khớp contracts/products.json', () => {
    expect(products.products).toContainEqual({ code: PRODUCT.code, name: PRODUCT.name });
    expect(PRODUCT.code).not.toBe(products.default);
  });

  it('APP_CODES (kiểu AppCode) khớp contracts/apps.json', () => {
    expect(apps.length).toBeGreaterThan(0);
    expect([...APP_CODES]).toEqual(apps.map((a) => a.code));
  });

  it('mọi app trong contracts có phần giao diện, không thừa app nào', () => {
    for (const a of apps) expect(MODULE_UI[a.code as keyof typeof MODULE_UI], a.code).toBeDefined();
    expect(Object.keys(MODULE_UI).sort()).toEqual(apps.map((a) => a.code).sort());
  });

  it('tên, số app, trạng thái lấy từ contracts', () => {
    expect(ALL_MODULES.map((m) => [m.code, m.no, m.name, m.status])).toEqual(apps.map((a) => [a.code, a.no, a.name, a.status]));
  });

  it('đường dẫn duy nhất (app × trang con), không trùng route chung', () => {
    const paths = ALL_MODULES.flatMap((m) => m.pages.map((p) => pagePath(m, p)));
    expect(new Set(paths).size).toBe(paths.length);
    for (const p of paths) {
      expect(p).toMatch(/^\/[a-z0-9-]+(\/[a-z0-9-]+)?$/);
      expect(['/', '/cai-dat', '/quan-tri', '/doi-mat-khau']).not.toContain(p);
    }
  });

  it('mỗi app có trang mở đầu', () => {
    for (const m of ALL_MODULES) expect(m.pages[0]?.path, m.code).toBe('');
  });

  it('nhận ra app từ đường dẫn', () => {
    expect(moduleOfPath('/kiem-thu')?.code).toBe('cqs.test');
    expect(moduleOfPath('/kiem-thu-x')).toBeUndefined();
    expect(moduleOfPath('/cai-dat')).toBeUndefined();
    expect(moduleByCode('cqs.monitor').path).toBe('/giam-sat');
  });

  it('Kiểm thử có trang Tài liệu và Đồng bộ (trang con, không phải app riêng)', () => {
    const test = moduleByCode('cqs.test');
    expect(test.pages.map((p) => [p.path, p.label])).toEqual([
      ['', 'Kiểm thử'],
      ['tai-lieu', 'Tài liệu'],
      ['dong-bo', 'Đồng bộ'],
    ]);
    expect(pagePath(test, test.pages[1])).toBe('/kiem-thu/tai-lieu');
    expect(pagePath(test, test.pages[2])).toBe('/kiem-thu/dong-bo');
    expect(moduleOfPath('/kiem-thu/tai-lieu')?.code).toBe('cqs.test');
    expect(moduleOfPath('/kiem-thu/dong-bo')?.code).toBe('cqs.test');
  });

  it('mọi app đều có route (kể cả planned), đúng thứ tự số app', () => {
    expect(MODULES.map((m) => m.no)).toEqual([1, 2, 3]);
  });
});
