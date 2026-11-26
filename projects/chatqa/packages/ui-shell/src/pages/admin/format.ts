// Định dạng ngày giờ, thiết bị, app cho các màn quản trị. Giờ theo giờ Việt Nam (UTC+7), không phụ thuộc múi giờ máy.
import catalog from '@contracts/apps.json';

const VN = 'Asia/Ho_Chi_Minh';
const PARTS = new Intl.DateTimeFormat('en-GB', { timeZone: VN, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

export interface VnTime {
  y: number;
  mo: string;
  d: string;
  h: string;
  mi: string;
  /** Số ngày kể từ 1970 theo lịch Việt Nam (để so sánh "hôm nay", "hôm qua"). */
  day: number;
}

export function vnTime(unixSec: number): VnTime {
  const p = Object.fromEntries(PARTS.formatToParts(unixSec * 1000).map((x) => [x.type, x.value]));
  return { y: Number(p.year), mo: p.month, d: p.day, h: p.hour, mi: p.minute, day: Math.floor((unixSec + 7 * 3600) / 86400) };
}

/** "11/11 14:32" */
export const fmtShort = (sec: number) => {
  const t = vnTime(sec);
  return `${t.d}/${t.mo} ${t.h}:${t.mi}`;
};

/** "10:42 hôm nay" · "Hôm qua 16:20" · "07/11 14:30" */
export function fmtDayTime(sec: number, nowSec: number): string {
  const t = vnTime(sec);
  const n = vnTime(nowSec);
  if (t.day === n.day) return `${t.h}:${t.mi} hôm nay`;
  if (t.day === n.day - 1) return `Hôm qua ${t.h}:${t.mi}`;
  return `${t.d}/${t.mo} ${t.h}:${t.mi}`;
}

/** "vừa xong" · "5 phút trước" · "1 giờ trước" · "10 ngày trước" (làm tròn, như khung pen). */
export function fmtAgo(sec: number, nowSec: number): string {
  const diff = Math.max(0, nowSec - sec);
  if (diff < 120) return 'vừa xong';
  if (diff < 3600) return `${Math.round(diff / 60)} phút trước`;
  if (diff < 86400) return `${Math.round(diff / 3600)} giờ trước`;
  return `${Math.round(diff / 86400)} ngày trước`;
}

/** "11/11/2026" (ô lọc ngày). */
export const fmtDate = (sec: number) => {
  const t = vnTime(sec);
  return `${t.d}/${t.mo}/${t.y}`;
};

/** Lúc 00:00 giờ Việt Nam của ngày chứa `sec`. */
export const startOfDay = (sec: number) => vnTime(sec).day * 86400 - 7 * 3600;

/** Mã app -> "01". */
export function appNo(code: string): string {
  const a = catalog.apps.find((x) => x.code === code);
  return a ? String(a.no).padStart(2, '0') : '??';
}

export const appName = (code: string) => catalog.apps.find((x) => x.code === code)?.name ?? code;

/** "App 01 · Báo giá" */
export const appLabel = (code: string) => `App ${appNo(code)} · ${appName(code)}`;

/** Danh sách app theo số ("App 01, 02, 03, 04"); rỗng -> "Không có app". */
export function appsText(codes: readonly string[]): string {
  if (!codes.length) return 'Không có app';
  const sorted = [...codes].sort((a, b) => appNo(a).localeCompare(appNo(b)));
  return `App ${sorted.map(appNo).join(', ')}`;
}

export type DeviceKind = 'desktop' | 'phone' | 'laptop';

/** Từ chuỗi User-Agent của phiên web: "Chrome · Windows", "Safari · iPhone". */
export function describeUa(ua: string | null): { name: string; kind: DeviceKind } {
  const s = ua ?? '';
  const browser = /Edg\//.test(s) ? 'Edge' : /OPR\/|Opera/.test(s) ? 'Opera' : /Firefox\//.test(s) ? 'Firefox' : /Chrome\/|CriOS\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : 'Trình duyệt';
  const os = /iPhone/.test(s) ? 'iPhone' : /iPad/.test(s) ? 'iPad' : /Android/.test(s) ? 'Android' : /Windows/.test(s) ? 'Windows' : /Mac OS X|Macintosh/.test(s) ? 'macOS' : /Linux/.test(s) ? 'Linux' : '';
  const kind: DeviceKind = /iPhone|Android.*Mobile/.test(s) ? 'phone' : /Macintosh|Mac OS X/.test(s) ? 'laptop' : 'desktop';
  return { name: os ? `${browser} · ${os}` : browser, kind };
}

/** Che 2 đoạn cuối của IPv4 ("113.161.x.x"); IPv6 hoặc rỗng thì cắt ngắn. */
export function maskIp(ip: string | null): string {
  if (!ip) return '';
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(ip);
  if (v4) return `${v4[1]}.${v4[2]}.x.x`;
  return `${ip.split(':').slice(0, 2).join(':')}:…`;
}

/** Chữ viết tắt cho ảnh đại diện: "Hoàng Anh Tùng" -> "AT" (hai từ cuối), "Vipo Logistics" -> "VL". */
export function initials(name: string): string {
  const w = name.trim().split(/\s+/).filter(Boolean);
  if (!w.length) return '?';
  if (w.length === 1) return w[0].slice(0, 2).toUpperCase();
  return (w[w.length - 2][0] + w[w.length - 1][0]).toUpperCase();
}

/** Bỏ dấu tiếng Việt: "Hà" -> "Ha", "Đỗ" -> "Do". */
export const stripMarks = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D');
