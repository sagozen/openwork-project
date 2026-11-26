// Hộp chọn khi hai bản của cùng một mục khác nhau (E-005, E-025). Chưa có khung pen: dựng từ token + hộp thoại form,
// đã báo designer. Đóng mà chưa chọn: mục vẫn "Chờ giải quyết xung đột", nút duyệt/bàn giao của mục đó tắt (BR-012, E-019).
import { useEffect, useState } from 'react';
import { GitCompareArrows } from 'lucide-react';
import { useDriveSync } from '../sync/drive-sync';
import { driveApi, type DriveConflictDetail } from '../sync/drive-api';
import { driveCopy, driveErrorText, fieldText, isChanged, vnClock } from '../sync/sync-view';
import { useAction } from '../lib/use-action';
import { Banner, Button, Dialog } from './ui';
import { cx } from './ui/cx';

/** Nhãn trường theo loại mục (khoá dạng "card.ma_hs"); phân hệ tự đăng ký khi nạp. Thiếu nhãn thì hiện khoá. */
const FIELD_LABELS = new Map<string, Map<string, string>>();
export function registerFieldLabels(kind: string, fields: { key: string; label: string }[]) {
  FIELD_LABELS.set(kind, new Map(fields.map((f) => [f.key, f.label])));
}
export const fieldLabel = (kind: string, key: string) => FIELD_LABELS.get(kind)?.get(key) ?? key;

// Quy tắc phân loại (mục "rule", nội dung trải phẳng theo dấu chấm như drive/versions.go diffFields): đăng ký sẵn ở đây
// vì hộp xung đột (E-018) mở được từ bảng đồng bộ ở mọi trang, kể cả khi trang sổ quy tắc chưa tải. Tên trường nội dung
// khớp validate.go fieldLabels.
registerFieldLabels('rule', [
  { key: 'body.classify.name', label: 'Tên quy tắc' },
  { key: 'body.classify.groupId', label: 'Nhóm hàng' },
  { key: 'body.classify.features', label: 'Đặc điểm' },
  { key: 'body.classify.hs', label: 'Nhóm HS' },
  { key: 'body.classify.hsLen', label: 'Độ dài Nhóm HS' },
  { key: 'body.classify.explain', label: 'Giải thích căn cứ' },
  { key: 'body.naming.parts', label: 'Thành phần và thứ tự' },
  { key: 'body.naming.separator', label: 'Dấu phân cách' },
  { key: 'body.naming.maxLen', label: 'Giới hạn độ dài tên khai' },
  { key: 'body.naming.notes', label: 'Ghi chú cách ghi theo nhóm hàng' },
  { key: 'body.naming.colours', label: 'Màu loại khỏi tên khai' },
  { key: 'body.naming.tail', label: 'Phần cuối' },
  { key: 'body.maker.withBrand', label: 'Cách ghi khi có nhãn hiệu' },
  { key: 'body.maker.withMaker', label: 'Cách ghi khi có nhà sản xuất' },
  { key: 'body.maker.noBrand', label: 'Chữ khi thiếu nhãn hiệu' },
  { key: 'body.maker.noMaker', label: 'Chữ khi thiếu nhà sản xuất' },
  { key: 'body.maker.defaultText', label: 'Chữ mặc định' },
  { key: 'enabled', label: 'Trạng thái' },
  { key: 'no', label: 'Số quy tắc' },
  { key: 'type', label: 'Loại quy tắc' },
  { key: 'ver', label: 'Phiên bản' },
  { key: 'vid', label: 'Mã phiên bản' },
  { key: 'change', label: 'Loại thay đổi' },
  { key: 'write', label: 'Lần ghi của hệ thống' },
  { key: 'reason', label: 'Lý do' },
  { key: 'createdBy', label: 'Người tạo (mã)' },
  { key: 'createdByName', label: 'Người tạo' },
  { key: 'createdAt', label: 'Lúc tạo' },
  { key: 'editedBy', label: 'Người sửa cuối (mã)' },
  { key: 'editedByName', label: 'Người sửa cuối' },
  { key: 'editedAt', label: 'Lúc sửa cuối' },
  { key: 'flags.untested', label: 'Nhãn chưa chạy thử' },
  { key: 'flags.staleTest', label: 'Nhãn chạy thử trên bản cũ' },
  { key: 'flags.unchecked', label: 'Nhãn chưa kiểm trùng' },
  { key: 'pairs', label: 'Cặp quy tắc đã quyết' },
  { key: 'labelsAtSave', label: 'Nhãn lúc lưu' },
]);

export interface ConflictDialogViewProps {
  detail: DriveConflictDetail;
  /** Tên người dùng máy này (cột "Bản của tôi"). */
  myName?: string;
  busy?: boolean;
  /** Bản đang được chọn (nút đó hiện vòng quay). */
  resolving?: 'mine' | 'theirs' | null;
  error?: string;
  onResolve: (keepMine: boolean) => void;
  onClose: () => void;
  overlay?: boolean;
}

