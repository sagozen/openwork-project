/**
 * Cấu hình domain của Clerk: quyết định Clerk có được bật trên hostname hiện tại
 * hay không, và nếu có thì chạy ở chế độ primary hay satellite.
 *
 * Khoá `pk_live_...` chỉ hoạt động trên origin đã đăng ký ở Clerk Dashboard, nên
 * danh sách host tại đây PHẢI khớp với cấu hình bên Dashboard (primary domain +
 * satellite domains). Host không nằm trong danh sách sẽ rơi về chế độ demo.
 *
 * Biến môi trường (đều tuỳ chọn, ghi đè hằng số mặc định bên dưới):
 *  - VITE_CLERK_PUBLISHABLE_KEY  khoá publishable của instance đang dùng.
 *  - NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY  tên tương thích cho deployment đã cấu hình theo Next.js.
 *  - VITE_CLERK_ALLOWED_HOSTS    danh sách host bật Clerk, phân tách bằng dấu phẩy.
 *  - VITE_CLERK_SATELLITE_HOSTS  host nào chạy ở chế độ satellite domain.
 *  - VITE_CLERK_PRIMARY_ORIGIN   origin của primary domain (bắt buộc khi có satellite),
 *                                ví dụ `https://auth-dlp.pandev00.com`.
 */

// Publishable key của Clerk (an toàn để lưu trong mã nguồn).
export const CLERK_KEY =
  (import.meta.env["VITE_CLERK_PUBLISHABLE_KEY"] as string | undefined) ||
  (import.meta.env["NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"] as string | undefined) ||
  "pk_live_Y2xlcmsuYXV0aC1kbHAucGFuZGV2MDAuY29tJA";

/**
 * Host được phép bật Clerk ngoài host suy ra từ publishable key. Thêm domain mới
 * vào đây sau khi đã khai báo domain đó ở Clerk Dashboard.
 */
const DEFAULT_ALLOWED_HOSTS = ["lims.dalienphat.com"];

/**
 * Host chạy ở chế độ satellite: Clerk không dựng form đăng nhập tại chỗ mà đẩy
 * người dùng sang primary domain rồi đồng bộ phiên ngược lại. Chỉ điền khi đã
 * khai báo host đó là satellite domain ở Clerk Dashboard, kèm PRIMARY_ORIGIN.
 */
const DEFAULT_SATELLITE_HOSTS: string[] = [];

/** Origin của primary domain, dùng để dựng URL đăng nhập/đăng ký cho satellite. */
const DEFAULT_PRIMARY_ORIGIN = "";

export const SIGN_IN_PATH = "/dang-nhap";
export const SIGN_UP_PATH = "/dang-ky";

export interface ClerkDomainConfig {
  /** Host này chạy ở chế độ satellite domain của Clerk. */
  isSatellite: boolean;
  /** Giá trị `domain` truyền cho ClerkProvider (chỉ có ở satellite). */
  domain?: string;
  /** URL đăng nhập: tương đối ở primary, tuyệt đối (trỏ về primary) ở satellite. */
  signInUrl: string;
  /** URL đăng ký, cùng quy tắc với `signInUrl`. */
  signUpUrl: string;
}

function envList(key: string): string[] | null {
  const raw = import.meta.env[key] as string | undefined;
  if (!raw) return null;
  const hosts = parseHosts(raw);
  return hosts.length ? hosts : null;
}

function parseHosts(raw: string): string[] {
  return raw
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
}

/** Host của primary domain, giải mã từ publishable key (`pk_live_<base64>`). */
function hostFromKey(key: string): string | null {
  if (!key.startsWith("pk_live_")) return null;
  try {
    const decoded = atob(key.slice("pk_live_".length));
    return decoded
      .replace(/\$$/, "")
      .replace(/^clerk\./, "")
      .toLowerCase();
  } catch {
    return null;
  }
}

/** Khớp chính xác hoặc là subdomain của `allowed`. */
function matchesHost(hostname: string, allowed: string): boolean {
  return hostname === allowed || hostname.endsWith(`.${allowed}`);
}

function allowedHosts(): string[] {
  const configured = envList("VITE_CLERK_ALLOWED_HOSTS");
  if (configured) return configured;
  const primary = hostFromKey(CLERK_KEY);
  return primary ? [primary, ...DEFAULT_ALLOWED_HOSTS] : [...DEFAULT_ALLOWED_HOSTS];
}

function satelliteHosts(): string[] {
  return envList("VITE_CLERK_SATELLITE_HOSTS") ?? DEFAULT_SATELLITE_HOSTS;
}

function primaryOrigin(): string {
  const configured = import.meta.env["VITE_CLERK_PRIMARY_ORIGIN"] as string | undefined;
  return (configured || DEFAULT_PRIMARY_ORIGIN).replace(/\/$/, "");
}

/**
 * Cấu hình Clerk cho một hostname, hoặc `null` khi host đó không được phép dùng
 * Clerk (localhost, preview, domain chưa khai báo ở Dashboard) => chế độ demo.
 */
export function resolveClerkDomain(hostname: string): ClerkDomainConfig | null {
  if (!CLERK_KEY) return null;
  const host = hostname.toLowerCase();

  // Khoá development (`pk_test_`) chạy được ở mọi origin.
  if (!CLERK_KEY.startsWith("pk_live_")) {
    return { isSatellite: false, signInUrl: SIGN_IN_PATH, signUpUrl: SIGN_UP_PATH };
  }

  if (!allowedHosts().some((allowed) => matchesHost(host, allowed))) return null;

  const origin = primaryOrigin();
  const isSatellite =
    !!origin && satelliteHosts().some((satellite) => matchesHost(host, satellite));
  if (!isSatellite) {
    return { isSatellite: false, signInUrl: SIGN_IN_PATH, signUpUrl: SIGN_UP_PATH };
  }

  return {
    isSatellite: true,
    domain: host,
    signInUrl: `${origin}${SIGN_IN_PATH}`,
    signUpUrl: `${origin}${SIGN_UP_PATH}`,
  };
}

/** Cấu hình Clerk cho trang đang mở; `null` ở phía server hoặc khi Clerk tắt. */
export function currentClerkDomain(): ClerkDomainConfig | null {
  if (typeof window === "undefined") return null;
  return resolveClerkDomain(window.location.hostname);
}

/** Danh sách host bật Clerk, để hiển thị cho người dùng ở chế độ demo. */
export function allowedHostsLabel(): string {
  return allowedHosts().join(", ");
}
