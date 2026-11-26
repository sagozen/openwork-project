// Rời trang khi còn thay đổi chưa lưu: tìm đích điều hướng từ liên kết được bấm (BrowserRouter: "/cai-dat/may", HashRouter: "#/cai-dat/may").

/** Đường dẫn trong app mà liên kết <a> trỏ tới; null nếu là liên kết ngoài / mở tab mới / không phải điều hướng trong app. */
export function routeOfHref(href: string, origin: string, target?: string | null): string | null {
  if (target && target !== '_self') return null;
  let u: URL;
  try {
    u = new URL(href, origin + '/');
  } catch {
    return null;
  }
  if (u.origin !== origin) return null;
  if (u.hash.startsWith('#/')) return u.hash.slice(1);
  return u.pathname + u.search;
}

/** Bấm có phím bổ trợ (mở tab mới) hoặc không phải chuột trái thì không chặn. */
export const isPlainClick = (e: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
