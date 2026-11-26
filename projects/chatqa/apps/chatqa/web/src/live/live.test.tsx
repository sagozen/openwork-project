import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Workspace } from '../workspace/Workspace';
import type { Device, LiveFrame } from './bridge';
import { deviceSubtitle, DeviceListView, filterDevices } from './DeviceList';
import { DeviceGrid } from '../chat/components/devices';
import { deviceName, webProblemText, webSubtitle } from './bridge';
import { createFrameStore, type Decoded } from './frames';
import { gestureOf, shortcutFor, TAP_SLOP, toUnit, unrotate, windowRange } from './input';
import { frameErrorText, LiveGridView, Screen } from './LiveGrid';

const el = (tagName: string, extra: Partial<{ isContentEditable: boolean; role: string }> = {}) => ({
  tagName,
  isContentEditable: extra.isContentEditable ?? false,
  getAttribute: (n: string) => (n === 'role' ? (extra.role ?? null) : null),
});

describe('phím tắt', () => {
  it('Esc dừng tất cả ở mọi nơi, kể cả đang gõ; giữ phím không lặp', () => {
    for (const t of [el('BODY'), el('INPUT'), el('TEXTAREA'), el('DIV', { isContentEditable: true }), el('BUTTON'), null]) {
      expect(shortcutFor({ key: 'Escape' }, t)).toBe('stop');
    }
    expect(shortcutFor({ key: 'Escape', repeat: true }, el('BODY'))).toBeNull();
  });

  it('đang mở hộp thoại: Esc chỉ đóng hộp thoại, không phím tắt nào của màn hình chạy', () => {
    for (const key of ['Escape', 'Enter', 't']) expect(shortcutFor({ key }, el('BODY'), true)).toBeNull();
  });

  it('Enter phóng to, T giành quyền, trừ khi đang gõ chữ; Enter trên nút vẫn bấm nút', () => {
    expect(shortcutFor({ key: 'Enter' }, el('BODY'))).toBe('enlarge');
    expect(shortcutFor({ key: 'Enter' }, el('LI'))).toBe('enlarge');
    expect(shortcutFor({ key: 't' }, el('BODY'))).toBe('takeover');
    expect(shortcutFor({ key: 'T' }, el('BUTTON'))).toBe('takeover');
    expect(shortcutFor({ key: 'Enter' }, el('BUTTON'))).toBeNull();
    // Ô màn hình trực tiếp là role="button", tự mở bằng Enter nên phím tắt chung không phóng to lần nữa.
    expect(shortcutFor({ key: 'Enter' }, el('ARTICLE', { role: 'button' }))).toBeNull();
    for (const t of [el('INPUT'), el('TEXTAREA'), el('SELECT'), el('DIV', { isContentEditable: true }), el('DIV', { role: 'textbox' })]) {
      expect(shortcutFor({ key: 'Enter' }, t)).toBeNull();
      expect(shortcutFor({ key: 't' }, t)).toBeNull();
    }
  });

  it('phím có ⌘/Ctrl/Alt không phải phím tắt của màn hình (⌘K thuộc thanh lệnh)', () => {
    expect(shortcutFor({ key: 't', metaKey: true }, el('BODY'))).toBeNull();
    expect(shortcutFor({ key: 'Enter', ctrlKey: true }, el('BODY'))).toBeNull();
    expect(shortcutFor({ key: 'k', metaKey: true }, el('BODY'))).toBeNull();
  });
});

