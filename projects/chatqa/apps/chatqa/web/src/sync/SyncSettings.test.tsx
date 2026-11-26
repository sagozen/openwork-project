import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SHOT_NOTE } from '../testing/RunDetail';
import { EMPTY_SYNC_CONFIG, NO_CONDITIONAL_NOTE, type SyncConfig } from './sync-api';
import { EVIDENCE_AUTO_NOTE, ProbeResult, SyncSettingsView, validEndpoint, validKey, validRegion } from './SyncSettings';

const saved: SyncConfig = {
  endpoint: 'minio.congty.vn:9000',
  bucket: 'chatqa',
  region: 'us-east-1',
  pathStyle: true,
  useTLS: true,
  evidenceAuto: false,
  prefix: 'tenants/t-01/chatqa',
  credentialsSet: true,
  configured: true,
};

describe('Cài đặt › Kiểm thử › Đồng bộ nhóm', () => {
  it('kiểm như Go: endpoint không scheme, region, khoá không khoảng trắng', () => {
    expect(validEndpoint('minio.congty.vn:9000')).toBe(true);
    expect(validEndpoint('')).toBe(true);
    for (const bad of ['https://minio.vn', 'minio.vn/bucket', 'minio vn']) expect(validEndpoint(bad)).toBe(false);
    expect(validRegion('us-east-1')).toBe(true);
    expect(validRegion('US East')).toBe(false);
    expect(validKey('AKIA123')).toBe(true);
    for (const bad of ['', 'a b', 'x'.repeat(257), 'a\tb']) expect(validKey(bad)).toBe(false);
  });

  it('đã lưu khoá: chỉ hiện "Đã lưu" và "Xoá khoá", không có ô khoá nào; prefix chỉ đọc hiện nguyên', () => {
    const html = renderToStaticMarkup(<SyncSettingsView cfg={saved} canEdit onSave={() => undefined} onSaveKeys={() => undefined} onClearKeys={() => undefined} onProbe={() => undefined} />);
    expect(html).toContain('Đồng bộ nhóm (S3/MinIO)');
    expect(html).toContain('value="minio.congty.vn:9000"');
    expect(html).toContain('value="chatqa"');
    expect(html).toContain('data-testid="sync-keys-saved"');
    expect(html).toContain('Đã lưu');
    expect(html).toContain('Xoá khoá');
    expect(html).not.toContain('Access key');
    expect(html).not.toContain('Secret key');
    expect(html).not.toContain('type="password"');
    expect(html).toContain('<span class="font-mono" data-testid="sync-prefix">tenants/t-01/chatqa</span>');
    expect(html).toContain('Thử kết nối');
  });

  it('chưa có khoá: ô khoá kiểu mật khẩu, trống; chưa đăng nhập thì gợi ý prefix', () => {
    const html = renderToStaticMarkup(<SyncSettingsView cfg={{ ...EMPTY_SYNC_CONFIG }} canEdit />);
    expect(html).toContain('Access key');
    expect(html).toContain('Secret key');
    expect(html.match(/type="password"/g)).toHaveLength(2);
    expect(html).toContain('autoComplete="off"');
    expect(html).not.toContain('data-testid="sync-prefix"');
    expect(html).toContain('có khi đăng nhập tài khoản công ty');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>(?:<svg[\s\S]*?<\/svg>)?Thử kết nối/);
  });

  it('không có quyền credentials: chỉ xem, không có nút ghi', () => {
    const html = renderToStaticMarkup(<SyncSettingsView cfg={saved} canEdit={false} />);
    expect(html).not.toContain('Xoá khoá');
    expect(html).not.toContain('Thử kết nối');
    expect(html).not.toMatch(/>Lưu</);
    expect(html).toContain('readOnly');
    expect(html).toContain('Cần quyền quản lý credentials');
  });

  it('tự chia sẻ evidence kèm cảnh báo ảnh/video tới cả nhóm', () => {
    const html = renderToStaticMarkup(<SyncSettingsView cfg={saved} canEdit />);
    expect(html).toContain('Tự chia sẻ evidence mọi lượt');
    expect(html).toContain('role="switch"');
    expect(EVIDENCE_AUTO_NOTE).toContain('mọi người trong nhóm xem được');
    expect(EVIDENCE_AUTO_NOTE).toContain('không che được');
    expect(SHOT_NOTE).toContain('không che được');
  });

  it('thử kết nối: kho không ghi có điều kiện thì cảnh báo ghi đè; lỗi hiện câu của Go', () => {
    const warn = renderToStaticMarkup(<ProbeResult probe={{ ok: true, conditional: false }} />);
    expect(warn).toContain('data-testid="probe-warn"');
    expect(warn).toContain(NO_CONDITIONAL_NOTE);
    expect(NO_CONDITIONAL_NOTE).toContain('ghi đè bản của nhau');
    expect(renderToStaticMarkup(<ProbeResult probe={{ ok: true, conditional: true }} />)).not.toContain('probe-warn');
    expect(renderToStaticMarkup(<ProbeResult probe={{ ok: false, conditional: false, error: 'kho S3 trả 403 AccessDenied' }} />)).toContain('Không kết nối được: kho S3 trả 403 AccessDenied');
    expect(renderToStaticMarkup(<SyncSettingsView cfg={saved} canEdit probe={{ ok: true, conditional: false }} />)).toContain(NO_CONDITIONAL_NOTE);
  });
});