function SideHead({ title, who, removed }: { title: string; who: string; removed: boolean }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-[2px]">
      <span className="text-[12px]/[15px] font-bold text-text">{title}</span>
      <span className="truncate text-[11px]/[14px] text-text-3">{who}</span>
      {removed && <span className="w-fit rounded-[4px] bg-chip-neutral px-[6px] py-px text-[10px]/[13px] font-bold text-text-2">Đã gỡ</span>}
    </div>
  );
}

export function ConflictDialogView({ detail, myName, busy, resolving, error, onResolve, onClose, overlay }: ConflictDialogViewProps) {
  // Trường khác nhau lên đầu; trường giống nhau (nếu Go gửi) vẫn hiện để đối chiếu.
  const fields = [...(detail.fields ?? [])].sort((a, b) => Number(isChanged(b)) - Number(isChanged(a)));
  const theirs = [detail.theirsName || detail.theirsUser, detail.theirsDevice, detail.theirsAt ? vnClock(detail.theirsAt) : ''].filter(Boolean).join(' · ');
  const mine = [myName, `v${detail.mineRev}`].filter(Boolean).join(' · ');
  return (
    <Dialog
      width={760}
      overlay={overlay}
      tone="blue"
      icon={<GitCompareArrows size={18} />}
      title="Hai bản khác nhau"
      subtitle={detail.itemId}
      onClose={busy ? undefined : onClose}
      actions={
        <>
          <Button size="dialog" variant="secondary" disabled={busy} loading={resolving === 'theirs'} onClick={() => onResolve(false)}>
            {driveCopy('sync_take_theirs')}
          </Button>
          <Button size="dialog" disabled={busy} loading={resolving === 'mine'} onClick={() => onResolve(true)}>
            {driveCopy('sync_keep_mine')}
          </Button>
        </>
      }
    >
      <div className="stroke-in flex flex-col overflow-hidden rounded-[10px]">
        <div className="flex gap-[12px] bg-table-head px-[14px] py-[10px] shadow-[inset_0_-1px_0_var(--color-border)]">
          <span className="w-[150px] shrink-0" />
          <SideHead title="Bản của tôi" who={mine} removed={detail.mineRemoved} />
          <SideHead title="Bản kia" who={theirs} removed={detail.theirsRemoved} />
        </div>
        {fields.map((f) => {
          const diff = isChanged(f);
          return (
            <div key={f.field} data-changed={diff || undefined} className={cx('flex gap-[12px] px-[14px] py-[8px] text-[12.5px]/[17px] shadow-[inset_0_-1px_0_var(--color-divider)] last:shadow-none', diff && 'bg-amber-soft')}>
              <span className={cx('w-[150px] shrink-0 text-[11.5px]/[16px] font-semibold', diff ? 'text-amber' : 'text-text-3')}>{fieldLabel(detail.kind, f.field)}</span>
              <span className="min-w-0 flex-1 break-words">{fieldText(f.mine) || '—'}</span>
              <span className="min-w-0 flex-1 break-words">{fieldText(f.theirs) || '—'}</span>
            </div>
          );
        })}
      </div>
      {error && <Banner tone="red">{error}</Banner>}
    </Dialog>
  );
}

/** Hộp xung đột gắn dữ liệu: mở khi bấm một xung đột ở bảng đồng bộ hoặc trên thẻ. */
export function ConflictDialog({ myName }: { myName?: string }) {
  const sync = useDriveSync();
  const id = sync?.conflictId ?? null;
  const [detail, setDetail] = useState<DriveConflictDetail | null>(null);
  const [error, setError] = useState('');
  const [resolving, setResolving] = useState<'mine' | 'theirs' | null>(null);

  useEffect(() => {
    setDetail(null);
    setError('');
    if (!id) return;
    let live = true;
    driveApi.getConflict(id).then(
      (d) => live && setDetail(d),
      (e) => live && setError(driveErrorText(e)),
    );
    return () => {
      live = false;
    };
  }, [id]);

  // Chọn bản chỉ gửi một lần: hai nút dùng chung cờ, lần bấm tiếp khi đang gửi bị bỏ qua.
  const [resolve, busy] = useAction(async (keepMine: boolean) => {
    if (!sync || !id) return;
    setResolving(keepMine ? 'mine' : 'theirs');
    setError('');
    try {
      await driveApi.resolveConflict(id, keepMine);
      sync.closeConflict(keepMine ? 'mine' : 'theirs');
    } catch (e) {
      setError(driveErrorText(e));
    } finally {
      setResolving(null);
    }
  });

  if (!sync || !id) return null;
  if (!detail) {
    return error ? (
      <Dialog variant="compact" tone="red" icon={<GitCompareArrows size={18} />} title="Hai bản khác nhau" actions={<Button size="dialog" variant="secondary" onClick={() => sync.closeConflict(null)}>Đóng</Button>}>
        {error}
      </Dialog>
    ) : null;
  }

  return <ConflictDialogView detail={detail} myName={myName} busy={busy} resolving={resolving} error={error} onResolve={(k) => void resolve(k)} onClose={() => sync.closeConflict(null)} />;
}
