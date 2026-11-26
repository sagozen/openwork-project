/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { WindowsShell } from '@shell/components/shell';
import { PageHeader } from '@shell/components/ui';
import { ProductMark } from './brand';

const brand = (f: string) => readFileSync(resolve(import.meta.dirname, '../../../../docs/brand/chatqa', f), 'utf8');
const attrs = (svg: string) => [...svg.matchAll(/ (d|fill|stroke|stroke-width)="([^"]+)"/g)].map((m) => `${m[1]}=${m[2]}`.toLowerCase());

describe('biểu tượng ChatQASoftware', () => {
  it('nền sáng vẽ đúng logo-mark.svg, nền tối đúng khung chat của app-icon.svg', () => {
    const light = attrs(renderToStaticMarkup(<ProductMark className="h-[40px] w-[40px]" glyph={20} tone="light" />));
    expect(light).toEqual(attrs(brand('logo-mark.svg')));
    // app-icon.svg = ô navy bo góc (fill đầu tiên) + khung chat trắng; trên thanh tiêu đề cùng tông nên chỉ vẽ khung chat
    const [tile, ...icon] = attrs(brand('app-icon.svg'));
    expect(tile).toBe('fill=#0a1f44');
    expect(attrs(renderToStaticMarkup(<ProductMark className="h-[22px] w-[22px]" glyph={14} tone="dark" />))).toEqual(icon);
  });

  it('thanh tiêu đề của shell dùng biểu tượng sản phẩm, không còn kính lúp của HS Desk', () => {
    const html = renderToStaticMarkup(<WindowsShell appName="ChatQASoftware" controls={false} bare />);
    expect(html).toContain('fill="#FFFFFF"');
    expect(html).not.toContain('lucide-scan-search');
  });

  it('dòng trên tiêu đề trang (trang chờ của app) theo màu nhấn của sản phẩm, không cam cố định', () => {
    const html = renderToStaticMarkup(<PageHeader eyebrow="App 1 · Điều phối" title="Điều phối" />);
    expect(html).toContain('text-accent-ink');
    expect(html).not.toContain('orange');
    const css = readFileSync(resolve(import.meta.dirname, 'index.css'), 'utf8');
    // Chữ nhỏ trên nền accent-soft dùng đỏ đậm hơn để đạt tương phản AA.
    expect(css).toContain('--color-accent-ink: #c40022;');
    // Bộ màu Viettel: đỏ thương hiệu cho nút/thanh tiêu đề, navy cho sidebar.
    expect(css).toContain('--color-accent: #e4002b;');
    expect(css).toContain('--color-chrome: #e4002b;');
    expect(css).toContain('--color-sidebar: #0b2244;');
  });
});
