import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import fixtures from './fixtures.json';
import type { ChatItem } from './bridge';
import { ChatComponent, COMPONENTS, confirmCost, noActions } from './components';
import { COMPONENT_KINDS, validateComponent } from './schema';
import { Transcript } from './ChatPane';

const items = fixtures.items as ChatItem[];
const sample = (kind: string) => items.find((i) => i.kind === kind && validateComponent(kind, i.data) === null)?.data;

describe('component chat', () => {
  it('registry khớp hợp đồng: mỗi kind có component và mẫu hợp lệ', () => {
    expect(Object.keys(COMPONENTS).sort()).toEqual([...COMPONENT_KINDS].sort());
    for (const kind of COMPONENT_KINDS) expect(sample(kind), kind).toBeDefined();
  });

  it('mỗi component vẽ được từ mẫu, không rơi về JSON thô', () => {
    for (const kind of COMPONENT_KINDS) {
      const html = renderToStaticMarkup(<ChatComponent kind={kind} data={sample(kind)} actions={noActions} />);
      expect(html, kind).not.toContain('Không hiện được dạng thẻ');
    }
    const grid = renderToStaticMarkup(<ChatComponent kind="DeviceGrid" data={sample('DeviceGrid')} actions={noActions} />);
    expect(grid).toContain('Thiết bị · 1/3 rảnh');
    expect(grid).toContain('chưa bật Chế độ nhà phát triển');
    const metrics = renderToStaticMarkup(<ChatComponent kind="MetricChart" data={sample('MetricChart')} actions={noActions} />);
    expect(metrics).toContain('14,3 s');
    const err = renderToStaticMarkup(<ChatComponent kind="ErrorCard" data={sample('ErrorCard')} actions={noActions} />);
    expect(err).toContain('Bạn không có quyền Chạy task');
  });

  it('dữ liệu sai hoặc kind lạ hiện JSON dạng chữ, không bao giờ HTML', () => {
    const bad = renderToStaticMarkup(<ChatComponent kind="DeviceGrid" data={{ html: '<img src=x onerror=alert(1)>' }} actions={noActions} />);
    expect(bad).toContain('Không hiện được dạng thẻ');
    expect(bad).not.toContain('<img src=x');
    expect(bad).toContain('&lt;img src=x');
    const unknown = renderToStaticMarkup(<ChatComponent kind="Nope" data={{}} actions={noActions} />);
    expect(unknown).toContain('chưa có component cho Nope');
  });

  it('xác nhận chi phí: lượt chat chạy tiếp với mã; tool chạy lại với confirm_token', () => {
    const actions = { runTool: vi.fn(), confirmChat: vi.fn() };
    confirmCost({ costVnd: 25000, token: 'tok-chat', scope: 'chat' }, actions);
    expect(actions.confirmChat).toHaveBeenCalledWith('tok-chat');
    confirmCost({ costVnd: 31800, token: 'tok-1', scope: 'tool', tool: 'test_compile', args: { app: 'mexpress' } }, actions);
    expect(actions.runTool).toHaveBeenCalledWith('test_compile', { app: 'mexpress', confirm_token: 'tok-1' });
    const html = renderToStaticMarkup(<ChatComponent kind="CostConfirm" data={sample('CostConfirm')} actions={noActions} />);
    expect(html).toContain('31.800 đ');
    expect(html).toContain('412.000 đ');
    expect(html).toContain('Xác nhận và chạy');
  });

  it('lịch sử: câu người dùng, chữ trả lời, component theo thứ tự; trống thì mời gõ lệnh', () => {
    const html = renderToStaticMarkup(<Transcript items={items.slice(0, 3)} actions={noActions} />);
    const at = ['chạy flow đăng nhập', 'Có 2 máy Android rảnh', 'Thiết bị ·'].map((s) => html.indexOf(s));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(renderToStaticMarkup(<Transcript items={[]} actions={noActions} />)).toContain('Gõ một câu để bắt đầu');
  });
});

describe('báo cáo lượt chạy trong chat', () => {
  const report = { task: { id: 't-1', kind: 'dispatch', status: 'failed', runId: '261118-090000' }, byDevice: null, failuresByClass: {}, reports: ['a/report.html'] };
  it('có openRun: nút Mở thư mục, Mở báo cáo gọi đúng mã lượt; không có link Drive', () => {
    const openRun = vi.fn();
    const html = renderToStaticMarkup(<ChatComponent kind="ReportCard" data={report} actions={{ ...noActions, openRun }} />);
    expect(html).toContain('Mở thư mục');
    expect(html).toContain('Mở báo cáo');
    expect(html).not.toMatch(/drive\.google|Drive/);
  });
  it('không có openRun (PWA, bản cũ): không hiện nút', () => {
    expect(renderToStaticMarkup(<ChatComponent kind="ReportCard" data={report} actions={noActions} />)).not.toContain('Mở báo cáo');
  });
});
