// Khung giữa, chế độ "Màn hình": lưới màn hình trực tiếp của các máy, máy phóng to, và điều khiển tay khi đã giành quyền.
// Ảnh vẽ lên canvas ngoài React state (frames.ts); chỉ các ô đang thấy trên màn hình được Go chụp (LiveWatch).
import { useCallback, useEffect, useMemo, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { Hand, LayoutGrid, Loader2, Maximize2, MessageSquareText, MonitorSmartphone, RotateCw } from 'lucide-react';
import { Button } from '@shell/components/ui';
import { cx } from '@shell/components/ui/cx';
import { errorText, knownErrorCodes, parseErrorCode } from '@shell/lib/errors';
import { useToast } from '@shell/components/overlays/ToastHost';
import { StateBadge } from '../chat/components/shared';
import { moduleOfPath } from '../modules/registry';
import { Empty } from '../workspace/Workspace';
import { deviceName, isWebDevice, towerApi, webProblemText, type Device } from './bridge';
import { frames as appFrames, useFrameMeta, type FrameStore } from './frames';
import { gestureOf, toUnit, unrotate, WEB_KEYS_ATTR, wheelGesture, type Gesture, type Point } from './input';
import { createKeyBatcher, keyAction, type KeyBatcher } from './keys';
import { isHeld, useLive, type CentreView } from './LiveProvider';
import { rotateNext, useRotation } from './rotation';

/** Tỉ lệ khung khi chưa có ảnh (điện thoại dọc). */
const PHONE_ASPECT = 9 / 19.5;

/** Gộp các lần lăn chuột trong ngần này ms thành một lệnh cuộn. */
const WHEEL_MS = 120;

/** Câu báo lỗi chụp ảnh: mã lỗi có trong danh mục thì dùng câu của danh mục (chi tiết thô vào chỗ {chi tiết}), mã lạ giữ nguyên chữ của Go. */
export function frameErrorText(raw: string): string {
  if (!knownErrorCodes().includes(parseErrorCode(raw))) return raw;
  return errorText(new Error(raw), { 'chi tiết': raw.replace(/^\s*[a-z][a-z0-9_]*\s*:\s*/, '') });
}

/**
 * Màn hình một máy: canvas nhận ảnh từ kho khung hình; interactive = chạm/vuốt chuyển thành lệnh trên máy. keys (máy web đang
 * giữ): bấm vào màn hình để nó nhận phím, phím đi vào trang; lăn chuột thành lệnh cuộn.
 */
export function Screen({
  id,
  interactive,
  onGesture,
  keys,
  store = appFrames,
  className,
}: {
  id: string;
  interactive?: boolean;
  onGesture?: (g: Gesture) => void;
  keys?: KeyBatcher;
  store?: FrameStore;
  className?: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const down = useRef<Point | null>(null);
  const wheel = useRef<{ dx: number; dy: number; timer?: ReturnType<typeof setTimeout> }>({ dx: 0, dy: 0 });
  useEffect(() => () => clearTimeout(wheel.current.timer), []);
  const webKeys = interactive ? keys : undefined;
  const typer = useRef<HTMLTextAreaElement>(null);
  /** Chữ vào ô nhận phím không qua keydown (bộ gõ tiếng Việt, phím chết, dán): gửi rồi xoá ô. */
  const takeTyped = (el: HTMLTextAreaElement) => {
    if (el.value) webKeys?.push({ kind: 'keys', text: el.value });
    el.value = '';
  };
  const meta = useFrameMeta(id, store);
  const rot = useRotation(id);
  // Đặt góc xoay trước khi gắn canvas (effect chạy theo thứ tự) để khung đầu tiên đã vẽ đúng chiều.
  useEffect(() => store.setRotation(id, rot), [id, rot, store]);
  useEffect(() => (canvas.current ? store.attach(id, canvas.current) : undefined), [id, store]);
  const frameAspect = meta?.width && meta.height ? meta.width / meta.height : PHONE_ASPECT;
  const aspect = rot === 90 || rot === 270 ? 1 / frameAspect : frameAspect;
  // Chạm trên ảnh đã xoay thành toạ độ trên khung ảnh gốc của máy.
  const at = (e: React.PointerEvent<HTMLCanvasElement>) => unrotate(toUnit(e.clientX, e.clientY, e.currentTarget.getBoundingClientRect(), e.timeStamp), rot);

  return (
    <div className={cx('relative flex min-h-0 items-center justify-center', className)}>
      <canvas
        ref={canvas}
        aria-label={`Màn hình ${id}`}
        style={{ aspectRatio: aspect }}
        className={cx(
          'h-full max-h-full max-w-full rounded-[10px] bg-[#0f172a] object-contain',
          interactive ? 'cursor-crosshair touch-none ring-2 ring-accent' : '',
        )}
        onWheel={
          webKeys
            ? (e) => {
                const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? e.currentTarget.clientHeight : 1;
                const w = wheel.current;
                w.dx += e.deltaX * scale;
                w.dy += e.deltaY * scale;
                const rect = e.currentTarget.getBoundingClientRect();
                w.timer ??= setTimeout(() => {
                  const g = wheelGesture(w.dx, w.dy, rect);
                  w.dx = w.dy = 0;
                  w.timer = undefined;
                  onGesture?.(g);
                }, WHEEL_MS);
              }
            : undefined
        }
        onPointerDown={
          interactive
            ? (e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                if (webKeys) {
                  e.preventDefault(); // giữ focus ở ô nhận phím, không để chuột kéo focus đi
                  typer.current?.focus();
                }
                down.current = at(e);
              }
            : undefined
        }
        onPointerUp={
          interactive
            ? (e) => {
                const start = down.current;
                down.current = null;
                if (start) onGesture?.(gestureOf(start, at(e)));
              }
            : undefined
        }
        onPointerCancel={() => {
          down.current = null;
        }}
      />
      {webKeys && (
        // Ô nhận phím ẩn: bấm vào màn hình là focus vào đây. Phím đặc biệt và chữ gõ thẳng đi qua keydown; chữ của bộ gõ đi qua input.
        <textarea
          ref={typer}
          aria-label={`Bàn phím cho ${id}`}
          {...{ [WEB_KEYS_ATTR]: '' }}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          className="pointer-events-none absolute top-0 left-0 h-px w-px resize-none opacity-0"
          onKeyDown={(e) => {
            const a = keyAction(e, true, true);
            if (!a) return;
            e.preventDefault();
            webKeys.push(a);
          }}
          onInput={(e) => {
            if (!(e.nativeEvent as InputEvent).isComposing) takeTyped(e.currentTarget);
          }}
          onCompositionEnd={(e) => takeTyped(e.currentTarget)}
          onBlur={(e) => {
            takeTyped(e.currentTarget);
            webKeys.flush();
          }}
        />
      )}
      {(!meta || meta.error || meta.mode === 'cold') && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <p
            style={{ aspectRatio: aspect }}
            className="flex h-full max-h-full max-w-full items-center justify-center px-[10%] text-center text-[11.5px]/[16px] break-words text-white/80"
          >
            {meta?.error
              ? `Không lấy được ảnh: ${frameErrorText(meta.error)}`
              : meta?.mode === 'cold'
                ? 'Máy chưa khởi động driver. Phóng to (Enter) để khởi động và xem màn hình.'
                : 'Đang chờ ảnh màn hình…'}
          </p>
        </div>
      )}
    </div>
  );
}

/** Theo dõi ô nào đang thấy trên màn hình và báo Go chỉ chụp các ô đó (gộp thay đổi trong 120 ms). Trả hàm đăng ký phần tử. */
function useVisibleWatch(focus: string | undefined) {
  const visible = useRef(new Set<string>());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const sent = useRef('');
  const focusRef = useRef(focus);
  focusRef.current = focus;
  const disposed = useRef(false); // đã rời màn hình: ô con gỡ ra sau không được gửi thêm lệnh
  const flush = useRef(() => {
    if (disposed.current) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const hidden = document.visibilityState === 'hidden'; // cửa sổ thu nhỏ: không chụp gì
      const ids = hidden ? [] : [...visible.current].sort();
      const f = hidden ? '' : (focusRef.current ?? '');
      const key = `${ids.join(',')}|${f}`;
      if (key === sent.current) return;
      sent.current = key;
      void towerApi.liveWatch(ids, f).catch(() => undefined);
    }, 120);
  }).current;
  // Tạo khi phần tử đầu tiên đăng ký: effect của ô con chạy trước effect của hook này.
  const observer = useRef<IntersectionObserver | null>(null);
  const getObserver = () => {
    if (!observer.current && typeof IntersectionObserver !== 'undefined') {
      observer.current = new IntersectionObserver((entries) => {
        for (const en of entries) {
          const id = (en.target as HTMLElement).dataset.device ?? '';
          if (en.isIntersecting) visible.current.add(id);
          else visible.current.delete(id);
        }
        flush();
      });
    }
    return observer.current;
  };
  useEffect(() => flush(), [focus, flush]);
  useEffect(() => {
    disposed.current = false;
    document.addEventListener('visibilitychange', flush);
    return () => {
      disposed.current = true;
      document.removeEventListener('visibilitychange', flush);
      // Rời màn hình trực tiếp: dừng chụp mọi máy.
      observer.current?.disconnect();
      clearTimeout(timer.current);
      void towerApi.liveWatch([], '').catch(() => undefined);
    };
  }, [flush]);
  return useCallback(
    (el: HTMLElement | null) => {
      const obs = getObserver();
      if (!el || !obs) return undefined;
      obs.observe(el);
      return () => {
        obs.unobserve(el);
        visible.current.delete(el.dataset.device ?? '');
        flush();
      };
    },
    [], // observer và flush sống theo hook

  );
}