describe('xoay màn hình', () => {
  const p = { x: 0.25, y: 0.75, t: 5 };
  it('điểm trên ảnh đã xoay về đúng điểm trên khung gốc', () => {
    expect(unrotate(p, 0)).toEqual(p);
    expect(unrotate(p, 90)).toEqual({ x: 0.75, y: 0.75, t: 5 });
    expect(unrotate(p, 180)).toEqual({ x: 0.75, y: 0.25, t: 5 });
    expect(unrotate(p, 270)).toEqual({ x: 0.25, y: 0.25, t: 5 });
  });

  it('góc trái trên của ảnh xoay 90° là góc dưới trái của khung gốc', () => {
    expect(unrotate({ x: 0, y: 0, t: 0 }, 90)).toEqual({ x: 0, y: 1, t: 0 });
  });

  it('đổi góc xoay vẽ lại khung gần nhất với góc mới', async () => {
    const seen: number[] = [];
    const store = createFrameStore(async () => ({ width: 2, height: 1 }), (_c, _i, rot) => seen.push(rot));
    await store.push({ deviceId: 'a', seq: 1, mode: 'idle', jpeg: '', width: 2, height: 1, grabMs: 0 });
    store.attach('a', {} as HTMLCanvasElement);
    store.setRotation('a', 90);
    store.setRotation('a', 90);
    expect(seen).toEqual([0, 90]);
  });
});

describe('cử chỉ trên canvas', () => {
  const rect = { left: 100, top: 50, width: 200, height: 400 };

  it('toạ độ theo tỉ lệ khung ảnh, kẹp trong 0..1', () => {
    expect(toUnit(200, 250, rect, 0)).toEqual({ x: 0.5, y: 0.5, t: 0 });
    expect(toUnit(50, 900, rect, 0)).toEqual({ x: 0, y: 1, t: 0 });
  });

  it('nhích dưới ngưỡng là chạm, xa hơn là vuốt với thời gian theo tay người', () => {
    expect(gestureOf({ x: 0.5, y: 0.5, t: 0 }, { x: 0.5 + TAP_SLOP / 2, y: 0.5, t: 90 })).toEqual({ kind: 'tap', x: 0.5, y: 0.5 });
    expect(gestureOf({ x: 0.5, y: 0.8, t: 1000 }, { x: 0.5, y: 0.2, t: 1350 })).toEqual({ kind: 'swipe', x1: 0.5, y1: 0.8, x2: 0.5, y2: 0.2, durationMs: 350 });
    expect(gestureOf({ x: 0.1, y: 0.5, t: 0 }, { x: 0.9, y: 0.5, t: 20 })).toMatchObject({ durationMs: 100 });
    expect(gestureOf({ x: 0.1, y: 0.5, t: 0 }, { x: 0.9, y: 0.5, t: 9000 })).toMatchObject({ durationMs: 2000 });
  });
});

const dev = (i: number, over: Partial<Device> = {}): Device => ({ id: `emu-${i}`, platform: 'android', state: 'ready', model: `Pixel ${i}`, osVersion: '14', battery: 80, ...over });

