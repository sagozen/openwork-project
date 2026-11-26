import { describe, expect, it } from 'vitest';
import { countText, createDurationStore, createNetStore, estimate, formatWait, median, timeText, type NetEvent } from './net-progress';

const memBacking = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

describe('median', () => {
  it('lấy trung vị, bỏ qua giá trị lệch', () => {
    expect(median([])).toBeNull();
    expect(median([5000])).toBe(5000);
    expect(median([1000, 9000, 3000])).toBe(3000);
    expect(median([1000, 3000])).toBe(2000);
    expect(median([2000, 2100, 60000])).toBe(2100);
  });
});

describe('estimate', () => {
  it('đếm được: ngoại suy theo tốc độ thật', () => {
    const e = estimate({ elapsedMs: 4000, done: 40, total: 100, typicalMs: null });
    expect(e.basis).toBe('count');
    expect(e.fraction).toBeCloseTo(0.4);
    expect(e.remainingMs).toBe(6000);
  });
  it('đếm được nhưng quá sớm thì chưa hứa thời gian', () => {
    const e = estimate({ elapsedMs: 300, done: 1, total: 1000, typicalMs: 8000 });
    expect(e.remainingMs).toBeNull();
    expect(e.basis).toBeNull();
  });
  it('không đếm được: dùng thời lượng thường lệ', () => {
    const e = estimate({ elapsedMs: 3000, done: 0, total: 0, typicalMs: 8000 });
    expect(e.basis).toBe('history');
    expect(e.remainingMs).toBe(5000);
    expect(e.fraction).toBeCloseTo(0.375);
  });
  it('quá lâu so với thường lệ thì báo chậm thay vì đếm ngược về 0', () => {
    const e = estimate({ elapsedMs: 13000, done: 0, total: 0, typicalMs: 8000 });
    expect(e.slow).toBe(true);
    expect(e.remainingMs).toBeNull();
  });
  it('thanh không chạm 100% khi mới ước theo lịch sử', () => {
    expect(estimate({ elapsedMs: 8000, done: 0, total: 0, typicalMs: 8000 }).fraction).toBe(0.95);
  });
  it('chưa có gì để ước thì không đoán', () => {
    const e = estimate({ elapsedMs: 5000, done: 0, total: 0, typicalMs: null });
    expect(e).toMatchObject({ fraction: null, remainingMs: null, basis: null, slow: false });
  });
});

describe('chữ hiển thị', () => {
  it('formatWait làm tròn lên và gộp phút', () => {
    expect(formatWait(100)).toBe('1 giây');
    expect(formatWait(6400)).toBe('7 giây');
    expect(formatWait(60000)).toBe('1 phút');
    expect(formatWait(75000)).toBe('1 phút 15 giây');
  });
  it('countText theo đơn vị', () => {
    expect(countText({ done: 120, total: 300, unit: 'rows' })).toBe('120/300 dòng');
    expect(countText({ done: 12, total: 0, unit: 'files' })).toBe('12 tệp');
    expect(countText({ done: 3, total: 9, unit: 'pages' })).toBe('3/9 trang');
    expect(countText({ done: 2, total: 7, unit: 'items' })).toBe('2/7 mục');
    expect(countText({ done: 512, total: 2048, unit: 'bytes' })).toBe('512 B/2 KB');
    expect(countText({ done: 0, total: 0, unit: '' })).toBe('');
  });
  it('timeText: im lặng khi mới bắt đầu, đủ ý khi đã chờ', () => {
    const fresh = estimate({ elapsedMs: 500, done: 0, total: 0, typicalMs: 8000 });
    expect(timeText(fresh)).toBe('');
    const mid = estimate({ elapsedMs: 4000, done: 0, total: 0, typicalMs: 10000 });
    expect(timeText(mid)).toBe('đã chờ 4 giây · còn khoảng 6 giây');
    const slow = estimate({ elapsedMs: 20000, done: 0, total: 0, typicalMs: 8000 });
    expect(timeText(slow)).toBe('đã chờ 20 giây · lâu hơn thường lệ (thường ~8 giây)');
    const none = estimate({ elapsedMs: 5000, done: 0, total: 0, typicalMs: null });
    expect(timeText(none)).toBe('đã chờ 5 giây');
  });
});

describe('createDurationStore', () => {
  it('chỉ giữ 8 lần gần nhất và bỏ lần quá ngắn', () => {
    const s = createDurationStore(memBacking);
    for (let i = 1; i <= 10; i++) s.add('vipo.read-sheet', i * 1000);
    s.add('vipo.read-sheet', 50);
    expect(s.list('vipo.read-sheet')).toEqual([3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000]);
  });
  it('không có localStorage thì vẫn chạy bằng bộ nhớ', () => {
    const s = createDurationStore(() => null);
    s.add('x', 2000);
    expect(s.list('x')).toEqual([2000]);
  });
  it('localStorage ném lỗi thì không văng ra ngoài', () => {
    const s = createDurationStore(() => ({
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    }));
    expect(() => s.add('x', 2000)).not.toThrow();
    expect(s.list('x')).toEqual([2000]);
  });
});

describe('createNetStore', () => {
  const ev = (over: Partial<NetEvent>): NetEvent => ({ id: 'a', op: 'drive.pull', label: 'Đang kéo', state: 'running', done: 0, total: 0, startedAt: 0, ...over });

  it('ghi thời lượng khi xong, tính theo đồng hồ giao diện', () => {
    let t = 1000;
    const durations = createDurationStore(memBacking);
    const s = createNetStore(durations, () => t);
    s.ingest(ev({}));
    t = 6000;
    s.ingest(ev({ state: 'done' }));
    expect(durations.list('drive.pull')).toEqual([5000]);
  });
  it('lần chạy lỗi không vào lịch sử', () => {
    let t = 0;
    const durations = createDurationStore(memBacking);
    const s = createNetStore(durations, () => t);
    s.ingest(ev({}));
    t = 9000;
    s.ingest(ev({ state: 'failed' }));
    expect(durations.list('drive.pull')).toEqual([]);
  });
  it('mốc bắt đầu giữ nguyên qua các lần cập nhật cùng mã', () => {
    let t = 100;
    const s = createNetStore(createDurationStore(memBacking), () => t);
    s.ingest(ev({}));
    t = 900;
    s.ingest(ev({ done: 5, total: 10, unit: 'files' }));
    expect(s.get('drive.pull')).toMatchObject({ seenAt: 100, done: 5, total: 10, unit: 'files' });
  });
  it('lần chạy mới (mã khác) bắt đầu lại mốc', () => {
    let t = 100;
    const s = createNetStore(createDurationStore(memBacking), () => t);
    s.ingest(ev({}));
    t = 700;
    s.ingest(ev({ id: 'b' }));
    expect(s.get('drive.pull')?.seenAt).toBe(700);
  });
  it('báo cho người nghe và huỷ nghe được', () => {
    const s = createNetStore(createDurationStore(memBacking));
    let n = 0;
    const off = s.subscribe(() => void n++);
    s.ingest(ev({}));
    off();
    s.ingest(ev({ done: 1 }));
    expect(n).toBe(1);
  });
});
