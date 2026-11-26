/** Mở liên kết ngoài: trên app máy tính qua trình duyệt của máy (runtime Wails, cửa sổ app không mở tab mới), trên web thì tab mới. */
export function openExternal(url: string): void {
  const rt = (globalThis as { runtime?: { BrowserOpenURL?: (u: string) => void } }).runtime;
  if (rt?.BrowserOpenURL) rt.BrowserOpenURL(url);
  else globalThis.open?.(url, '_blank', 'noopener,noreferrer');
}
