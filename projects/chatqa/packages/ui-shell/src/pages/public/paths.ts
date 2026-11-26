// Đường dẫn của các trang công khai. Dùng chung giữa bộ định tuyến và các trang để không lệch nhau.
export const LANDING_PATH = '/';
export const LOGIN_PATH = '/dang-nhap';
export const POLICY_PATH = '/policy';
export const TERM_PATH = '/term';

/** Trang mở được mà không cần phiên đăng nhập (Google kiểm duyệt OAuth sẽ mở trực tiếp các đường này). */
export const PUBLIC_PATHS: readonly string[] = [LANDING_PATH, LOGIN_PATH, POLICY_PATH, TERM_PATH];

export const isPublicPath = (pathname: string): boolean => {
  // Cho phép dấu "/" cuối (Google/Cloudflare có thể thêm) mà vẫn nhận ra trang công khai.
  const p = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  return PUBLIC_PATHS.includes(p);
};
