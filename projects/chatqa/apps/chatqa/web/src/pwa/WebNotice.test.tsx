import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { WEB_NOTICE, WebNotice } from './WebNotice';

describe('bản web của ChatQASoftware', () => {
  it('chỉ có lời nhắc xem trong app trên máy tính, không đọc Drive/Sheet', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <WebNotice admin={false} />
      </MemoryRouter>,
    );
    expect(html).toContain(WEB_NOTICE);
    expect(WEB_NOTICE).toContain('báo cáo nằm trong thư mục lượt chạy');
    expect(html).not.toMatch(/Drive|Sheet/);
    expect(html).not.toContain('Mở Quản trị');
  });

  it('Admin thấy lối vào Quản trị', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <WebNotice admin />
      </MemoryRouter>,
    );
    expect(html).toContain('Mở Quản trị');
    expect(html).toContain('href="/quan-tri"');
  });
});