function Tile({ d, selected, onSelect, onOpen, watch }: { d: Device; selected: boolean; onSelect: () => void; onOpen: () => void; watch: (el: HTMLElement | null) => (() => void) | undefined }) {
  const ref = useRef<HTMLElement>(null);
  const live = d.state !== 'disconnected' && d.state !== 'unhealthy';
  useEffect(() => (live ? watch(ref.current) : undefined), [live, watch]);
  return (
    <article
      ref={ref}
      data-device={d.id}
      role="button"
      tabIndex={0}
      aria-label={deviceName(d)}
      aria-pressed={selected}
      title={deviceName(d)}
      onClick={onSelect}
      onDoubleClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          onOpen();
        } else if (e.key === ' ' || e.key === 'Spacebar') {
          e.preventDefault();
          onSelect();
        }
      }}
      className={cx('flex cursor-pointer flex-col gap-[6px] rounded-[10px] p-[8px]', selected ? 'bg-accent-soft ring-1 ring-accent' : 'bg-muted-box')}
    >
      <header className="flex items-center gap-[6px]">
        <p className="min-w-0 flex-1 truncate text-[12px]/[15px] font-semibold text-text">{deviceName(d)}</p>
        {d.held && <Hand size={12} className="shrink-0 text-accent" />}
        <StateBadge state={d.state} />
      </header>
      {live ? (
        <Screen id={d.id} className="h-[260px]" />
      ) : (
        <div className="flex h-[260px] items-center justify-center rounded-[10px] bg-surface px-[12px] text-center text-[11.5px]/[16px] text-text-3">
          {d.state === 'disconnected' ? 'Máy đã rút' : (isWebDevice(d) ? webProblemText(d) : d.problem) || 'Máy chưa dùng được'}
        </div>
      )}
    </article>
  );
}

