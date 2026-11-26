import type { ReactNode } from 'react';
import { Info, Lock, Package, RefreshCwOff, TriangleAlert } from 'lucide-react';
import { Button } from '../../components/ui';
import { cx } from '../../components/ui/cx';
import { appNo } from './format';
import type { Preflight, PreflightState } from './preflight';

const GROUP = 'stroke-in flex w-full flex-col rounded-[8px] bg-surface';
const ROW = 'flex items-center gap-[8px] px-[12px] py-[7px] shadow-[inset_0_-1px_0_var(--color-divider)]';

function Group({ icon, title, children, action }: { icon: ReactNode; title: string; children: ReactNode; action: ReactNode }) {
  return (
    <div className={GROUP}>
      <div className="flex h-[30px] items-center gap-[6px] px-[12px] py-[8px] shadow-[inset_0_-1px_0_var(--color-border)]">
        <span className="flex text-text-2">{icon}</span>
        <span className="min-w-0 flex-1 text-[11.5px] font-bold text-text">{title}</span>
      </div>
      {children}
      <div className="flex p-[8px_12px]">{action}</div>
    </div>
  );
}

const dark = (disabled: boolean, onClick?: () => void, label?: string) => (
  <Button size="sm" disabled={disabled} onClick={onClick} className={cx('!bg-text !text-white', disabled && 'opacity-40')}>
    {label}
  </Button>
);

function Lists({ data, onTransfer, onUnlock }: { data: Preflight; onTransfer?: () => void; onUnlock?: () => void }) {
  return (
    <>
      {data.lots.length > 0 && (
        <Group icon={<Package size={13} />} title={`Đang giữ ${data.lots.length} lô`} action={dark(false, onTransfer, 'Chuyển quyền giữ lô')}>
          {data.lots.map((l) => (
            <div key={l.code} className={ROW}>
              <span className="min-w-0 flex-1 font-mono text-[11.5px] text-text">{l.code}</span>
              <span className="text-[10.5px] whitespace-nowrap text-text-3">
                App {appNo(l.app)} · {l.rows} dòng
              </span>
            </div>
          ))}
        </Group>
      )}
      {data.items.length > 0 && (
        <Group icon={<Lock size={13} />} title={`Đang khoá ${data.items.length} mặt hàng`} action={dark(false, onUnlock, 'Mở khoá mặt hàng')}>
          {data.items.map((i) => (
            <div key={i.name} className={ROW}>
              <span className="min-w-0 flex-1 text-[12px] text-text">{i.name}</span>
              <span className="text-[10.5px] whitespace-nowrap text-text-3">App {appNo(i.app)}</span>
            </div>
          ))}
        </Group>
      )}
      {data.lots.length === 0 && data.items.length === 0 && <p className="text-[11.5px]/[17px] text-text-2">Không có lô đang giữ hay mặt hàng đang khoá.</p>}
      {data.pendingSync && (
        <div className="flex w-full items-center gap-[8px] rounded-[8px] bg-amber-soft px-[12px] py-[10px]">
          <RefreshCwOff size={14} className="shrink-0 text-amber" />
          <p className="min-w-0 flex-1 text-[11.5px]/[16px] font-medium text-amber">
            {data.pendingSync.count} thay đổi còn chờ đồng bộ trên máy {data.pendingSync.device} (kết nối lần cuối {data.pendingSync.lastSeen}).
          </p>
        </div>
      )}
    </>
  );
}

function Unavailable({ state, name }: { state: Extract<PreflightState, { status: 'unavailable' }>; name: string }) {
  return (
    <>
      <div className="flex w-full items-start gap-[8px] rounded-[8px] bg-surface p-[12px] stroke-in">
        <Info size={14} className="mt-px shrink-0 text-text-3" />
        <p className="min-w-0 flex-1 text-[11.5px]/[16px] text-text-2">
          {state.reason === 'web' ? 'Xem lô đang giữ trên app Windows' : `Chưa lấy được lô đang giữ và mặt hàng đang khoá của ${name} trên máy này.`}
        </p>
      </div>
      {state.reason === 'no-binding' && (
        <div className="flex gap-[8px]">
          {dark(true, undefined, 'Chuyển quyền giữ lô')}
          {dark(true, undefined, 'Mở khoá mặt hàng')}
        </div>
      )}
    </>
  );
}

function Inner({ state, name, sub, onTransfer, onUnlock }: { state: PreflightState; name: string; sub: string; onTransfer?: () => void; onUnlock?: () => void }) {
  return (
    <>
      <p className="w-full text-[11.5px]/[17px] text-text-2">{sub}</p>
      {state.status === 'ready' ? <Lists data={state.data} onTransfer={onTransfer} onUnlock={onUnlock} /> : <Unavailable state={state} name={name} />}
    </>
  );
}

interface PanelProps {
  state: PreflightState;
  name: string;
  onTransfer?: () => void;
  onUnlock?: () => void;
}

/** Cột cảnh báo bên phải hộp Sửa người dùng (fuJ5z): 379.5 rộng, nền #FFFBF3, vạch trái. Không chặn lưu. */
export function EditWarningSide({ state, name, ...rest }: PanelProps) {
  return (
    <div className="flex w-[379.5px] shrink-0 flex-col gap-[14px] bg-[#FFFBF3] p-[22px] shadow-[inset_1px_0_0_var(--color-line-amber)]">
      <div className="flex items-center gap-[8px]">
        <TriangleAlert size={16} className="text-amber" />
        <span className="text-[13px] font-bold whitespace-nowrap text-amber">Cần xử lý trước khi đổi quyền</span>
      </div>
      <Inner state={state} name={name} sub={`Cảnh báo không chặn lưu. Nếu lưu luôn, lô và mặt hàng vẫn ở tên ${name} cho tới khi chuyển.`} {...rest} />
    </div>
  );
}

/** Khung cảnh báo trong hộp Khoá tài khoản (TCvBy). Không chặn khoá. */
export function LockWarning({ state, name, ...rest }: PanelProps) {
  return (
    <div className="flex w-full flex-col gap-[14px] rounded-[10px] bg-[#FFFBF3] p-[16px] stroke-in [--stroke-c:var(--color-line-amber)]">
      <div className="flex items-center gap-[8px]">
        <TriangleAlert size={16} className="text-amber" />
        <span className="text-[13px] font-bold whitespace-nowrap text-amber">{state.status === 'ready' ? `${name} còn việc đang dở` : `Việc đang dở của ${name}`}</span>
      </div>
      <Inner state={state} name={name} sub={`Cảnh báo không chặn khoá. Lô và mặt hàng vẫn ở tên ${name} cho tới khi chuyển.`} {...rest} />
    </div>
  );
}