describe('danh sách máy (ô 1)', () => {
  it('cửa sổ hàng theo vị trí cuộn, có đệm, không vượt số máy', () => {
    expect(windowRange(0, 520, 52, 1000)).toEqual([0, 14]);
    expect(windowRange(5200, 520, 52, 1000)).toEqual([96, 114]);
    expect(windowRange(0, 520, 52, 3)).toEqual([0, 3]);
    expect(windowRange(0, 520, 52, 0)).toEqual([0, 0]);
  });

  it('lọc theo ID, model, hệ điều hành', () => {
    const list = [dev(1), dev(2, { platform: 'ios', model: 'iPhone 15 Pro', osVersion: '18.1' })];
    expect(filterDevices(list, 'iphone').map((d) => d.id)).toEqual(['emu-2']);
    expect(filterDevices(list, 'EMU-1').map((d) => d.id)).toEqual(['emu-1']);
    expect(filterDevices(list, '  ')).toHaveLength(2);
  });

  it('100 máy: chỉ vẽ các hàng đang thấy, chiều cao đủ cho cả danh sách', () => {
    const list = Array.from({ length: 100 }, (_, i) => dev(i));
    const html = renderToStaticMarkup(<DeviceListView devices={list} onSelect={() => undefined} onOpen={() => undefined} />);
    const rows = html.match(/role="option"/g)?.length ?? 0;
    expect(rows).toBeGreaterThan(5);
    expect(rows).toBeLessThan(30);
    expect(html).toContain('height:5200px');
  });

  it('máy đang chọn, máy đang bị giữ, máy đã rút, và phím tắt ở chân ô', () => {
    const html = renderToStaticMarkup(
      <DeviceListView devices={[dev(1), dev(2, { held: 'paused', state: 'busy' }), dev(3, { state: 'disconnected' })]} selected="emu-1" onSelect={() => undefined} onOpen={() => undefined} />,
    );
    expect(html).toMatch(/aria-selected="true"[^>]*>.*Pixel 1/);
    // Hàng chọn được bằng bàn phím: đúng một hàng trong thứ tự Tab (roving tabindex).
    expect(html).toMatch(/aria-selected="true"[^>]*tabindex="0"/);
    expect(html.match(/tabindex="0"/g)).toHaveLength(1);
    expect(html).toContain('chọn');
    expect(html).toContain('Bạn đang điều khiển');
    expect(html).toContain('Đã rút');
    expect(html).toContain('phóng to');
    expect(html).toContain('dừng tất cả');
  });

  it('chưa có máy: trạng thái trống như trước, không có chân phím tắt', () => {
    const html = renderToStaticMarkup(<DeviceListView devices={[]} onSelect={() => undefined} onOpen={() => undefined} />);
    expect(html).toContain('Chưa có máy nào kết nối');
    expect(html).not.toContain('dừng tất cả');
  });

  it('màn 4 ô dùng danh sách máy truyền vào cho ô 1', () => {
    const html = renderToStaticMarkup(<Workspace devices={1} deviceList={<p>danh sách thật</p>} />);
    expect(html).toContain('<p>danh sách thật</p>');
    expect(html).not.toContain('Chưa có máy nào kết nối');
  });
});

