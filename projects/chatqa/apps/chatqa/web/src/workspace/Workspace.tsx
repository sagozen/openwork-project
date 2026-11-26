// Màn làm việc ChatQASoftware: 4 ô theo thiết kế tối giản của tài liệu sản phẩm + thanh trạng thái dưới cùng.
//   ô 1  danh sách máy, ô tìm ⌘K        ô 2  khung giữa (xem trực tiếp / kết quả chat), rộng hơn nửa cửa sổ
//   ô 3  hoạt động (task, lượt gửi)     ô 4  số đo, chỉ xem
// Không có trang cài đặt riêng: dịch vụ AI nằm ở khu Quản trị dùng chung. Thành phần thuần (không đọc phiên) để render và test độc lập.
import { useEffect, useRef, type ReactNode } from 'react';
import { BarChart3, ListChecks, MessageSquareText, Search, Smartphone, Sparkles } from 'lucide-react';
import { cx } from '@shell/components/ui/cx';

export interface WorkspaceProps {
  /** Nội dung khung giữa (route con); mặc định là màn mời gõ lệnh. */
  centre?: ReactNode;
  /** Số máy đang kết nối (0 đến khi có phần đọc máy cục bộ). */
  devices: number;
  /** Tổng số máy trong danh sách (kể cả máy đã rút); mặc định bằng số máy đang kết nối. */
  deviceTotal?: number;
  /** Ngân sách LLM còn lại đã định dạng; undefined = chưa nối với Worker. */
  budgetLeft?: string;
  /** Bản web/điện thoại: chỉ xem, không có thanh lệnh. */
  readOnly?: boolean;
  /** Thêm vào cuối thanh trạng thái (vd nút Quản trị cho Admin). */
  statusExtra?: ReactNode;
  /** Nội dung ô 4 (số đo, chỉ xem); mặc định là trạng thái trống. */
  metrics?: ReactNode;
  /** Thanh lệnh chat (desktop); có thì ⌘K mở thanh lệnh thay vì ô tìm máy. Không có: thanh lệnh tắt như trước. */
  commandBar?: ReactNode;
  /** Nội dung ô 1 (danh sách máy nối với tháp, có ô tìm riêng); mặc định là ô tìm và trạng thái trống. */
  deviceList?: ReactNode;
  /** Nội dung ô 3 (task, cảnh báo, lượt gửi); mặc định là trạng thái trống. */
  activity?: ReactNode;
}

/** Nhãn phím tắt tìm máy theo hệ điều hành (render phía máy chủ / test: ⌘K). */
export function searchShortcut(platform = typeof navigator === 'undefined' ? 'Mac' : navigator.platform): string {
  return /mac|iphone|ipad/i.test(platform) ? '⌘K' : 'Ctrl K';
}

function Pane({ title, icon, aside, className, children, label }: { title: string; icon: ReactNode; aside?: ReactNode; className?: string; children: ReactNode; label: string }) {
  return (
    <section aria-label={label} className={cx('stroke-in flex min-h-0 flex-col overflow-hidden rounded-[12px] bg-surface', className)}>
      <header className="flex h-[44px] shrink-0 items-center gap-[8px] border-b border-divider px-[14px]">
        <span className="flex shrink-0 text-text-3">{icon}</span>
        <h2 className="min-w-0 flex-1 truncate text-[13px]/[16px] font-semibold text-text">{title}</h2>
        {aside}
      </header>
      {children}
    </section>
  );
}

/** Trạng thái trống của một ô (dùng lại ở ô số đo khi chưa có lượt chạy). */
export function Empty({ title, text, action }: { title: string; text: string; action?: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-[6px] px-[16px] py-[24px] text-center">
      <p className="text-[13px]/[17px] font-semibold text-text-2">{title}</p>
      <p className="max-w-[260px] text-[12px]/[17px] text-text-3">{text}</p>
      {action && <div className="mt-[2px]">{action}</div>}
    </div>
  );
}

const chip = 'rounded-[5px] bg-chip-neutral px-[6px] py-px text-[10.5px]/[14px] font-semibold text-text-2';

/** Câu mẫu bấm được ở màn mời gõ lệnh: bắt đầu từ việc có ích thay vì màn trống. */
const EXAMPLES = ['Chạy flow đăng nhập trên 3 máy, báo p95', 'Dừng tất cả'];

