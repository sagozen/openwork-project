import { describe, expect, it } from 'vitest';
import { copyParams, errorText, fillCopy, parseErrorCode, parseErrorParams } from './errors';
import { ApiError } from '../platform/types';
import { goFn } from '../platform/desktop';

describe('lỗi', () => {
  it('tách mã từ lỗi Go "code: chi tiết"', () => {
    expect(parseErrorCode('module_locked: quote')).toBe('module_locked');
    expect(parseErrorCode('license_not_found: http 403')).toBe('license_not_found');
    expect(parseErrorCode('busy')).toBe('busy');
    expect(parseErrorCode('Error: something: broke')).toBe('error');
    expect(parseErrorCode('')).toBe('error');
  });

  it('câu tiếng Việt lấy từ contracts/errors.json', () => {
    expect(errorText(new ApiError('rate_limited', 429), { mm: 15 })).toBe('Bạn đã nhập sai quá nhiều lần. Thử lại sau 15 phút hoặc nhờ admin đặt lại mật khẩu.');
    expect(errorText(new Error('invalid_hs: 8516'))).toContain('8 chữ số');
    expect(errorText(new ApiError('ma_la', 0))).toBe('Lỗi: ma_la');
  });
});

describe('thay chỗ trống trong câu lỗi', () => {
  it('thay {tên} có giá trị, giữ nguyên chỗ chưa có', () => {
    expect(fillCopy('Tên đăng nhập {tên} đã được dùng. Chọn tên khác.', { tên: 'lan' })).toBe('Tên đăng nhập lan đã được dùng. Chọn tên khác.');
    expect(fillCopy('Máy đã {n} ngày chưa kết nối.', {})).toBe('Máy đã {n} ngày chưa kết nối.');
    expect(fillCopy('Không có chỗ trống')).toBe('Không có chỗ trống');
  });
});

describe('tham số trong lỗi Go', () => {
  it('tách "k=v" sau mã lỗi, số thành số', () => {
    expect(parseErrorParams('rate_limited: minutes=12')).toEqual({ minutes: 12 });
    expect(parseErrorParams('account_locked: lockedAt=1700000000,by=Hoa')).toEqual({ lockedAt: 1700000000, by: 'Hoa' });
    expect(parseErrorParams('module_locked: quote')).toEqual({});
    expect(parseErrorParams('busy')).toEqual({});
  });

  it('E-002 điền số phút từ lỗi Go hoặc từ lỗi Worker', () => {
    const msg = 'Bạn đã nhập sai quá nhiều lần. Thử lại sau 12 phút hoặc nhờ admin đặt lại mật khẩu.';
    expect(errorText(new Error('rate_limited: mm=12'))).toBe(msg);
    expect(errorText(new ApiError('rate_limited', 429, { mm: 12 }))).toBe(msg);
  });

  it('E-011 dùng tên thao tác lấy từ bảng quyền', () => {
    expect(errorText(new Error('permission_denied: approve.review'))).toBe('Bạn không có quyền Duyệt, Yêu cầu sửa hàng rủi ro Cao, Trung bình; chọn bản khi xung đột trạng thái (quyền duyệt). Liên hệ admin.');
    expect(errorText(new ApiError('permission_denied', 403, { perm: 'report.view' }))).toBe('Bạn không có quyền Xem báo cáo. Liên hệ admin.');
  });
});

describe('chỗ trống trong câu lỗi theo spec', () => {
  it('đổi tên tham số của Worker sang chỗ trống trong câu, giờ theo giờ Việt Nam', () => {
    const t = Date.UTC(2026, 10, 11, 9, 5) / 1000; // 16:05 giờ VN
    expect(copyParams({ minutes: 9 }).mm).toBe(9);
    expect(copyParams({ maxDevices: 6 }).n).toBe(6);
    expect(copyParams({ lockedAt: t })['dd/mm hh:mm']).toBe('11/11 16:05');
    expect(copyParams({ at: t, by: 'Chị Hoa' })).toMatchObject({ 'hh:mm': '16:05', người: 'Chị Hoa' });
  });

  it('các câu lỗi tài khoản điền đủ giá trị', () => {
    const t = Date.UTC(2026, 10, 11, 9, 5) / 1000;
    expect(errorText(new ApiError('rate_limited', 429, { minutes: 9 }))).toContain('sau 9 phút');
    expect(errorText(new ApiError('locked_in_use', 401, { lockedAt: t }))).toBe('Tài khoản của bạn đã bị khoá lúc 11/11 16:05. Liên hệ admin.');
    expect(errorText(new ApiError('matrix_conflict', 409, { by: 'Chị Hoa', at: t }))).toBe('Bảng quyền vừa được Chị Hoa sửa lúc 16:05. Tải lại rồi chỉnh tiếp.');
    expect(errorText(new ApiError('device_limit_reached', 409, { maxDevices: 6 }))).toBe('Công ty đã dùng đủ 6 máy. Nhờ admin thu hồi máy không dùng, hoặc liên hệ bên triển khai.');
    expect(errorText(new ApiError('username_taken', 409, { username: 'lan' }))).toBe('Tên đăng nhập lan đã được dùng. Chọn tên khác.');
    expect(errorText(new Error('offline_expired: 8'), { n: 8 })).toBe('Máy đã 8 ngày chưa kết nối. Kết nối mạng để tiếp tục làm việc. Dữ liệu trên máy vẫn được giữ.');
  });
});

describe('binding Wails', () => {
  const root = { main: { App: { Login: async () => 'ok' } }, quote: { Service: { SaveCard: async () => 'saved' } } };
  it('tìm hàm lõi và hàm phân hệ', async () => {
    expect(await goFn('Login', root)()).toBe('ok');
    expect(await goFn('quote.Service.SaveCard', root)()).toBe('saved');
  });
  it('UI mới gọi hàm exe chưa có => incompatible (không crash)', () => {
    expect(() => goFn('lot.Service.Merge', root)).toThrow(ApiError);
  });
});
