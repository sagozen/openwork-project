import { describe, expect, it } from 'vitest';
import { appLabel, appsText, describeUa, fmtAgo, fmtDayTime, fmtShort, initials, maskIp, stripMarks } from './format';

const t = (s: string) => Math.floor(new Date(`${s.replace(' ', 'T')}:00+07:00`).getTime() / 1000);
const NOW = t('2026-11-11 10:42');

describe('ngày giờ theo giờ Việt Nam', () => {
  it('hôm nay, hôm qua, ngày khác (cột Đăng nhập cuối của D7XS6)', () => {
    expect(fmtDayTime(t('2026-11-11 10:42'), NOW)).toBe('10:42 hôm nay');
    expect(fmtDayTime(t('2026-11-10 16:20'), NOW)).toBe('Hôm qua 16:20');
    expect(fmtDayTime(t('2026-11-07 14:30'), NOW)).toBe('07/11 14:30');
  });

  it('gần nửa đêm vẫn tính theo lịch Việt Nam, không theo múi giờ máy', () => {
    expect(fmtDayTime(t('2026-11-11 00:05'), t('2026-11-11 23:50'))).toBe('00:05 hôm nay');
    expect(fmtDayTime(t('2026-11-10 23:59'), t('2026-11-11 00:01'))).toBe('Hôm qua 23:59');
  });

  it('"cách đây" làm tròn như khung NX9V3', () => {
    expect(fmtAgo(NOW, NOW)).toBe('vừa xong');
    expect(fmtAgo(t('2026-11-11 10:37'), NOW)).toBe('5 phút trước');
    expect(fmtAgo(t('2026-11-11 09:15'), NOW)).toBe('1 giờ trước');
    expect(fmtAgo(t('2026-11-11 08:51'), NOW)).toBe('2 giờ trước');
    expect(fmtAgo(t('2026-11-10 16:20'), NOW)).toBe('18 giờ trước');
    expect(fmtAgo(t('2026-11-05 09:40'), NOW)).toBe('6 ngày trước');
    expect(fmtAgo(t('2026-11-01 17:40'), NOW)).toBe('10 ngày trước');
    expect(fmtAgo(t('2026-10-20 11:05'), NOW)).toBe('22 ngày trước');
  });

  it('giờ máy lệch về tương lai thì không ra số âm', () => {
    expect(fmtAgo(NOW + 3600, NOW)).toBe('vừa xong');
  });

  it('dd/mm hh:mm', () => {
    expect(fmtShort(t('2026-11-03 15:22'))).toBe('03/11 15:22');
  });
});

describe('app, người, thiết bị', () => {
  it('nhãn app từ contracts/apps.json', () => {
    expect(appLabel('quote')).toBe('App 01 · Báo giá');
    expect(appLabel('check')).toBe('App 03 · Kiểm tra & khai báo');
    expect(appsText(['teach', 'quote', 'lot', 'check'])).toBe('App 01, 02, 03, 04');
    expect(appsText([])).toBe('Không có app');
  });

  it('chữ viết tắt hai từ cuối và bỏ dấu', () => {
    expect(initials('Hoàng Anh Tùng')).toBe('AT');
    expect(initials('Nguyễn Quốc Bảo')).toBe('QB');
    expect(initials('Đỗ Thu Hà')).toBe('TH');
    expect(initials('Lan')).toBe('LA');
    expect(stripMarks('Đỗ Thu Hà')).toBe('Do Thu Ha');
  });

  it('đọc User-Agent của phiên web', () => {
    expect(describeUa('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36')).toEqual({ name: 'Chrome · Windows', kind: 'desktop' });
    expect(describeUa('Mozilla/5.0 (Windows NT 10.0) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0').name).toBe('Edge · Windows');
    expect(describeUa('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile/15E148 Safari/604.1')).toEqual({ name: 'Safari · iPhone', kind: 'phone' });
    expect(describeUa(null).name).toBe('Trình duyệt');
  });

  it('che 2 đoạn cuối của IP', () => {
    expect(maskIp('113.161.20.7')).toBe('113.161.x.x');
    expect(maskIp(null)).toBe('');
    expect(maskIp('2001:db8:85a3::1')).toBe('2001:db8:…');
  });
});
