import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router';
import { LandingPage } from './LandingPage';
import { PolicyPage } from './PolicyPage';
import { TermsPage } from './TermsPage';
import { CONTACT_EMAIL, OPERATOR, PRIVACY, TERMS } from './legal-copy';
import { isPublicPath, LANDING_PATH, LOGIN_PATH, POLICY_PATH, TERM_PATH } from './paths';

const html = (el: ReactElement) => renderToStaticMarkup(<MemoryRouter>{el}</MemoryRouter>);

describe('trang công khai (Google OAuth)', () => {
  it('đường dẫn công khai đúng và không lẫn đường app', () => {
    expect([LANDING_PATH, LOGIN_PATH, POLICY_PATH, TERM_PATH]).toEqual(['/', '/dang-nhap', '/policy', '/term']);
    for (const p of ['/', '/dang-nhap', '/policy', '/term', '/policy/']) expect(isPublicPath(p)).toBe(true);
    for (const p of ['/quan-tri', '/bao-cao', '/policy/x']) expect(isPublicPath(p)).toBe(false);
  });

  it('trang chủ giới thiệu sản phẩm, có nút đăng nhập và link pháp lý', () => {
    const out = html(<LandingPage />);
    expect(out).toContain('Đăng nhập');
    expect(out).toContain('href="/policy"');
    expect(out).toContain('href="/term"');
    expect(out).toContain(OPERATOR);
    expect(out).toContain(CONTACT_EMAIL);
    // Không phải form đăng nhập: trang chủ chỉ có liên kết.
    expect(out).not.toContain('type="password"');
    // HS Desk chưa có video giới thiệu: đầu trang giữ thẻ minh hoạ.
    expect(out).not.toContain('<video');
  });

  it('đầu trang có khu tải app Windows và macOS, không còn câu về hạ tầng dùng chung', () => {
    const out = html(<LandingPage />);
    expect(out).toContain('Đang kiểm tra bản Windows');
    expect(out).toContain('macOS');
    expect(out.indexOf('macOS')).toBeLessThan(out.indexOf('Tính năng'));
    expect(out).not.toContain('dùng chung hạ tầng');
  });

  it('HS Desk chưa có khoá học: không có link "Học", nút xem khoá học hay khối khoá học', () => {
    for (const out of [html(<LandingPage />), html(<PolicyPage />), html(<TermsPage />)]) {
      expect(out).not.toContain('mytutorlms');
      expect(out).not.toContain('>Học</a>');
      expect(out).not.toContain('id="hoc"');
      expect(out).not.toContain('Xem khoá học');
      expect(out).not.toContain('github.com');
    }
  });

  it('chính sách có đủ nội dung và cam kết Limited Use của Google', () => {
    const out = html(<PolicyPage />);
    expect(PRIVACY.length).toBeGreaterThanOrEqual(10);
    expect(out).toContain('Dữ liệu chúng tôi thu thập');
    expect(out).toContain('Mục đích sử dụng dữ liệu');
    expect(out).toContain('Chia sẻ dữ liệu với bên thứ ba');
    expect(out).toContain('Quyền của bạn');
    expect(out).toContain('https://www.googleapis.com/auth/drive.file');
    expect(out).toContain('https://www.googleapis.com/auth/spreadsheets');
    expect(out).toContain('Google API Services User Data Policy');
    expect(out).toContain('Limited Use');
    // ChatQASoftware không dùng Google; có nêu S3 và form dùng thử.
    expect(out).toContain('ChatQASoftware không yêu cầu quyền truy cập dữ liệu Google');
    expect(out).toContain('S3-compatible');
    expect(out).toContain('Đăng ký dùng thử');
    expect(out).toContain('AES-256');
    expect(out).toContain(CONTACT_EMAIL);
    expect(out).not.toContain('type="password"');
  });

  it('điều khoản có các mục chính và ngày hiệu lực', () => {
    const out = html(<TermsPage />);
    expect(TERMS.length).toBeGreaterThanOrEqual(10);
    expect(out).toContain('Điều khoản sử dụng');
    expect(out).toContain('Tính năng trí tuệ nhân tạo');
    expect(out).toContain('Giới hạn trách nhiệm');
    expect(out).toContain('Luật áp dụng');
    expect(out).toContain('Cập nhật lần cuối');
  });
});
