// Ô 1: danh sách máy theo "tower:fleet", lọc theo ô tìm, ảo hoá (chỉ vẽ các hàng đang thấy). Bấm chọn máy;
// bấm đúp hoặc Enter phóng to ở khung giữa; T giành quyền điều khiển máy đang chọn.
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useNavigate } from 'react-router';
import { Battery, Globe, Hand, Search, Settings, Smartphone } from 'lucide-react';
import { Button } from '@shell/components/ui';
import { cx } from '@shell/components/ui/cx';
import { useSession } from '@shell/lib/session';
import { isAdmin } from '@shell/platform/roles';
import { StateBadge } from '../chat/components/shared';
import { Empty } from '../workspace/Workspace';
import { deviceName, isWebDevice, isWebSetupProblem, TEST_SETTINGS_PATH, towerApi, webProblemText, webSubtitle, type Device } from './bridge';
import { windowRange } from './input';
import { useLive } from './LiveProvider';

export const ROW_HEIGHT = 52;

/** Lọc theo ID, tên, model, hệ điều hành; không phân biệt hoa thường. */
export function filterDevices(devices: Device[], q: string): Device[] {
  const s = q.trim().toLowerCase();
  if (!s) return devices;
  return devices.filter((d) => [d.id, d.name, d.model, d.platform, d.osVersion].some((v) => v?.toLowerCase().includes(s)));
}

const HELD_LABEL: Record<string, string> = { pending: 'Đang chờ bước xong', held: 'Bạn đang điều khiển', paused: 'Bạn đang điều khiển' };

/** Dòng phụ của một máy: điện thoại "nền tảng phiên bản", máy web "trình duyệt · WxH · host"; có vấn đề thì câu vấn đề. */
export function deviceSubtitle(d: Device, baseURL?: string): string {
  if (isWebDevice(d)) return d.problem ? webProblemText(d) : webSubtitle(d, baseURL);
  return d.problem || `${d.platform} ${d.osVersion ?? ''}`;
}

/** Nút mở Cài đặt › Kiểm thử (cài bộ chạy trình duyệt, Edge/Chrome) cho máy web chưa dùng được. */
export function WebSetupLink({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="flex shrink-0 items-center gap-[3px] text-[11px]/[14px] font-semibold text-accent"
    >
      <Settings size={11} />
      Cài đặt
    </button>
  );
}

/** Mở Cài đặt › Kiểm thử; undefined khi người dùng không phải Admin (không vào được Cài đặt). */
export function useOpenTestSettings(): (() => void) | undefined {
  const navigate = useNavigate();
  const { state } = useSession();
  const open = useCallback(() => void navigate(TEST_SETTINGS_PATH), [navigate]);
  return isAdmin(state?.user?.role) ? open : undefined;
}

function Row({
  d,
  selected,
  tabIndex,
  onSelect,
  onOpen,
  onKeyDown,
  rowRef,
  baseURL,
  onSettings,
}: {
  d: Device;
  selected: boolean;
  tabIndex: number;
  onSelect: () => void;
  onOpen: () => void;
  onKeyDown: (e: ReactKeyboardEvent<HTMLLIElement>) => void;
  rowRef: (el: HTMLLIElement | null) => void;
  baseURL?: string;
  onSettings?: () => void;
}) {
  const sub = d.held ? HELD_LABEL[d.held] : deviceSubtitle(d, baseURL);
  const Icon = isWebDevice(d) ? Globe : Smartphone;
  return (
    <li
      ref={rowRef}
      role="option"
      aria-selected={selected}
      tabIndex={tabIndex}
      data-device-row={d.id}
      onClick={onSelect}
      onDoubleClick={onOpen}
      onKeyDown={onKeyDown}
      style={{ height: ROW_HEIGHT }}
      className={cx(
        'flex cursor-pointer items-center gap-[8px] rounded-[8px] px-[10px]',
        selected ? 'bg-accent-soft' : 'hover:bg-muted-box',
        d.state === 'disconnected' && 'opacity-60',
      )}
    >
      <Icon size={14} className={cx('shrink-0', selected ? 'text-accent' : 'text-text-3')} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[12.5px]/[16px] font-semibold text-text" title={deviceName(d)}>
          {deviceName(d)}
        </p>
        <p className="truncate font-mono text-[10.5px]/[14px] text-text-3" title={sub}>
          {sub}
        </p>
      </div>
      {onSettings && !d.held && isWebSetupProblem(d) && <WebSetupLink onClick={onSettings} />}
      {d.held ? (
        <Hand size={13} className="shrink-0 text-accent" aria-label={HELD_LABEL[d.held]} />
      ) : (
        d.battery !== undefined &&
        d.battery >= 0 && (
          <span className="flex shrink-0 items-center gap-[2px] font-mono text-[10.5px]/[14px] text-text-3">
            <Battery size={11} />
            {d.battery}%
          </span>
        )
      )}
      <StateBadge state={d.state} />
    </li>
  );
}

export interface DeviceListViewProps {
  devices: Device[];
  selected?: string;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
  readOnly?: boolean;
  /** baseURL theo mã hồ sơ trình duyệt (dòng phụ của máy web hiện host). */
  baseURLs?: Record<string, string>;
  /** Mở Cài đặt › Kiểm thử từ máy web chưa dùng được; không có = không hiện nút. */
  onSettings?: () => void;
}

