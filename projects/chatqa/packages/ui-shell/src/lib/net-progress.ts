// Tiến độ thao tác mạng (Google Sheets, Drive, Worker): tính "còn bao lâu" và chữ hiển thị. Phần thuần, không React.
//
// Hai nguồn cho thời gian còn lại:
//  1. Đếm được (tệp, dòng, trang, byte): ngoại suy theo tốc độ thật của lần chạy này.
//  2. Không đếm được (một yêu cầu liền mạch): trung vị thời lượng các lần chạy thành công gần đây, lưu trên máy.
// Chưa có dữ liệu nào thì chỉ báo thời gian đã chờ, không đoán.

export type NetState = 'running' | 'done' | 'failed';
export type NetUnit = '' | 'bytes' | 'rows' | 'files' | 'pages' | 'items';

/** Sự kiện `net:progress` do Go phát (gói netprog). */
export interface NetEvent {
  id: string;
  op: string;
  label: string;
  state: NetState;
  done: number;
  total: number;
  unit?: NetUnit;
  note?: string;
  startedAt: number;
}

export const NET_EVENT = 'net:progress';
const KEY = 'hsdesk.net-durations.v1';
const KEEP = 8;
/** Dưới mức này thì ngoại suy theo tốc độ chưa đáng tin (mốc đầu thường chậm hơn hoặc nhanh hơn hẳn phần sau). */
const MIN_RATE_ELAPSED_MS = 1500;
const MIN_RATE_FRACTION = 0.03;
/** Chạy quá bấy nhiêu lần thời lượng thường lệ thì thôi đếm ngược mà báo "lâu hơn thường lệ". */
const SLOW_FACTOR = 1.5;
/** Bỏ lần chạy ngắn hơn mức này khỏi lịch sử (không phản ánh độ trễ mạng). */
const MIN_RECORD_MS = 300;

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

/** Nơi lưu lịch sử thời lượng theo khoá thao tác. */
export interface DurationStore {
  list(op: string): number[];
  add(op: string, ms: number): void;
}

type Backing = Pick<Storage, 'getItem' | 'setItem'>;

/** Lưu ở localStorage (lỗi/chặn truy cập thì giữ trong bộ nhớ): chỉ là gợi ý ước lượng nên mất cũng không sao. */
export function createDurationStore(backing: () => Backing | null = defaultBacking): DurationStore {
  let mem: Record<string, number[]> = {};
  const read = (): Record<string, number[]> => {
    try {
      const raw = backing()?.getItem(KEY);
      if (!raw) return mem;
      const v = JSON.parse(raw) as unknown;
      if (v && typeof v === 'object') mem = v as Record<string, number[]>;
    } catch {
      /* dùng bản trong bộ nhớ */
    }
    return mem;
  };
  return {
    list: (op) => (read()[op] ?? []).filter((n) => Number.isFinite(n) && n > 0),
    add(op, ms) {
      if (!Number.isFinite(ms) || ms < MIN_RECORD_MS) return;
      const all = read();
      all[op] = [...(all[op] ?? []), Math.round(ms)].slice(-KEEP);
      mem = all;
      try {
        backing()?.setItem(KEY, JSON.stringify(all));
      } catch {
        /* đầy hoặc bị chặn: giữ trong bộ nhớ */
      }
    },
  };
}

function defaultBacking(): Backing | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export interface Estimate {
  elapsedMs: number;
  /** 0..1 khi có cơ sở để vẽ thanh; null = chỉ hiện vòng quay. */
  fraction: number | null;
  /** Mili giây còn lại; null = không ước được hoặc đang chậm hơn thường lệ. */
  remainingMs: number | null;
  basis: 'count' | 'history' | null;
  /** Đã quá SLOW_FACTOR lần thời lượng thường lệ. */
  slow: boolean;
  typicalMs: number | null;
}

export function estimate(i: { elapsedMs: number; done: number; total: number; typicalMs: number | null }): Estimate {
  const { elapsedMs, done, total, typicalMs } = i;
  const base = { elapsedMs, typicalMs, slow: false };
  if (total > 0 && done >= 0) {
    const fraction = Math.min(done / total, 1);
    if (done > 0 && (elapsedMs >= MIN_RATE_ELAPSED_MS || fraction >= MIN_RATE_FRACTION)) {
      return { ...base, fraction, remainingMs: Math.max(0, Math.round((elapsedMs * (total - done)) / done)), basis: 'count' };
    }
    return { ...base, fraction, remainingMs: null, basis: null };
  }
  if (typicalMs && typicalMs > 0) {
    if (elapsedMs > typicalMs * SLOW_FACTOR) return { ...base, fraction: null, remainingMs: null, basis: 'history', slow: true };
    return { ...base, fraction: Math.min(elapsedMs / typicalMs, 0.95), remainingMs: Math.max(0, typicalMs - elapsedMs), basis: 'history' };
  }
  return { ...base, fraction: null, remainingMs: null, basis: null };
}