function Toolbar({ children }: { children: ReactNode }) {
  return <div className="flex shrink-0 flex-wrap items-center gap-[8px] border-b border-divider px-[14px] py-[8px]">{children}</div>;
}

/** Máy phóng to: ảnh lớn, nút giành/trả quyền điều khiển; đang điều khiển thì chạm/vuốt trên ảnh là lệnh trên máy. */
function Enlarged({ d }: { d: Device }) {
  const { enlarge, toggleTakeover, pending, gesture } = useLive();
  const { show } = useToast();
  const held = isHeld(d);
  const web = isWebDevice(d);
  // Máy web đang giữ: phím trên màn hình đi vào trang (chữ gõ không vào nhật ký của Go).
  const keys = useMemo(() => (web && held ? createKeyBatcher((a) => towerApi.webAction(d.id, a), (e) => show(errorText(e))) : undefined), [web, held, d.id, show]);
  useEffect(() => () => keys?.cancel(), [keys]);
  const waiting = pending === d.id || d.held === 'pending';
  const rot = useRotation(d.id);
  const watch = useVisibleWatch(d.id);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => watch(box.current), [watch]);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Toolbar>
        <Button size="sm" variant="secondary" icon={<LayoutGrid size={14} />} onClick={() => enlarge(d.id)}>
          Về lưới
        </Button>
        <p className="min-w-0 flex-1 truncate text-[13px]/[17px] font-semibold text-text">
          {deviceName(d)} <span className="font-mono text-[11px] font-normal text-text-3">{d.id}</span>
        </p>
        <StateBadge state={d.state} />
        {!web && (
          <Button size="sm" variant="secondary" icon={<RotateCw size={14} />} title="Xoay màn hình 90° theo chiều kim đồng hồ (nhớ cho máy này)" onClick={() => rotateNext(d.id)}>
            Xoay{rot ? ` (${rot}°)` : ''}
          </Button>
        )}
        <Button size="sm" variant={held ? 'primary' : 'secondary'} icon={waiting ? <Loader2 size={14} className="animate-spin" /> : <Hand size={14} />} disabled={waiting} onClick={() => toggleTakeover(d.id)}>
          {waiting ? 'Đang chờ bước xong…' : held ? 'Trả máy (T)' : 'Điều khiển (T)'}
        </Button>
      </Toolbar>
      {held && (
        <p className="shrink-0 bg-accent-soft px-[14px] py-[6px] text-[12px]/[16px] text-accent-ink">
          {web
            ? 'Bấm vào màn hình rồi gõ: chữ và các phím Enter, Tab, Esc, mũi tên đi vào trang; lăn chuột để cuộn. Bấm ra ngoài màn hình rồi bấm T, hoặc bấm Trả máy, để trả máy.'
            : `${d.held === 'paused' ? 'Lượt chạy đang tạm dừng sau bước hiện tại. ' : ''}Chạm hoặc vuốt trên màn hình để thao tác trên máy; bấm T để trả máy.`}
        </p>
      )}
      <div ref={box} data-device={d.id} className="flex min-h-0 flex-1 p-[14px]">
        <Screen id={d.id} interactive={held} onGesture={(g) => gesture(d.id, g)} keys={keys} className="h-full w-full" />
      </div>
    </div>
  );
}