/** Danh sách thuần (render và test độc lập). */
export function DeviceListView({ devices, selected, onSelect, onOpen, readOnly, baseURLs, onSettings }: DeviceListViewProps) {
  const [q, setQ] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState(0);
  const [viewport, setViewport] = useState(640);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setViewport(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const list = filterDevices(devices, q);
  const [first, last] = windowRange(scroll, viewport, ROW_HEIGHT, list.length);
  const rows = useRef(new Map<string, HTMLLIElement>());
  const activeId = selected && list.some((d) => d.id === selected) ? selected : list[0]?.id;
  // Hai nhịp: nhịp đầu để React vẽ lại cửa sổ hàng sau khi cuộn, nhịp sau mới focus hàng vừa chọn.
  const focusRow = (id: string) => requestAnimationFrame(() => requestAnimationFrame(() => rows.current.get(id)?.focus()));

  // Bàn phím: ↑↓/Home/End chọn máy kế tiếp, Space chọn máy đang focus. Enter phóng to do phím tắt chung của màn lo.
  const onRowKey = (e: ReactKeyboardEvent<HTMLLIElement>, id: string) => {
    if (e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      onSelect(id);
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    const at = list.findIndex((d) => d.id === id);
    if (at < 0) return;
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : Math.min(list.length - 1, Math.max(0, at + (e.key === 'ArrowDown' ? 1 : -1)));
    const target = list[next];
    if (!target) return;
    e.preventDefault();
    // Cuộn đủ để hàng đích được ảo hoá vẽ ra (End/nhảy xa), rồi mới chuyển focus.
    const view = box.current;
    if (view) {
      const top = next * ROW_HEIGHT;
      if (top < view.scrollTop) view.scrollTop = top;
      else if (top + ROW_HEIGHT > view.scrollTop + view.clientHeight) view.scrollTop = top + ROW_HEIGHT - view.clientHeight;
    }
    onSelect(target.id);
    focusRow(target.id);
  };

  return (
    <>
      <div className="shrink-0 p-[10px]">
        <label className="stroke-in flex h-[32px] items-center gap-[8px] rounded-[8px] bg-surface px-[10px] focus-within:[--stroke-c:var(--color-accent)]">
          <Search size={14} className="shrink-0 text-text-3" />
          <input
            type="search"
            aria-label="Tìm máy"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Tìm máy, hệ điều hành…"
            className="min-w-0 flex-1 bg-transparent text-[12.5px]/[16px] outline-none placeholder:text-text-3"
          />
        </label>
      </div>
      {devices.length === 0 ? (
        <Empty
          title="Chưa có máy nào kết nối"
          text={readOnly ? 'Điện thoại cắm vào các máy tính chạy ChatQASoftware của công ty sẽ hiện ở đây.' : 'Cắm điện thoại Android (bật gỡ lỗi USB) hoặc iPhone vào máy này, máy sẽ hiện ở đây.'}
          action={
            !readOnly && onSettings ? (
              <Button size="sm" variant="secondary" onClick={onSettings}>
                Mở Cài đặt › Kiểm thử
              </Button>
            ) : undefined
          }
        />
      ) : list.length === 0 ? (
        <Empty title="Không có máy khớp" text={`Không máy nào khớp “${q}”.`} />
      ) : (
        <div ref={box} className="min-h-0 flex-1 overflow-y-auto px-[6px] pb-[8px]" onScroll={(e) => setScroll(e.currentTarget.scrollTop)}>
          {/* Chiều cao đủ cho mọi hàng (thanh cuộn đúng), đệm trên thay cho các hàng phía trên không vẽ */}
          <ul role="listbox" aria-label="Danh sách máy" style={{ height: list.length * ROW_HEIGHT, paddingTop: first * ROW_HEIGHT }}>
            {list.slice(first, last).map((d) => (
              <Row
                key={d.id}
                d={d}
                selected={d.id === selected}
                tabIndex={d.id === activeId ? 0 : -1}
                onSelect={() => onSelect(d.id)}
                onOpen={() => onOpen(d.id)}
                onKeyDown={(e) => onRowKey(e, d.id)}
                rowRef={(el) => {
                  if (el) rows.current.set(d.id, el);
                  else rows.current.delete(d.id);
                }}
                baseURL={baseURLs?.[d.id]}
                onSettings={onSettings}
              />
            ))}
          </ul>
        </div>
      )}
      {!readOnly && devices.length > 0 && (
        <p className="shrink-0 border-t border-divider px-[12px] py-[7px] text-[11px]/[14px] text-text-3">
          <kbd className="font-mono">↑↓</kbd> chọn · <kbd className="font-mono">Enter</kbd> phóng to · <kbd className="font-mono">T</kbd> điều khiển ·{' '}
          <kbd className="font-mono">Esc</kbd> dừng tất cả
        </p>
      )}
    </>
  );
}

/** baseURL của các hồ sơ trình duyệt, đọc lại khi danh sách máy web đổi (thêm, xoá, đổi tên, đổi trình duyệt/viewport). */
function useBaseURLs(devices: Device[]): Record<string, string> {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const key = devices
    .filter(isWebDevice)
    .map((d) => `${d.id}|${d.name ?? ''}|${d.model ?? ''}`)
    .join(',');
  useEffect(() => {
    if (!key) return;
    let alive = true;
    towerApi.browserProfiles().then(
      (list) => alive && setUrls(Object.fromEntries(list.map((p) => [p.id, p.baseURL]))),
      () => undefined, // core cũ chưa có hồ sơ trình duyệt: dòng phụ không có host
    );
    return () => {
      alive = false;
    };
  }, [key]);
  return urls;
}

/** Ô 1 nối với tháp. */
export function DeviceList() {
  const { devices, selected, select, enlarge } = useLive();
  const baseURLs = useBaseURLs(devices);
  const onSettings = useOpenTestSettings();
  return <DeviceListView devices={devices} selected={selected} onSelect={select} onOpen={enlarge} baseURLs={baseURLs} onSettings={onSettings} />;
}
