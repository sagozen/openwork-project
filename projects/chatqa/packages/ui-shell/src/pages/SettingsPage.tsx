import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { platform, isDesktop } from '../platform';
import { errorText, useSession } from '../lib/session';
import { isAdmin } from '../platform/roles';
import { MODULES } from '@product/modules/registry';
import { Badge, Button, Card, ErrorText, PageHeader } from '../components/ui';
import { SyncPanel } from '../components/SyncPanel';
import { NetProgress } from '../components/NetProgress';
import { PRODUCT_NAME } from '../lib/auth-ui';
import { useAction } from '../lib/use-action';

interface GoogleStatus {
  connected: boolean;
  email?: string;
  root_folder_id?: string | null;
  vipo_sheet_id?: string | null;
}

interface Device {
  id: string;
  name: string;
  app_version: string | null;
  last_seen: number;
  revoked: number;
}

const fmtDate = (unix: number) => new Date(unix * 1000).toLocaleDateString('vi-VN');

export function SettingsPage() {
  const { state, refresh } = useSession();
  const role = state?.user?.role;
  const [params] = useSearchParams();
  const [google, setGoogle] = useState<GoogleStatus | null>(null);
  // null = đang tải (chưa hiện "Chưa có máy nào" khi danh sách chưa về).
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [err, setErr] = useState(params.get('google') && params.get('google') !== 'ok' ? `Kết nối Google lỗi: ${params.get('google')}` : '');

  useEffect(() => {
    platform.api<GoogleStatus>('/v1/google/status').then(setGoogle).catch((e) => setErr(errorText(e)));
    if (isAdmin(role) || role === 'manager') {
      platform.api<Device[]>('/v1/admin/devices').then(setDevices).catch(() => setDevices([]));
    }
  }, [role]);

  const [connectGoogle, connecting] = useAction(async () => {
    try {
      const { url } = await platform.api<{ url: string }>('/v1/google/connect-url', { method: 'POST' });
      window.location.href = url;
    } catch (e) {
      setErr(errorText(e));
    }
  });

  // Một lần thu hồi một máy: đang chạy thì mọi nút Thu hồi khoá, nút vừa bấm hiện vòng quay.
  const [revoking, setRevoking] = useState<string | null>(null);
  const [revoke, revokeBusy] = useAction(async (id: string) => {
    if (!window.confirm('Thu hồi bản quyền của máy này?')) return;
    setRevoking(id);
    try {
      await platform.api(`/v1/admin/devices/${id}/revoke`, { method: 'POST' });
      setDevices((d) => d && d.map((x) => (x.id === id ? { ...x, revoked: 1 } : x)));
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setRevoking(null);
    }
  });
  const [reload, reloading] = useAction(refresh);

  const lic = state?.license;
  const v = state?.version;

  return (
    <>
      <PageHeader title="Cài đặt" />
      <div className="space-y-4">
        <ErrorText>{err}</ErrorText>

        <SyncPanel />

        <Card title="Google Drive (kho dữ liệu)">
          {google?.connected ? (
            <div className="space-y-1 text-sm">
              <p>Đã kết nối: <b>{google.email}</b></p>
              <p className="text-slate-500">Thư mục {PRODUCT_NAME}: {google.root_folder_id ? <Badge tone="green">đã khởi tạo</Badge> : <Badge tone="amber">chưa khởi tạo</Badge>}</p>
              <p className="text-slate-500">Sheet Vipo: {google.vipo_sheet_id ? <Badge tone="green">đã liên kết</Badge> : <Badge tone="amber">chưa liên kết</Badge>}</p>
            </div>
          ) : (
            <p className="text-sm text-slate-500">Chưa kết nối. Admin đăng nhập Google 1 lần để {PRODUCT_NAME} lưu dữ liệu vào Drive của công ty.</p>
          )}
          {isAdmin(role) && !isDesktop && (
            <Button className="mt-3" variant={google?.connected ? 'outline' : 'primary'} loading={connecting} onClick={() => void connectGoogle()}>
              {google?.connected ? 'Kết nối lại' : 'Kết nối Google Drive'}
            </Button>
          )}
        </Card>

        {isDesktop && lic && (
          <Card title="Bản quyền máy này">
            <dl className="grid grid-cols-[140px_1fr] gap-y-2 text-sm">
              <dt className="text-slate-500">Máy</dt><dd>{lic.deviceName}</dd>
              <dt className="text-slate-500">Hạn bản quyền</dt><dd>{fmtDate(lic.expiresAt)}</dd>
              <dt className="text-slate-500">Dùng offline đến</dt><dd>{fmtDate(lic.refreshBy)}</dd>
              <dt className="text-slate-500">Phân hệ</dt>
              <dd className="flex flex-wrap gap-1">
                {MODULES.map((a) => <Badge key={a.code} tone={lic.apps.includes(a.code) ? 'green' : 'slate'}>{a.short}</Badge>)}
              </dd>
            </dl>
          </Card>
        )}

        {(isAdmin(role) || role === 'manager') && (
          <Card title="Máy đã kích hoạt" action={<Badge>{(devices ?? []).filter((d) => !d.revoked).length} máy</Badge>}>
            <ul className="-my-2 divide-y divide-slate-100 text-sm">
              {devices?.map((d) => (
                <li key={d.id} className="flex items-center gap-3 py-2">
                  <div className="flex-1">
                    <p className="font-medium text-slate-800">{d.name}</p>
                    <p className="text-xs text-slate-500">v{d.app_version ?? '?'} · lần cuối {fmtDate(d.last_seen)}</p>
                  </div>
                  {d.revoked ? <Badge tone="red">đã thu hồi</Badge> : isAdmin(role) && <Button variant="ghost" disabled={revokeBusy} loading={revoking === d.id} onClick={() => void revoke(d.id)}>{revoking === d.id ? 'Đang thu hồi…' : 'Thu hồi'}</Button>}
                </li>
              ))}
              {devices === null && <li className="py-2 text-slate-400">Đang tải...</li>}
              {devices?.length === 0 && <li className="py-2 text-slate-400">Chưa có máy nào.</li>}
            </ul>
          </Card>
        )}

        <Card title="Phiên bản">
          <p className="text-sm text-slate-600">
            UI {v?.ui} ({v?.uiSource === 'ota' ? 'OTA' : 'gốc'}){isDesktop && <> · App {v?.bin} · Core API {v?.coreApi}</>}
          </p>
          <Button variant="ghost" className="mt-2 -ml-3" loading={reloading} onClick={() => void reload()}>Làm mới</Button>
          <NetProgress op="settings.reload" active={reloading} label="Đang tải lại thông tin máy và bản quyền" />
        </Card>
      </div>
    </>
  );
}
