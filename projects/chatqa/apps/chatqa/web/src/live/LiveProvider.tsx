// Trạng thái dùng chung của danh sách máy (ô 1) và lưới màn hình trực tiếp (khung giữa): danh sách máy theo "tower:fleet",
// máy đang chọn, khung giữa đang hiện chat hay màn hình, máy phóng to, giành quyền điều khiển, và phím tắt toàn cửa sổ.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { errorText } from '@shell/lib/session';
import { useToast } from '@shell/components/overlays/ToastHost';
import { callTool, deviceName, onGoEvent, towerApi, type Device, type LiveFrame } from './bridge';
import { frames } from './frames';
import { shortcutFor, type Gesture } from './input';

export type CentreView = 'chat' | 'live';

export interface LiveState {
  devices: Device[];
  selected?: string;
  select: (id: string) => void;
  view: CentreView;
  setView: (v: CentreView) => void;
  /** Máy đang phóng to ở khung giữa. */
  focus?: string;
  /** Phóng to máy (hoặc thu về lưới nếu đang phóng to chính máy đó). */
  enlarge: (id: string) => void;
  /** Chọn máy và mở nó phóng to ở màn hình trực tiếp (từ thẻ chat). */
  open: (id: string) => void;
  /** Máy đang chờ bước hiện tại xong để giành quyền điều khiển. */
  pending?: string;
  toggleTakeover: (id: string) => void;
  stopAll: () => void;
  gesture: (id: string, g: Gesture) => void;
}

const Ctx = createContext<LiveState | null>(null);

/** Như useLive nhưng không bắt buộc có LiveProvider (chat dùng được cả khi không có màn hình trực tiếp). */
export const useLiveOptional = () => useContext(Ctx);

export function useLive(): LiveState {
  const c = useContext(Ctx);
  if (!c) throw new Error('LiveProvider chưa bọc ngoài');
  return c;
}

/** Máy người dùng đang điều khiển (đã giữ xong, không phải đang chờ). */
export const isHeld = (d?: Device) => d?.held === 'held' || d?.held === 'paused';

const nameOf = (d?: Device, id = '') => (d ? deviceName(d) : id);

