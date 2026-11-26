import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { CentreEmpty, searchShortcut, Workspace } from './Workspace';

const panes = ['Thiết bị', 'Khung chính', 'Hoạt động', 'Số đo'];

describe('màn 4 ô ChatQASoftware', () => {
  it('có đủ 4 ô theo thứ tự và thanh trạng thái', () => {
    const html = renderToStaticMarkup(<Workspace devices={0} />);
    const at = panes.map((p) => html.indexOf(`aria-label="${p}"`));
    expect(at.every((i) => i >= 0), at.join()).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(html).toContain('aria-label="Trạng thái"');
  });

  it('trạng thái trống: ô tìm máy, mời gõ lệnh, 0 máy, ngân sách chưa nối', () => {
    const html = renderToStaticMarkup(<Workspace devices={0} />);
    expect(html).toContain('aria-label="Tìm máy"');
    expect(html).toContain('Chưa có máy nào kết nối');
    expect(html).toContain('Gõ một câu để bắt đầu');
    expect(html).toContain('aria-label="Lệnh cho ChatQASoftware"');
    expect(html).toMatch(/<b[^>]*>0<\/b> máy đang kết nối/);
    expect(html).toMatch(/Ngân sách LLM còn: <b[^>]*>—<\/b>/);
  });

  it('khung giữa hiện route con khi có', () => {
    const html = renderToStaticMarkup(<Workspace devices={2} budgetLeft="420.000 ₫" centre={<p>trang con</p>} />);
    expect(html).toContain('<p>trang con</p>');
    expect(html).not.toContain('Gõ một câu để bắt đầu');
    expect(html).toMatch(/<b[^>]*>2<\/b> máy đang kết nối/);
    expect(html).toContain('420.000 ₫');
  });

  it('bản web chỉ xem: không có thanh lệnh', () => {
    const html = renderToStaticMarkup(<Workspace devices={0} readOnly />);
    expect(html).not.toContain('Lệnh cho ChatQASoftware');
    expect(html).toContain('Chưa có lượt chạy nào');
  });

  it('màn trống có câu mẫu bấm được khi chat truyền onExample; bản chỉ xem thì không', () => {
    const chat = renderToStaticMarkup(<CentreEmpty onExample={() => undefined} />);
    expect(chat).toContain('Chạy flow đăng nhập trên 3 máy, báo p95');
    expect(chat).toContain('Dừng tất cả');
    expect(chat).toContain('<button');
    const readOnly = renderToStaticMarkup(<CentreEmpty readOnly />);
    expect(readOnly).not.toContain('Chạy flow đăng nhập trên 3 máy, báo p95');
    expect(readOnly).toContain('Chưa có lượt chạy nào');
  });

  it('tổng số máy ở tiêu đề tách khỏi số máy đang kết nối ở chân màn', () => {
    const html = renderToStaticMarkup(<Workspace devices={3} deviceTotal={5} />);
    expect(html).toMatch(/Thiết bị<\/h2><span[^>]*>5<\/span>/);
    expect(html).toMatch(/<b[^>]*>3<\/b> máy đang kết nối/);
  });

  it('phím tắt theo hệ điều hành', () => {
    expect(searchShortcut('MacIntel')).toBe('⌘K');
    expect(searchShortcut('iPhone')).toBe('⌘K');
    expect(searchShortcut('Win32')).toBe('Ctrl K');
  });
});
