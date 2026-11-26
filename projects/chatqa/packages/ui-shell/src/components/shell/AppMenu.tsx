// Chọn app (FR-014, khung GxQIx): lưới ô app ở màn chọn, hàng tab trên thanh tiêu đề (đổi bằng một lần bấm) và bảng
// "Đổi app" cho sản phẩm không có hàng tab. Cả ba dùng cùng trạng thái app từ Go.
import type { ReactNode } from 'react';
import { ArrowRight, ClipboardCheck, GraduationCap, Layers, Lock, PowerOff, ScanSearch, Truck, type LucideIcon } from 'lucide-react';
import { appNo, moduleByCode } from '@product/modules/registry';
import type { AppCode, AppItem } from '../../platform/types';
import { cx } from '../ui/cx';

// Ba bảng dưới theo khung pen của HS Desk. Sản phẩm khác không có dòng ở đây thì dùng icon, mô tả trong danh mục phân hệ của nó (@product).

/** Icon của từng app theo pen (scan-search, layers, clipboard-check, graduation-cap). */
const APP_ICON: Partial<Record<string, LucideIcon>> = { quote: ScanSearch, lot: Layers, check: ClipboardCheck, teach: GraduationCap, cnroad: Truck };

/** Icon của app: theo pen nếu có, không thì icon trong danh mục phân hệ của sản phẩm. */
export const appIcon = (code: AppCode): LucideIcon => APP_ICON[code] ?? moduleByCode(code).icon;

/** Màu ô icon khi app dùng được (pen: Báo giá cam, Kiểm tra xanh lá; Gộp lô và Sổ dạy AI theo màu nhận diện app còn lại). */
const APP_TILE: Partial<Record<string, string>> = { quote: 'bg-accent', lot: 'bg-blue', check: 'bg-green', teach: 'bg-ai', cnroad: 'bg-amber' };

/** Mô tả ngắn trên ô (pen GxQIx); app chưa có câu riêng dùng mô tả trong danh mục. */
const DESC: Partial<Record<string, string>> = {
  quote: 'Yêu cầu báo giá, AI phân tích, trao đổi với Vipo',
  lot: 'Gộp dòng, tiêu chí gộp và đối soát lô',
  check: 'Kiểm tra trước khai báo, xuất ECUS và C/O',
  teach: 'Bài học, cặp mã dễ nhầm, dữ liệu lịch sử',
};

export interface AppMenuProps {
  items: AppItem[];
  /** Mã app đang mở (làm nổi trong danh sách Đổi app). */
  active?: AppCode;
  onPick: (item: AppItem) => void;
}

const FOOT: Record<AppItem['state'], { text: string; icon: ReactNode; cls: string }> = {
  activated: { text: 'Mở app', icon: <ArrowRight size={13} />, cls: 'text-accent' },
  not_granted: { text: 'Chưa được cấp', icon: <Lock size={13} />, cls: 'text-text-2' },
  not_activated: { text: 'Công ty chưa mua', icon: <PowerOff size={13} />, cls: 'text-text-3' },
  license_disabled: { text: 'Đã tắt khỏi bản quyền', icon: <PowerOff size={13} />, cls: 'text-text-3' },
};

function Tile({ item, onPick }: { item: AppItem; onPick: (i: AppItem) => void }) {
  const Icon = appIcon(item.code);
  const m = moduleByCode(item.code);
  const on = item.state === 'activated';
  const dim = item.state === 'not_activated' || item.state === 'license_disabled';
  const foot = FOOT[item.state];
  return (
    <button
      type="button"
      onClick={() => onPick(item)}
      className={cx(
        'stroke-in flex h-[220px] min-w-0 flex-1 flex-col gap-[10px] rounded-[14px] p-[20px] text-left leading-[normal]',
        on && 'bg-surface shadow-card hover:brightness-[0.99]',
        item.state === 'not_granted' && 'bg-surface',
        dim && 'bg-table-head opacity-60 [--stroke-c:#D9DCE3]',
      )}
    >
      <span className="flex w-full items-start justify-between">
        <span className={cx('flex h-[44px] w-[44px] items-center justify-center rounded-[12px]', on ? `${APP_TILE[item.code] ?? 'bg-accent'} text-white` : 'bg-border text-text-2')}>
          <Icon size={22} />
        </span>
        {item.state === 'not_granted' && (
          <span className="flex h-[30px] w-[30px] items-center justify-center rounded-full bg-chip-neutral text-text-2">
            <Lock size={15} />
          </span>
        )}
        {dim && <span className="rounded-[6px] bg-border px-[8px] py-[3px] text-[10px]/[13px] font-bold text-text-2">{item.state === 'license_disabled' ? 'Đã tắt' : 'Chưa kích hoạt'}</span>}
      </span>
      <span className="font-mono text-[10px]/[13px] font-bold tracking-[1px] text-text-3 uppercase">App {String(m.no).padStart(2, '0')}</span>
      <span className={cx('text-[18px]/[23px] font-bold', on ? 'text-text' : 'text-text-2')}>{item.name}</span>
      <span className="w-full text-[12px]/[17px] text-text-3">{DESC[item.code] ?? m.summary}</span>
      <span className="min-h-0 flex-1" />
      <span className={cx('flex items-center gap-[6px] text-[12px]/[15px] font-semibold', foot.cls)}>
        {foot.text}
        {foot.icon}
      </span>
    </button>
  );
}