/** Màn mời gõ lệnh ở khung giữa khi chưa mở gì. onExample: gửi luôn câu mẫu (chat), không có thì chỉ hướng dẫn. */
export function CentreEmpty({ readOnly, onExample, busy }: { readOnly?: boolean; onExample?: (text: string) => void; busy?: boolean }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-[10px] px-[24px] py-[32px] text-center">
      <span className="flex h-[44px] w-[44px] items-center justify-center rounded-[12px] bg-accent-soft text-accent">
        <MessageSquareText size={22} />
      </span>
      <p className="text-[16px]/[21px] font-semibold text-text">{readOnly ? 'Chưa có lượt chạy nào' : 'Gõ một câu để bắt đầu'}</p>
      <p className="max-w-[440px] text-[12.5px]/[18px] text-text-3">
        {readOnly
          ? 'Kết quả chạy trên các máy của công ty sẽ hiện ở đây, chỉ xem.'
          : 'Ví dụ: “chạy flow đăng nhập trên 3 máy, báo p95”. Máy test chạy, kết quả hiện thành thẻ ngay tại đây.'}
      </p>
      {!readOnly && onExample && (
        <div className="mt-[2px] flex flex-wrap items-center justify-center gap-[8px]">
          {EXAMPLES.map((text) => (
            <button
              key={text}
              type="button"
              disabled={busy}
              onClick={() => onExample(text)}
              className="flex h-[30px] items-center gap-[6px] rounded-full bg-muted-box px-[12px] text-[12px]/[16px] font-medium text-text-2 hover:bg-accent-soft hover:text-accent-ink disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Sparkles size={12} className="shrink-0" />
              {text}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function Workspace({ centre, devices, deviceTotal, budgetLeft, readOnly, statusExtra, metrics, commandBar, deviceList, activity }: WorkspaceProps) {
  const search = useRef<HTMLInputElement>(null);
  const shortcut = searchShortcut();

  // ⌘K / Ctrl K: nhảy tới ô tìm máy (khi chưa có thanh lệnh chat, thanh lệnh tự giữ phím này).
  useEffect(() => {
    if (commandBar || deviceList) return;
    const on = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        search.current?.focus();
      }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [commandBar, deviceList]);

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col gap-[12px]" data-testid="cqs-workspace">
      {/* Máy tính bảng: 2 cột (máy + khung giữa, rồi hoạt động + số đo). Từ lg: đúng 4 ô như thiết kế. */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-[12px] overflow-y-auto md:grid-cols-2 lg:grid-cols-[minmax(200px,18%)_minmax(0,1fr)_minmax(240px,24%)] lg:grid-rows-2 lg:overflow-hidden">
        <Pane label="Thiết bị" title="Thiết bị" icon={<Smartphone size={15} />} aside={<span className={chip}>{deviceTotal ?? devices}</span>} className="min-h-[220px] lg:row-span-2">
          {deviceList ?? (
            <>
              <div className="p-[10px]">
                <label className="stroke-in flex h-[32px] items-center gap-[8px] rounded-[8px] bg-surface px-[10px] focus-within:[--stroke-c:var(--color-accent)]">
                  <Search size={14} className="shrink-0 text-text-3" />
                  <input ref={search} type="search" aria-label="Tìm máy" placeholder="Tìm máy, hệ điều hành…" className="min-w-0 flex-1 bg-transparent text-[12.5px]/[16px] outline-none placeholder:text-text-3" />
                  {!commandBar && <kbd className="shrink-0 font-mono text-[10.5px]/[14px] text-text-3">{shortcut}</kbd>}
                </label>
              </div>
              <Empty
                title="Chưa có máy nào kết nối"
                text={readOnly ? 'Điện thoại cắm vào các máy tính chạy ChatQASoftware của công ty sẽ hiện ở đây.' : 'Cắm điện thoại Android (bật gỡ lỗi USB) hoặc iPhone vào máy này, máy sẽ hiện ở đây.'}
              />
            </>
          )}
        </Pane>

        <section aria-label="Khung chính" className="stroke-in flex min-h-[320px] flex-col overflow-hidden rounded-[12px] bg-surface lg:row-span-2">
          <div className="flex min-h-0 flex-1 flex-col overflow-auto">{centre ?? <CentreEmpty readOnly={readOnly} />}</div>
          {!readOnly && commandBar && <div className="shrink-0 border-t border-divider p-[12px]">{commandBar}</div>}
          {!readOnly && !commandBar && (
            <div className="shrink-0 border-t border-divider p-[12px]">
              <label className="stroke-in flex h-[40px] items-center gap-[10px] rounded-[10px] bg-muted-box px-[12px]">
                <MessageSquareText size={16} className="shrink-0 text-text-3" />
                <input disabled aria-label="Lệnh cho ChatQASoftware" placeholder="Gõ lệnh cho ChatQASoftware…" className="min-w-0 flex-1 bg-transparent text-[13px]/[16px] outline-none placeholder:text-text-3 disabled:cursor-not-allowed" />
              </label>
              <p className="mt-[6px] text-[11px]/[14px] text-text-3">Chat sẽ bật khi phần điều phối và kiểm thử sẵn sàng.</p>
            </div>
          )}
        </section>

        <Pane label="Hoạt động" title="Hoạt động" icon={<ListChecks size={15} />} className="min-h-[160px]">
          {activity ?? <Empty title="Chưa có hoạt động" text="Task đang chạy, lượt gửi webhook và báo cáo sẽ hiện ở đây." />}
        </Pane>

        <Pane label="Số đo" title="Số đo" icon={<BarChart3 size={15} />} aside={<span className={chip}>Chỉ xem</span>} className="min-h-[160px]">
          {metrics ?? <Empty title="Chưa có số đo" text="p50, p95, tỉ lệ đạt theo từng máy sẽ hiện sau lượt chạy đầu tiên." />}
        </Pane>
      </div>

      <footer aria-label="Trạng thái" className="stroke-in flex min-h-[32px] shrink-0 flex-wrap items-center gap-x-[16px] gap-y-[4px] rounded-[8px] bg-surface px-[12px] py-[6px] text-[12px]/[15px] text-text-2">
        <span className="flex items-center gap-[6px]">
          <span className={cx('h-[7px] w-[7px] rounded-full', devices > 0 ? 'bg-green' : 'bg-text-3')} />
          <span>
            <b className="font-mono font-semibold text-text">{devices}</b> máy đang kết nối
          </span>
        </span>
        <span title={budgetLeft === undefined ? 'Chưa nối ngân sách LLM với máy chủ' : undefined}>
          Ngân sách LLM còn: <b className="font-mono font-semibold text-text">{budgetLeft ?? '—'}</b>
        </span>
        <span className="min-w-0 flex-1" />
        {statusExtra}
      </footer>
    </div>
  );
}