/** 6400 -> "7 giây"; 75000 -> "1 phút 15 giây"; làm tròn lên để không hứa sớm hơn thực tế. */
export function formatWait(ms: number): string {
  const s = Math.max(1, Math.ceil(ms / 1000));
  if (s < 60) return `${s} giây`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r === 0 ? `${m} phút` : `${m} phút ${r} giây`;
}

const nf = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 1 });

function bytesText(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${nf.format(n / 1024)} KB`;
  return `${nf.format(n / (1024 * 1024))} MB`;
}

const UNIT_WORD: Record<Exclude<NetUnit, '' | 'bytes'>, string> = { rows: 'dòng', files: 'tệp', pages: 'trang', items: 'mục' };

/** "120/300 dòng", "1,2/3,4 MB"; không có đếm thì "". */
export function countText(e: Pick<NetEvent, 'done' | 'total' | 'unit'>): string {
  const { done, total, unit } = e;
  if (!unit || (done <= 0 && total <= 0)) return '';
  if (unit === 'bytes') return total > 0 ? `${bytesText(done)}/${bytesText(total)}` : bytesText(done);
  const word = UNIT_WORD[unit];
  return total > 0 ? `${done}/${total} ${word}` : `${done} ${word}`;
}

/** Dòng thời gian: "đã chờ 4 giây · còn khoảng 6 giây". Dưới 2 giây thì chưa cần nói gì. */
export function timeText(e: Estimate): string {
  const parts: string[] = [];
  if (e.elapsedMs >= 2000) parts.push(`đã chờ ${formatWait(e.elapsedMs)}`);
  if (e.slow) parts.push(e.typicalMs ? `lâu hơn thường lệ (thường ~${formatWait(e.typicalMs)})` : 'lâu hơn thường lệ');
  else if (e.remainingMs != null && (e.basis === 'count' || e.elapsedMs >= 1000)) parts.push(`còn khoảng ${formatWait(e.remainingMs)}`);
  return parts.join(' · ');
}

/** Một lần chạy đang theo dõi: dựng từ sự kiện, mốc bắt đầu lấy theo đồng hồ giao diện (không phụ thuộc đồng hồ Go). */
export interface NetRun {
  id: string;
  op: string;
  label: string;
  state: NetState;
  done: number;
  total: number;
  unit: NetUnit;
  note: string;
  seenAt: number;
}

type Listener = () => void;

/**
 * Giữ lần chạy mới nhất của mỗi khoá thao tác và ghi thời lượng khi chạy xong. `subscribeEvents` là nơi nhận sự kiện
 * (platform.onNetProgress); không có (PWA) thì kho trống và giao diện dùng đường dự phòng theo thời gian đã chờ.
 */
export function createNetStore(durations: DurationStore, clock: () => number = Date.now) {
  const runs = new Map<string, NetRun>();
  const listeners = new Set<Listener>();
  const emit = () => listeners.forEach((l) => l());
  return {
    durations,
    clock,
    get: (op: string): NetRun | undefined => runs.get(op),
    subscribe(l: Listener) {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    /** Nhận một sự kiện từ Go. */
    ingest(e: NetEvent) {
      const prev = runs.get(e.op);
      const seenAt = prev && prev.id === e.id ? prev.seenAt : clock();
      if (e.state === 'done' && prev && prev.id === e.id) durations.add(e.op, clock() - prev.seenAt);
      runs.set(e.op, { id: e.id, op: e.op, label: e.label, state: e.state, done: e.done, total: e.total, unit: e.unit ?? '', note: e.note ?? '', seenAt });
      emit();
    },
    /** Bỏ lần chạy đã kết thúc khỏi kho (giao diện đã hiện xong). */
    clear(op: string) {
      if (runs.delete(op)) emit();
    },
  };
}

export type NetStore = ReturnType<typeof createNetStore>;
