/**
 * Cửa sổ Wails hiện đang vẽ khung hệ điều hành (desktop/main.go không bật Frameless): thanh tiêu đề của pen chỉ vẽ nút
 * thu nhỏ / phóng to / đóng khi KHÔNG có khung gốc (khung so ảnh, trình duyệt), để khỏi hiện hai bộ nút. Bật Frameless
 * trong Go thì bỏ điều kiện này và nối ba nút vào runtime.WindowMinimise / WindowToggleMaximise / Quit.
 */
export function hasNativeFrame(): boolean {
  return typeof (window as unknown as { runtime?: { WindowMinimise?: unknown } }).runtime?.WindowMinimise === 'function';
}