/** Lưới các máy (thuần theo dữ liệu, test độc lập). */
export function LiveGridView({ devices, selected, onSelect, onOpen, watch }: { devices: Device[]; selected?: string; onSelect: (id: string) => void; onOpen: (id: string) => void; watch: (el: HTMLElement | null) => (() => void) | undefined }) {
  if (devices.length === 0) return <Empty title="Chưa có máy để xem" text="Cắm điện thoại vào máy này; màn hình của từng máy sẽ hiện ở đây." />;
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-[10px] p-[14px]" data-testid="live-grid">
      {devices.map((d) => (
        <Tile key={d.id} d={d} selected={d.id === selected} onSelect={() => onSelect(d.id)} onOpen={() => onOpen(d.id)} watch={watch} />
      ))}
    </div>
  );
}

function Grid() {
  const { devices, selected, select, enlarge } = useLive();
  const watch = useVisibleWatch(undefined);
  return <LiveGridView devices={devices} selected={selected} onSelect={select} onOpen={enlarge} watch={watch} />;
}

/** Màn hình trực tiếp: lưới, hoặc một máy phóng to. */
export function LiveScreens() {
  const { devices, focus } = useLive();
  const d = focus ? devices.find((x) => x.id === focus) : undefined;
  return d ? <Enlarged key={d.id} d={d} /> : <Grid />;
}