/** Lưới ô app ở màn chọn: đủ 3 trạng thái (dùng được, ổ khoá, mờ "Chưa kích hoạt") + app bị tắt khỏi bản quyền. */
export function AppTiles({ items, onPick }: AppMenuProps) {
  return (
    <div className="flex w-full gap-[16px]">
      {items.map((i) => (
        <Tile key={i.code} item={i} onPick={onPick} />
      ))}
    </div>
  );
}

/** Một dòng app trong bảng "Đổi app" nổi ở thanh tiêu đề (sản phẩm không có hàng tab). */
function AppRow({ item, here, onPick, role }: { item: AppItem; here: boolean; onPick: (i: AppItem) => void; role?: 'menuitem' }) {
  const Icon = appIcon(item.code);
  const dim = item.state === 'not_activated' || item.state === 'license_disabled';
  return (
    <button
      type="button"
      role={role}
      onClick={() => onPick(item)}
      className={cx('flex h-[36px] w-full items-center gap-[10px] rounded-[8px] px-[10px] text-left text-[12px]/[15px]', here ? 'bg-sidebar-hover font-semibold text-white' : 'text-chrome-text hover:bg-sidebar-hover/60', dim && 'opacity-45')}
    >
      <Icon size={16} className={here ? 'text-accent' : 'text-chrome-icon'} />
      <span className="min-w-0 flex-1 truncate">
        {appNo(moduleByCode(item.code))} · {item.name}
      </span>
      {item.state === 'not_granted' && <Lock size={13} className="text-chrome-icon" />}
      {dim && <span className="rounded-[4px] bg-[#2A2D35] px-[5px] py-[2px] text-[9px]/[12px] font-semibold text-chrome-icon">Chưa kích hoạt</span>}
    </button>
  );
}

/**
 * Hàng app trên thanh tiêu đề (nav): mỗi app một tab, thấy đủ và bấm một lần là chuyển. App đang mở làm nổi,
 * app chưa được cấp có ổ khoá, app công ty chưa mua bị mờ. Tên đầy đủ và trạng thái nằm ở tooltip.
 */
export function AppTabs({ items, active, onPick }: AppMenuProps) {
  return (
    <div className="flex shrink-0 items-center gap-[4px]" role="navigation" aria-label="Đổi app">
      {items.map((i) => {
        const Icon = appIcon(i.code);
        const here = i.code === active;
        const dim = i.state === 'not_activated' || i.state === 'license_disabled';
        const note = dim ? ' · Chưa kích hoạt' : i.state === 'not_granted' ? ' · Chưa được cấp' : '';
        return (
          <button
            key={i.code}
            type="button"
            aria-current={here ? 'page' : undefined}
            title={`${i.name}${note}`}
            onClick={() => onPick(i)}
            className={cx(
              'flex h-[28px] shrink-0 items-center gap-[6px] rounded-[7px] px-[8px] text-[12px]/[15px]',
              here ? 'bg-sidebar-hover font-semibold text-white' : 'text-chrome-text hover:bg-sidebar-hover/60',
              dim && 'opacity-45',
            )}
          >
            <Icon size={14} className={cx('shrink-0', here ? 'text-accent' : 'text-chrome-icon')} />
            {/* Cửa sổ hẹp: chỉ còn icon, tên app ở tooltip; đủ rộng mới hiện chữ để không đè lên ô tìm kiếm. */}
            <span className="hidden truncate min-[1180px]:inline">{moduleByCode(i.code).short}</span>
            {i.state === 'not_granted' && <Lock size={11} className="shrink-0 text-chrome-icon" />}
          </button>
        );
      })}
    </div>
  );
}

/** Danh sách "Đổi app" (nền tối 280): mỗi dòng 36, ổ khoá nếu chưa được cấp, nhãn nhỏ nếu chưa kích hoạt. */
export function AppSwitcherList({ items, active, onPick, className }: AppMenuProps & { className?: string }) {
  return (
    <div role="menu" className={cx('flex w-[280px] flex-col gap-[4px] rounded-[12px] bg-sidebar px-[12px] py-[14px] leading-[normal]', className)}>
      <div className="px-[10px] pb-[2px] text-[10px]/[13px] font-semibold tracking-[1.2px] text-sidebar-section uppercase">Đổi app</div>
      {items.map((i) => (
        <AppRow key={i.code} item={i} here={i.code === active} onPick={onPick} role="menuitem" />
      ))}
    </div>
  );
}
