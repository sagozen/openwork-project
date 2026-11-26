// Lỗi ở màn quản trị: mọi màn cần mạng. Mất mạng => E-020 và không lưu gì (NFR-004).
import { errorText } from '../../lib/errors';
import { needNetwork } from './admin-api';

const OFFLINE = new Set(['network', 'need_network']);

/** true khi lỗi do mất mạng / không tới được máy chủ (Go: "network", Worker không phản hồi). */
export const isOfflineError = (e: unknown) => OFFLINE.has(String((e as { code?: string } | null)?.code ?? ''));

/** Đưa lỗi mất mạng về E-020 (need_network); lỗi khác giữ nguyên. */
export function toAdminError(e: unknown): unknown {
  return isOfflineError(e) ? needNetwork() : e;
}

/** Câu báo lỗi tiếng Việt cho màn quản trị (E-020 khi mất mạng, E-010 last_admin, E-023 matrix_conflict...). */
export function adminErrorText(e: unknown, params?: Record<string, string | number>): string {
  return errorText(toAdminError(e), params);
}

/** Chạy một thao tác GHI: không có mạng thì ném E-020 ngay, không gọi máy chủ. */
export async function writeOnline<T>(fn: () => Promise<T>, online: () => boolean = () => typeof navigator === 'undefined' || navigator.onLine !== false): Promise<T> {
  if (!online()) throw needNetwork();
  try {
    return await fn();
  } catch (e) {
    throw toAdminError(e);
  }
}