const TABS: { view: CentreView; label: string; icon: ReactNode }[] = [
  { view: 'chat', label: 'Trò chuyện', icon: <MessageSquareText size={14} /> },
  { view: 'live', label: 'Màn hình', icon: <MonitorSmartphone size={14} /> },
];

/**
 * Khung giữa: chuyển giữa nội dung (chat hoặc trang app đang mở) và màn hình trực tiếp.
 * Tab đầu đổi nhãn theo app đang mở để không báo "Trò chuyện" khi thực ra đang xem Giám sát/Kiểm thử.
 */
export function Centre({ chat }: { chat: ReactNode }) {
  const { view, setView, devices, focus, enlarge } = useLive();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const mod = moduleOfPath(pathname);
  const tabs = TABS.map((t) => {
    if (t.view !== 'chat' || !mod) return t;
    const Icon = mod.icon;
    return { ...t, label: mod.short, icon: <Icon size={14} /> };
  });
  const online = devices.filter((d) => d.state !== 'disconnected').length;

  // Tab theo chuẩn WAI-ARIA: chỉ tab đang mở nằm trong thứ tự Tab, ←/→ đổi tab.
  const onTabKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const at = tabs.findIndex((t) => t.view === view);
    const next = tabs[(at + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
    setView(next.view);
    requestAnimationFrame(() => document.getElementById(`centre-tab-${next.view}`)?.focus());
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div role="tablist" aria-label="Khung giữa" onKeyDown={onTabKey} className="flex shrink-0 items-center gap-[4px] border-b border-divider px-[10px] py-[6px]">
        {tabs.map((t) => (
          <button
            key={t.view}
            id={`centre-tab-${t.view}`}
            type="button"
            role="tab"
            aria-selected={view === t.view}
            aria-controls="centre-panel"
            tabIndex={view === t.view ? 0 : -1}
            onClick={() => setView(t.view)}
            className={cx(
              'flex h-[28px] items-center gap-[6px] rounded-[7px] px-[10px] text-[12.5px]/[16px] font-semibold',
              view === t.view ? 'bg-accent-soft text-accent-ink' : 'text-text-2 hover:bg-muted-box',
            )}
          >
            {t.icon}
            {t.label}
            {t.view === 'live' && <span className="font-mono text-[11px]/[14px] font-normal">{online}</span>}
          </button>
        ))}
        <span className="flex-1" />
        {mod && view === 'chat' && (
          <button
            type="button"
            onClick={() => navigate('/')}
            className="flex h-[28px] items-center gap-[4px] rounded-[6px] px-[6px] text-[11.5px]/[15px] text-text-3 hover:bg-muted-box hover:text-text"
          >
            <MessageSquareText size={12} />
            Về trò chuyện
          </button>
        )}
        {view === 'live' && focus && (
          <button
            type="button"
            onClick={() => enlarge(focus)}
            className="flex h-[28px] items-center gap-[4px] rounded-[6px] px-[6px] text-[11.5px]/[15px] text-text-3 hover:bg-muted-box hover:text-text"
          >
            <Maximize2 size={12} />
            Enter: về lưới
          </button>
        )}
      </div>
      <div
        id="centre-panel"
        role="tabpanel"
        aria-labelledby={`centre-tab-${view}`}
        className={cx('flex min-h-0 flex-1 flex-col', view === 'live' ? 'overflow-auto' : 'overflow-hidden')}
      >
        {view === 'live' ? <LiveScreens /> : chat}
      </div>
    </div>
  );
}
