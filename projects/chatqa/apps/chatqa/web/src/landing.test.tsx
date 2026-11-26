import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { LandingPage } from '@shell/pages/public/LandingPage';

describe('trang chủ ChatQASoftware', () => {
  const out = renderToStaticMarkup(
    <MemoryRouter>
      <LandingPage />
    </MemoryRouter>,
  );

  it('có khu tải và phiên bản ở đầu trang', () => {
    expect(out).toContain('Đang kiểm tra bản Windows');
    expect(out).toContain('macOS');
  });

  it('giới thiệu MCP và đội agent ADK', () => {
    expect(out).toContain('Claude Desktop');
    expect(out).toContain('Codex');
    expect(out).toContain('Đội agent');
    expect(out).toContain('Google ADK');
    expect(out).toContain('49 tool');
    expect(out).toContain('127.0.0.1');
  });

  it('bảng giá: MCP và tự host miễn phí, agent cloud theo lượng dùng, có link GitHub', () => {
    expect(out).toContain('id="bang-gia"');
    expect(out).toContain('License gửi qua email, gia hạn mỗi năm');
    expect(out).toContain('Tự host');
    expect(out).toContain('Theo lượng dùng');
    expect(out).toContain('$5');
    expect(out).toContain('href="https://github.com/sagozen/openwork-project"');
  });

  it('đầu trang có video giới thiệu tự phát khi tắt tiếng, luôn có thanh điều khiển', () => {
    expect(out).toContain('src="/intro/chatqa-intro.mp4"');
    expect(out).toContain('poster="/intro/chatqa-intro-poster.jpg"');
    expect(out).toMatch(/<video[^>]*muted/);
    expect(out).toMatch(/<video[^>]*controls/);
    expect(out).not.toContain('Xem có lồng tiếng');
    expect(out).toMatch(/<track[^>]*kind="subtitles"[^>]*src="\/intro\/chatqa-intro.vi.vtt"[^>]*srcLang="vi"[^>]*default/);
  });

  it('kho mã nguồn chỉ hiện bằng icon GitHub ở thanh trên, không lặp nút ở đầu trang', () => {
    const header = out.slice(0, out.indexOf('</header>'));
    expect(header).toMatch(/<a[^>]*href="https:\/\/github.com\/sagozen\/openwork-project"[^>]*aria-label="Mã nguồn trên GitHub"/);
    expect(out).not.toContain('>Mã nguồn trên GitHub<');
  });

  it('có khối skill cho AI agent ngay dưới đầu trang: prompt chép được, lệnh cài, tải zip', () => {
    expect(out).toContain('id="skill"');
    expect(out).toContain('href="#skill"');
    expect(out.indexOf('id="skill"')).toBeLessThan(out.indexOf('Tính năng'));
    expect(out).toContain('Prompt cho agent');
    expect(out).toContain('/skills/chatqa.zip');
    expect(out).toContain('href="/skills/chatqa/SKILL.md"');
    expect(out).toContain('Kết nối AI (MCP)');
    expect(out).toContain('Không yêu cầu tôi dán token vào chat');
  });

  it('có khoá học miễn phí: link "Học" ở đầu trang trước Chính sách, khối giới thiệu và chân trang, đều mở tab mới', () => {
    const url = 'https://mytutorlms.zhst.app/courses/chatqa-co-ban';
    const links = out.match(new RegExp(`<a[^>]*href="${url}"[^>]*>`, 'g')) ?? [];
    // Thanh trên, nút trong khối, chân trang (không lặp nút ở đầu trang).
    expect(links).toHaveLength(3);
    for (const a of links) {
      expect(a).toContain('target="_blank"');
      expect(a).toContain('rel="noopener noreferrer"');
    }
    const header = out.slice(0, out.indexOf('</header>'));
    expect(header).toContain(`href="${url}"`);
    expect(header).toMatch(/<svg[^>]*>.*?<\/svg>Học<\/a>/);
    expect(header.indexOf(`href="${url}"`)).toBeLessThan(header.indexOf('href="/policy"'));
    // Link ở thanh trên hiện cả trên điện thoại (không bị ẩn dưới sm như link pháp lý).
    expect(links[0]).not.toContain('hidden');
    const footer = out.slice(out.indexOf('<footer'));
    expect(footer).toContain(`href="${url}"`);
    expect(footer).toMatch(/>Học<\/a>/);
    expect(out).toContain('id="hoc"');
    expect(out).toContain('ChatQA Software cơ bản');
    expect(out).toContain('19 bài ngắn có video');
    expect(out).toContain('Nối Claude Desktop, Claude Code, Codex qua MCP');
    expect(out).toContain('Vào học miễn phí');
    expect(out).not.toContain('Xem khoá học');
    // Khối khoá học ngay dưới đầu trang, trước bảng giá.
    expect(out.indexOf('id="hoc"')).toBeLessThan(out.indexOf('id="bang-gia"'));
  });

  it('không dùng dấu gạch dài trong nội dung', () => {
    expect(out).not.toContain('—');
  });

  it('không nhắc Google Drive (dữ liệu trên máy, đồng bộ qua S3)', () => {
    expect(out).not.toContain('Drive');
    expect(out).toContain('S3');
  });

  it('có form nhận license 1 năm miễn phí gửi qua email', () => {
    expect(out).toContain('id="dung-thu"');
    expect(out).toContain('name="email"');
    expect(out).toContain('type="email"');
    expect(out).toContain('Nhận license 1 năm miễn phí');
    expect(out).not.toContain('type="password"');
  });
});