describe('lưới màn hình trực tiếp', () => {
  it('mỗi máy một ô; máy đã rút hoặc chưa dùng được không có canvas', () => {
    const html = renderToStaticMarkup(
      <LiveGridView
        devices={[dev(1), dev(2, { state: 'disconnected' }), dev(3, { state: 'unhealthy', problem: 'chưa chấp nhận gỡ lỗi USB' })]}
        selected="emu-1"
        onSelect={() => undefined}
        onOpen={() => undefined}
        watch={() => undefined}
      />,
    );
    expect(html.match(/<canvas/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Màn hình emu-1"');
    expect(html).toContain('Máy đã rút');
    expect(html).toContain('chưa chấp nhận gỡ lỗi USB');
  });

  it('chưa có máy: lời nhắc thay vì lưới rỗng', () => {
    const html = renderToStaticMarkup(<LiveGridView devices={[]} onSelect={() => undefined} onOpen={() => undefined} watch={() => undefined} />);
    expect(html).toContain('Chưa có máy để xem');
  });

  it('ô chưa có ảnh nói đang chờ; đang điều khiển thì canvas nhận chạm', () => {
    const store = createFrameStore(async () => ({ width: 1, height: 1 }), () => undefined);
    expect(renderToStaticMarkup(<Screen id="emu-1" store={store} />)).toContain('Đang chờ ảnh màn hình');
    expect(renderToStaticMarkup(<Screen id="emu-1" store={store} interactive />)).toContain('cursor-crosshair');
  });
});

describe('kho khung hình (ngoài React state)', () => {
  const frame = (seq: number, over: Partial<LiveFrame> = {}): LiveFrame => ({ deviceId: 'emu-1', seq, mode: 'idle', width: 360, height: 800, jpeg: `j${seq}`, grabMs: 40, ...over });
  const canvas = (name: string) => ({ name }) as unknown as HTMLCanvasElement;

  function rig() {
    const painted: string[] = [];
    const closed: string[] = [];
    const pending = new Map<string, (d: Decoded) => void>();
    const decode = vi.fn((b64: string) => new Promise<Decoded>((res) => pending.set(b64, res)));
    const store = createFrameStore(decode, (c, img) => painted.push(`${(c as unknown as { name: string }).name}:${(img as Decoded & { src: string }).src}`));
    const finish = (b64: string) => pending.get(b64)?.({ width: 360, height: 800, src: b64, close: () => closed.push(b64) } as Decoded);
    return { store, painted, closed, finish, decode };
  }

  it('vẽ khung lên mọi canvas của máy; gắn canvas mới thì vẽ ngay khung gần nhất', async () => {
    const { store, painted, finish } = rig();
    store.attach('emu-1', canvas('a'));
    const p = store.push(frame(1));
    finish('j1');
    await p;
    expect(painted).toEqual(['a:j1']);
    store.attach('emu-1', canvas('b'));
    expect(painted).toEqual(['a:j1', 'b:j1']);
  });

  it('khung giải mã xong muộn hơn khung mới bị bỏ; khung cũ được giải phóng', async () => {
    const { store, painted, closed, finish } = rig();
    store.attach('emu-1', canvas('a'));
    const p1 = store.push(frame(1));
    const p2 = store.push(frame(2));
    finish('j2');
    await p2;
    finish('j1');
    await p1;
    expect(painted).toEqual(['a:j2']);
    expect(closed).toEqual(['j1']);
    await store.push(frame(1)); // số thứ tự cũ: bỏ ngay, không giải mã
    expect(painted).toEqual(['a:j2']);
  });

  it('máy chưa có driver ấm: ô mời phóng to thay vì chờ ảnh mãi', async () => {
    const { store } = rig();
    await store.push(frame(1, { mode: 'cold', jpeg: '' }));
    expect(store.meta('emu-1')?.mode).toBe('cold');
    expect(renderToStaticMarkup(<Screen id="emu-1" store={store} />)).toContain('Phóng to (Enter) để khởi động');
  });

  it('ô báo lỗi chụp ảnh bằng câu theo mã lỗi, mã lạ giữ nguyên chữ của Go', async () => {
    const { store } = rig();
    await store.push(frame(1, { error: 'ios_team_id_missing: 00008101-AAA', jpeg: '' }));
    const html = renderToStaticMarkup(<Screen id="emu-1" store={store} />);
    expect(html).toContain('Cần Apple Team ID để chạy trên iPhone thật');
    expect(html).not.toContain('00008101-AAA');
    expect(frameErrorText('device_not_ready: emu-1: disconnected')).toContain('emu-1: disconnected');
    expect(frameErrorText('png: invalid format')).toBe('png: invalid format');
  });

  it('React chỉ được báo khi chế độ, lỗi hoặc kích thước đổi', async () => {
    const { store, finish } = rig();
    const ping = vi.fn();
    store.subscribe(ping);
    for (const [seq, mode] of [[1, 'idle'], [2, 'idle'], [3, 'busy']] as const) {
      const p = store.push(frame(seq, { mode }));
      finish(`j${seq}`);
      await p;
    }
    expect(ping).toHaveBeenCalledTimes(2);
    await store.push(frame(4, { error: 'device_not_ready: emu-1: disconnected', jpeg: '' }));
    expect(store.meta('emu-1')?.error).toContain('disconnected');
    expect(ping).toHaveBeenCalledTimes(3);
  });

  it('ảnh sau khi chạm hiện ngay, trừ khi đã có khung mới hơn trong lúc giải mã', async () => {
    const { store, painted, finish } = rig();
    store.attach('emu-1', canvas('a'));
    const tap = store.pushPng('emu-1', 'png-after-tap');
    finish('png-after-tap');
    await tap;
    expect(painted).toEqual(['a:png-after-tap']);
    const late = store.pushPng('emu-1', 'png-late');
    const p = store.push(frame(5));
    finish('j5');
    await p;
    finish('png-late');
    await late;
    expect(painted).toEqual(['a:png-after-tap', 'a:j5']);
  });
});

describe('máy web (hồ sơ trình duyệt)', () => {
  const web: Device = { id: 'web-staging', platform: 'web', state: 'ready', name: 'Staging', model: 'msedge 1280x800 headless', driver: 'playwright', battery: -1 };
  const phone: Device = { id: 'R58N123', platform: 'android', state: 'ready', model: 'Galaxy S23', osVersion: '14', battery: 82 };

  it('lọc được theo "web"', () => {
    expect(filterDevices([phone, web], 'web').map((d) => d.id)).toEqual(['web-staging']);
    expect(filterDevices([phone, web], 'staging').map((d) => d.id)).toEqual(['web-staging']);
  });

  it('tên theo hồ sơ, dòng phụ trình duyệt · WxH · host', () => {
    expect(deviceName(web)).toBe('Staging');
    expect(deviceName(phone)).toBe('Galaxy S23');
    expect(webSubtitle(web, 'https://staging.example.com:8443/app')).toBe('msedge · 1280x800 · staging.example.com:8443');
    expect(deviceSubtitle(web)).toBe('msedge · 1280x800');
    expect(deviceSubtitle(phone)).toBe('android 14');
  });

  it('chưa cài bộ chạy, chưa có Edge: câu theo mã lỗi và nút mở Cài đặt (chỉ khi có hành động)', () => {
    const noRuntime = { ...web, state: 'unhealthy' as const, problem: 'web_runtime_missing' };
    const noEdge = { ...web, id: 'web-edge', state: 'unhealthy' as const, problem: 'device_tool_missing' };
    expect(webProblemText(noRuntime)).toContain('Chưa cài bộ chạy trình duyệt');
    expect(webProblemText(noEdge)).toBe('Máy tính chưa có Microsoft Edge. Cài rồi thử lại.');
    const html = renderToStaticMarkup(<DeviceListView devices={[phone, noRuntime, noEdge]} onSelect={() => undefined} onOpen={() => undefined} onSettings={() => undefined} />);
    expect(html).toContain('Chưa cài bộ chạy trình duyệt');
    expect(html).toContain('Máy tính chưa có Microsoft Edge');
    expect(html.match(/Cài đặt<\/button>/g)).toHaveLength(2);
    expect(html).toContain('lucide-globe');
    expect(renderToStaticMarkup(<DeviceListView devices={[noRuntime]} onSelect={() => undefined} onOpen={() => undefined} />)).not.toContain('Cài đặt</button>');
  });

  it('dòng máy web hiện host của baseURL; thẻ thiết bị trong chat cũng hiện trình duyệt', () => {
    const html = renderToStaticMarkup(<DeviceListView devices={[web]} onSelect={() => undefined} onOpen={() => undefined} baseURLs={{ 'web-staging': 'https://staging.example.com' }} />);
    expect(html).toContain('msedge · 1280x800 · staging.example.com');
    expect(html).toContain('>Staging<');
    const card = renderToStaticMarkup(<DeviceGrid data={[{ ...web, problem: 'web_runtime_missing', state: 'unhealthy' }]} actions={{ runTool: () => undefined, confirmChat: () => undefined, openSettings: () => undefined }} />);
    expect(card).toContain('web-staging · msedge · 1280x800');
    expect(card).toContain('Chưa cài bộ chạy trình duyệt');
    expect(card).toContain('Cài đặt</button>');
  });

  it('ô lưới của máy web chưa dùng được nói rõ cần cài gì', () => {
    const html = renderToStaticMarkup(<LiveGridView devices={[{ ...web, state: 'unhealthy', problem: 'web_runtime_missing' }]} onSelect={() => undefined} onOpen={() => undefined} watch={() => undefined} />);
    expect(html).toContain('Chưa cài bộ chạy trình duyệt');
    expect(html).toContain('aria-label="Staging"');
  });
});
