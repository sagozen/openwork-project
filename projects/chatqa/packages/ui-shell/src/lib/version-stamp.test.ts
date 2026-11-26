import { describe, expect, it } from 'vitest';
import { formatStamp, versionStamp } from './version-stamp';

const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

describe('mốc cập nhật phiên bản', () => {
  it('lần đầu thấy một phiên bản thì ghi mốc hiện tại, các lần sau giữ nguyên mốc đó', () => {
    const s = memory();
    expect(versionStamp('0.3.1|1.0.0', 1000, s)).toBe(1000);
    expect(versionStamp('0.3.1|1.0.0', 9000, s)).toBe(1000);
  });

  it('đổi phiên bản (exe hoặc giao diện OTA) thì mốc mới được ghi lại', () => {
    const s = memory();
    versionStamp('0.3.1|1.0.0', 1000, s);
    expect(versionStamp('0.3.2|1.0.0', 5000, s)).toBe(5000);
    expect(versionStamp('0.3.2|1.0.1', 7000, s)).toBe(7000);
    expect(versionStamp('0.3.2|1.0.1', 8000, s)).toBe(7000);
  });

  it('không có hoặc hỏng bộ nhớ thì dùng mốc hiện tại, không ném lỗi', () => {
    expect(versionStamp('1', 42, null)).toBe(42);
    expect(versionStamp('1', 43, { getItem: () => '{hỏng', setItem: () => undefined })).toBe(43);
    expect(
      versionStamp('1', 44, {
        getItem: () => null,
        setItem: () => {
          throw new Error('đầy bộ nhớ');
        },
      }),
    ).toBe(44);
  });

  it('định dạng ngày giờ dd/mm/yyyy hh:mm theo giờ máy', () => {
    expect(formatStamp(new Date(2026, 10, 23, 9, 5).getTime())).toBe('23/11/2026 09:05');
  });
});
