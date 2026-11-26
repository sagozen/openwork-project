// Câu báo lỗi tiếng Việt - nguồn: contracts/errors.json (dùng chung Go / Worker / Web).
import contract from '@contracts/errors.json';
import permissions from '@contracts/permissions.json';

const MESSAGES: Record<string, string> = contract.errors;

/** Tách mã lỗi từ chuỗi "code: chi tiết" (quy ước lỗi Go). Không có mã hợp lệ => "error". */
export function parseErrorCode(msg: string): string {
  const m = /^\s*([a-z][a-z0-9_]*)\s*(?::|$)/.exec(msg);
  return m ? m[1] : 'error';
}

/** Thay {mm}, {n}, {tên}... trong câu báo lỗi bằng giá trị thật; chỗ chưa có giá trị giữ nguyên. */
export function fillCopy(text: string, params?: Record<string, string | number>): string {
  return params ? text.replace(/\{([^{}]+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m)) : text;
}

/** Tách tham số "k=v,k=v" sau mã lỗi Go ("rate_limited: minutes=12"); chuỗi chi tiết thường (không có "k=v") cho {}. */
export function parseErrorParams(msg: string): Record<string, string | number> {
  const detail = /^\s*[a-z][a-z0-9_]*\s*:\s*(.*)$/s.exec(msg)?.[1] ?? '';
  const out: Record<string, string | number> = {};
  for (const part of detail.split(',')) {
    const m = /^\s*([A-Za-z][A-Za-z0-9_]*)=(.*)$/.exec(part);
    if (m) out[m[1]] = m[2] !== '' && !Number.isNaN(Number(m[2])) ? Number(m[2]) : m[2];
  }
  return out;
}

/** Nhãn thao tác dùng cho {thao tác} của E-011: tra từ contracts/permissions.json theo mã quyền. */
const PERM_LABEL = new Map(permissions.permissions.map((p) => [p.code, p.label]));

const VN_TZ = 'Asia/Ho_Chi_Minh';
const VN_PARTS = new Intl.DateTimeFormat('en-GB', { timeZone: VN_TZ, hourCycle: 'h23', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
/** Ngày giờ theo giờ Việt Nam: tự ghép từng phần để không phụ thuộc thứ tự của locale. */
const vnTime = (unixSec: number) => {
  const p = Object.fromEntries(VN_PARTS.formatToParts(unixSec * 1000).map((x) => [x.type, x.value]));
  return { date: `${p.day}/${p.month}`, time: `${p.hour}:${p.minute}` };
};

/** Tham số Worker/Go (minutes, lockedAt, maxDevices, by, at, role, product...) -> chỗ trống trong câu spec ({mm}, {dd/mm hh:mm}, {n}, {người}, {hh:mm}, {tên}, {vai}, {sản phẩm}). Giờ theo giờ Việt Nam. */
export function copyParams(raw: Record<string, string | number>): Record<string, string | number> {
  const out: Record<string, string | number> = { ...raw };
  const alias = (to: string, from: string) => {
    if (!(to in out) && from in out) out[to] = out[from];
  };
  alias('mm', 'minutes');
  alias('n', 'maxDevices');
  alias('n', 'offlineDays');
  alias('tên', 'username');
  alias('người', 'by');
  alias('vai', 'role');
  alias('sản phẩm', 'product');
  for (const k of ['lockedAt', 'at']) {
    const v = Number(raw[k]);
    if (!Number.isFinite(v) || v <= 0) continue;
    const t = vnTime(v);
    if (!('dd/mm hh:mm' in out)) out['dd/mm hh:mm'] = `${t.date} ${t.time}`;
    if (!('hh:mm' in out)) out['hh:mm'] = t.time;
  }
  return out;
}

export function errorText(e: unknown, params?: Record<string, string | number>): string {
  if (e === null || e === undefined) return '';
  const code = (e as { code?: string })?.code ?? parseErrorCode(String((e as Error)?.message ?? e));
  const text = MESSAGES[code];
  if (!text) return `Lỗi: ${code}`;
  const own = (e as { params?: Record<string, string | number> }).params ?? (e instanceof Error && !('code' in e) ? parseErrorParams(e.message) : {});
  const all = { ...own, ...params };
  // E-011: Worker/Go gửi mã quyền ("perm"), câu dùng tên thao tác
  if (code === 'permission_denied' && !('thao tác' in all)) {
    const perm = String(all.perm ?? (e as Error).message?.split(':')[1]?.trim() ?? '');
    all['thao tác'] = (PERM_LABEL.get(perm) ?? perm) || 'này';
  }
  return fillCopy(text, copyParams(all));
}

export const knownErrorCodes = () => Object.keys(MESSAGES);
