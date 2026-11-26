// Thao tác chờ admin công nhận (FR-016): chữ hiển thị và luồng quyết định (Công nhận / Bỏ, đều vào nhật ký).
import type { PendingOp } from './admin-api';
import { appLabel, fmtShort } from './format';
import { permCopy } from './matrix-copy';

/** Lý do chờ (mã Worker lib/authority.ts) -> câu hiển thị. Máy chủ không gửi giờ đổi quyền nên không ghi giờ đó. */
export function reasonText(reason: string): { text: string; icon: 'demoted' | 'locked' | 'device' } {
  switch (reason) {
    case 'demoted_offline':
      return { text: 'Bị hạ vai khi máy đang mất mạng', icon: 'demoted' };
    case 'locked_offline':
      return { text: 'Tài khoản bị khoá khi máy đang mất mạng', icon: 'locked' };
    case 'locked_after':
      return { text: 'Tài khoản bị khoá trước khi thao tác được đẩy lên', icon: 'locked' };
    case 'revoked_device':
      return { text: 'Máy bị thu hồi khi đang mất mạng', icon: 'device' };
    default:
      return { text: reason, icon: 'demoted' };
  }
}

/** Tên thao tác + đối tượng. Máy Windows có thể gửi kèm `label`/`object` mô tả; không có thì dùng tên quyền và app. */
export function opText(op: PendingOp['op']): { name: string; object: string } {
  const o = op ?? {};
  const name = o.label || (o.perm ? permCopy(o.perm).label : 'Thao tác');
  const object = o.object || (o.app ? appLabel(o.app) : '');
  return { name, object };
}

/** "Cũ nhất: 20/10 11:30" (theo giờ máy ghi). Rỗng khi không có dòng nào. */
export function oldestText(ops: PendingOp[]): string {
  if (!ops.length) return '';
  return `Cũ nhất: ${fmtShort(Math.min(...ops.map((p) => p.device_time)))}`;
}

export const pendingTitle = (n: number) => (n ? `${n} thao tác đang chờ` : 'Không có thao tác nào đang chờ');

export type Decision = 'accept' | 'drop';

/** Sau khi quyết định: dòng rời khỏi danh sách chờ. Lỗi already_decided (người khác vừa quyết) cũng coi là đã xong. */
export function afterDecision(list: PendingOp[], id: string): PendingOp[] {
  return list.filter((p) => p.id !== id);
}

export const isAlreadyDecided = (e: unknown) => (e as { code?: string } | null)?.code === 'already_decided';
