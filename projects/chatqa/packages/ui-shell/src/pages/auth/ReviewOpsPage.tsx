import { useCallback, useEffect, useState } from 'react';
import { platform, type ReviewOp } from '../../platform';
import { errorText, useSession } from '../../lib/session';
import { opLabel, reviewOpText } from '../../lib/auth-ui';
import { Button } from '../../components/ui';
import { useAction } from '../../lib/use-action';
import { ReconnectPanel, type NoticeItem } from '../../components/overlays/dialogs';

/** Danh sách cục bộ các thao tác không được công nhận hoặc đang chờ admin xem (E-018). Bỏ thao tác đã xem bằng "Đã xem" (DismissRejected). */
export function ReviewOpsPage() {
  const { state, refresh } = useSession();
  const [ops, setOps] = useState<ReviewOp[] | null>(null);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try {
      setOps((await platform.listReviewOps?.()) ?? []);
      setErr('');
    } catch (e) {
      setErr(errorText(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  // Một lần chỉ bỏ một thao tác: đang chạy thì mọi nút "Đã xem" khoá, nút vừa bấm hiện vòng quay.
  const [dismissing, setDismissing] = useState<string | null>(null);
  const [dismiss, busy] = useAction(async (id: string) => {
    setDismissing(id);
    try {
      await platform.dismissRejected?.(id);
      await Promise.all([load(), refresh()]);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setDismissing(null);
    }
  });

  const me = state?.user;
  const items: NoticeItem[] = (ops ?? []).map((o) => ({
    key: o.id,
    kind: o.status,
    text: reviewOpText(o, o.actorUserId === me?.id ? me.name : 'một tài khoản khác', opLabel(o)),
    action:
      o.status === 'rejected' ? (
        <Button variant="secondary" size="sm" disabled={busy} loading={busy && dismissing === o.id} onClick={() => void dismiss(o.id)}>
          Đã xem
        </Button>
      ) : undefined,
  }));

  return (
    <div className="mx-auto flex max-w-[860px] flex-col gap-[16px]">
      <div className="flex flex-col gap-[4px]">
        <h1 className="text-[24px]/[30px] font-bold tracking-[-0.4px] text-text">Thao tác chờ công nhận</h1>
        <p className="text-[12px]/[15px] text-text-3">Thao tác không được công nhận vì không đủ quyền, hoặc đang chờ admin xem vì tài khoản bị đổi quyền khi máy mất mạng.</p>
      </div>
      {err && <p className="text-[12.5px]/[18px] font-medium text-red">{err}</p>}
      {ops === null && !err && <p className="text-[13px]/[16px] text-text-3">Đang tải...</p>}
      {ops && ops.length === 0 && <p className="rounded-[12px] bg-surface px-[16px] py-[14px] text-[13px]/[16px] text-text-2 shadow-card">Không có thao tác nào đang chờ.</p>}
      {items.length > 0 && <ReconnectPanel title={`${items.length} thao tác cần xem`} items={items} />}
    </div>
  );
}
