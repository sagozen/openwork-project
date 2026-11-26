import { describe, expect, it } from 'vitest';
import { syncPillText } from './sync-pill';

const DONE = 'Đã đồng bộ Google Drive';

describe('pill đồng bộ thanh tiêu đề', () => {
  it('giữ đúng thứ tự ưu tiên khi có hàng đợi', () => {
    expect(syncPillText({ offline: true, offlineDays: 3, pending: 2 }, DONE)).toBe('Mất kết nối · 3 ngày');
    expect(syncPillText({ offline: true }, DONE)).toBe('Mất kết nối');
    expect(syncPillText({ offline: false, needsLogin: true, failed: 1 }, DONE)).toBe('Cần đăng nhập lại để đồng bộ');
    expect(syncPillText({ offline: false, failed: 1, conflict: 2 }, DONE)).toBe('3 mục cần xử lý');
    expect(syncPillText({ offline: false, syncing: true, pending: 4 }, DONE)).toBe('Chưa đồng bộ: 4');
    expect(syncPillText({ offline: false, pending: 1 }, DONE)).toBe('Chưa đồng bộ: 1');
    expect(syncPillText({ offline: false }, DONE)).toBe(DONE);
  });

  it('sản phẩm không có câu "đã đồng bộ" riêng: không hiện pill lúc rảnh, chỉ hiện khi có chuyện', () => {
    expect(syncPillText({ offline: false }, null)).toBeNull();
    expect(syncPillText({ offline: true }, null)).toBe('Mất kết nối');
    expect(syncPillText({ offline: false, pending: 2 }, null)).toBe('Chưa đồng bộ: 2');
  });
});
