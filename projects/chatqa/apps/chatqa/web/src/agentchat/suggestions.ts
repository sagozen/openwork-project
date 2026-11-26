// Gợi ý câu nhắn cho đội agent: thẻ khởi đầu khi phiên trống và nút trả lời nhanh sau mỗi lượt, đoán theo câu trả lời
// cuối (có flow lỗi, tất cả đạt, lỗi máy chủ). Bấm là gửi luôn, như bàn phím nút bấm dưới tin nhắn của bot Telegram.
import { parseRunLines, type Msg } from './state';

export interface Starter {
  title: string;
  text: string;
}

export const STARTERS: Starter[] = [
  { title: 'Chạy flow', text: 'Chạy flow đăng nhập trên Android' },
  { title: 'Xem flow đang có', text: 'Liệt kê các flow kiểm thử đang có theo từng app' },
  { title: 'Kiểm tra máy', text: 'Những máy nào đang cắm và rảnh? Chụp màn hình từng máy' },
  { title: 'Báo cáo', text: 'Tóm tắt lượt chạy gần nhất: flow nào lỗi, vì sao' },
];

/** Nút trả lời nhanh sau lượt vừa xong; rỗng khi đang chạy hoặc còn hộp duyệt mở. Thuần. */
export function followUps(msgs: Msg[], busy: boolean): string[] {
  if (busy || msgs.length === 0) return [];
  if (msgs.some((m) => (m.type === 'confirm' || m.type === 'request') && m.status === 'open')) return [];
  const last = msgs[msgs.length - 1];
  if (last.type === 'error') return ['Thử lại', 'Giải thích lỗi này'];
  const reply = [...msgs].reverse().find((m) => m.type === 'text');
  if (!reply || reply.type !== 'text' || last.type === 'user') return [];
  const tones = parseRunLines(reply.text).map((l) => l.tone);
  if (tones.includes('fail')) return ['Phân loại các lỗi vừa gặp', 'Đề xuất sửa flow lỗi', 'Chạy lại các flow lỗi'];
  if (tones.includes('pass')) return ['Viết báo cáo lượt chạy', 'Chạy cùng flow trên iOS', 'Chạy toàn bộ flow của app này'];
  return ['Tóm tắt ngắn gọn', 'Bước tiếp theo nên làm gì?'];
}
