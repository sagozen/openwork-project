// Thời điểm bản đang chạy được cập nhật: app desktop không biết giờ cài, nên ghi lại lần đầu thấy từng tổ hợp phiên bản
// (exe + giao diện OTA) vào localStorage. Bản web (PWA) dùng giờ đóng gói được nhúng sẵn, chính xác hơn.
import { PRODUCT } from '@product/product';

const KEY = `${PRODUCT.code}.version-stamp`;

interface Stamp {
  v: string;
  at: number;
}

type Store = Pick<Storage, 'getItem' | 'setItem'>;

function safeStorage(): Store | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

/** Trả về mốc thời gian (ms) lần đầu thấy `version`; chưa từng thấy thì ghi mốc hiện tại. Không có localStorage thì trả mốc hiện tại. */
export function versionStamp(version: string, now = Date.now(), storage: Store | null = safeStorage()): number {
  try {
    const cur = JSON.parse(storage?.getItem(KEY) ?? 'null') as Stamp | null;
    if (cur && cur.v === version && Number.isFinite(cur.at)) return cur.at;
    storage?.setItem(KEY, JSON.stringify({ v: version, at: now } satisfies Stamp));
  } catch {
    /* private mode / dữ liệu hỏng: dùng mốc hiện tại */
  }
  return now;
}

/** 23/11/2026 09:19 */
export function formatStamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