export function LiveProvider({ children, initial }: { children: ReactNode; initial?: Partial<Pick<LiveState, 'devices' | 'selected' | 'view' | 'focus'>> }) {
  const { show } = useToast();
  const [devices, setDevices] = useState<Device[]>(initial?.devices ?? []);
  const [selected, setSelected] = useState<string | undefined>(initial?.selected);
  const [view, setView] = useState<CentreView>(initial?.view ?? 'chat');
  const [focus, setFocus] = useState<string | undefined>(initial?.focus);
  const [pending, setPending] = useState<string>();
  const devicesRef = useRef(devices);
  devicesRef.current = devices;

  useEffect(() => {
    let alive = true;
    towerApi
      .fleet()
      .then((d) => alive && setDevices(d))
      .catch(() => undefined); // chưa có tháp hoặc chưa đăng nhập: danh sách trống
    const offFleet = onGoEvent<Device[] | null>('tower:fleet', (d) => setDevices(d ?? []));
    const offFrame = onGoEvent<LiveFrame>('live:frame', (f) => void frames.push(f));
    // Lượt chạy tạm dừng / chạy tiếp (kể cả khi lượt bị huỷ lúc đang giữ máy): cập nhật ngay, không chờ lượt đọc máy.
    const offRun = onGoEvent<{ kind: string; deviceId?: string }>('test:event', (ev) => {
      if (!ev.deviceId || (ev.kind !== 'takeover_paused' && ev.kind !== 'takeover_resumed')) return;
      const held = ev.kind === 'takeover_paused' ? 'paused' : '';
      setDevices((list) => list.map((d) => (d.id === ev.deviceId ? { ...d, held } : d)));
    });
    return () => {
      alive = false;
      offFleet();
      offFrame();
      offRun();
    };
  }, []);

  const patch = (id: string, held: Device['held']) => setDevices((list) => list.map((d) => (d.id === id ? { ...d, held } : d)));

  const stopAll = useCallback(() => {
    void callTool('tower_pause_all', {})
      .then((r) => {
        const n = (r.data as { canceled?: number } | null)?.canceled ?? 0;
        show(n > 0 ? `Đã dừng tất cả: huỷ ${n} lượt chạy, nhả mọi máy.` : 'Đã dừng tất cả: không còn lượt chạy nào, mọi máy đã được nhả.');
        setDevices((list) => list.map((d) => (d.held ? { ...d, held: '' } : d)));
      })
      .catch((e) => show(errorText(e)));
  }, [show]);

  const enlarge = useCallback((id: string) => {
    setView('live');
    setFocus((f) => (f === id ? undefined : id));
  }, []);

  const open = useCallback((id: string) => {
    setSelected(id);
    setView('live');
    setFocus(id);
  }, []);

  const toggleTakeover = useCallback(
    (id: string) => {
      const d = devicesRef.current.find((x) => x.id === id);
      if (isHeld(d)) {
        void towerApi
          .handBack(id)
          .then(() => {
            patch(id, '');
            show(d?.held === 'paused' ? `Đã trả ${nameOf(d, id)}; lượt chạy tiếp tục từ bước sau.` : `Đã trả ${nameOf(d, id)}.`);
          })
          .catch((e) => show(errorText(e)));
        return;
      }
      if (pending) return;
      setPending(id);
      setView('live');
      setFocus(id);
      void towerApi
        .takeOver(id)
        .then((t) => {
          patch(id, t.paused ? 'paused' : 'held');
          show(
            t.paused
              ? `Đã dừng lượt chạy trên ${nameOf(d, id)} sau bước hiện tại. Chạm, vuốt trên màn hình; bấm T để trả máy.`
              : `Bạn đang điều khiển ${nameOf(d, id)}. Chạm, vuốt trên màn hình; bấm T để trả máy.`,
          );
        })
        .catch((e) => show(errorText(e)))
        .finally(() => setPending(undefined));
    },
    [pending, show],
  );

  const gesture = useCallback(
    (id: string, g: Gesture) => {
      const req =
        g.kind === 'tap'
          ? callTool('device_tap', { device_id: id, x: g.x, y: g.y })
          : callTool('device_swipe', { device_id: id, x1: g.x1, y1: g.y1, x2: g.x2, y2: g.y2, duration_ms: g.durationMs });
      void req
        .then((r) => {
          const png = (r.data as { png?: string } | null)?.png;
          if (png) void frames.pushPng(id, png); // ảnh ngay sau khi chạm, không chờ khung kế tiếp
        })
        .catch((e) => show(errorText(e)));
    },
    [show],
  );

  // Phím tắt toàn cửa sổ (pha bắt giữ: Esc vẫn tới dù thành phần khác chặn lan truyền; có hộp thoại thì nhường hộp thoại).
  const live = useRef({ selected, stopAll, enlarge, toggleTakeover });
  live.current = { selected, stopAll, enlarge, toggleTakeover };
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const dialogOpen = !!document.querySelector('[role="dialog"], [role="alertdialog"]');
      const act = shortcutFor(e, e.target as HTMLElement | null, dialogOpen);
      if (!act) return;
      const { selected: id, stopAll: stop, enlarge: big, toggleTakeover: take } = live.current;
      if (act === 'stop') {
        e.preventDefault();
        stop();
        return;
      }
      if (!id) return;
      e.preventDefault();
      if (act === 'enlarge') big(id);
      else take(id);
    };
    window.addEventListener('keydown', on, true);
    return () => window.removeEventListener('keydown', on, true);
  }, []);

  const value = useMemo<LiveState>(
    () => ({ devices, selected, select: setSelected, view, setView, focus, enlarge, open, pending, toggleTakeover, stopAll, gesture }),
    [devices, selected, view, focus, enlarge, open, pending, toggleTakeover, stopAll, gesture],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
