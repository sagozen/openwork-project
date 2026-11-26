// Khối "Đồng bộ nhóm (S3/MinIO)" của Cài đặt › Kiểm thử: endpoint, bucket, region, path-style, TLS, prefix chỉ đọc theo tổ chức,
// hai khoá S3 chỉ ghi (lưu xong chỉ còn "đã lưu" + "Xoá khoá", giá trị không bao giờ hiện lại), "Thử kết nối" và công tắc tự
// chia sẻ evidence mọi lượt. Ghi cần quyền cqs.credentials; thiếu quyền thì chỉ xem.
import { useCallback, useEffect, useState } from 'react';
import { KeyRound, PlugZap, Trash2 } from 'lucide-react';
import { Button, Checkbox, Input, Toggle } from '@shell/components/ui';
import { useToast } from '@shell/components/overlays/ToastHost';
import { useSession } from '@shell/lib/session';
import { Card, Muted } from '../chat/components/shared';
import { testApi } from '../testing/bridge';
import { EMPTY_SYNC_CONFIG, NO_CONDITIONAL_NOTE, syncErrorText, TEAM_SHOT_NOTE, type SyncConfig, type SyncProbe } from './sync-api';

/** Khớp regionRe (Go): chữ thường, số, dấu -, tối đa 64. */
export const validRegion = (s: string) => /^[a-z0-9-]{0,64}$/.test(s);
/** host[:port] không scheme, không đường dẫn, không khoảng trắng (Go kiểm kỹ hơn khi lưu). */
export const validEndpoint = (s: string) => s === '' || /^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(s);
/** Khớp SetSyncCredentials (Go): 1..256 ký tự, không khoảng trắng hay ký tự điều khiển. */
export const validKey = (s: string) => s.length > 0 && s.length <= 256 && !/[\s\x00-\x1f\x7f]/.test(s);

export const EVIDENCE_AUTO_NOTE = `Bật thì mọi lượt chạy xong trên máy này tự đẩy evidence (báo cáo, ảnh màn hình, video) lên kho nhóm. ${TEAM_SHOT_NOTE}`;

type Draft = Pick<SyncConfig, 'endpoint' | 'bucket' | 'region' | 'pathStyle' | 'useTLS' | 'evidenceAuto'>;
const draftOf = (c: SyncConfig): Draft => ({
  endpoint: c.endpoint,
  bucket: c.bucket,
  region: c.region,
  pathStyle: c.pathStyle,
  useTLS: c.useTLS,
  evidenceAuto: c.evidenceAuto,
});
const trimmed = (d: Draft): Draft => ({ ...d, endpoint: d.endpoint.trim(), bucket: d.bucket.trim(), region: d.region.trim() });
const sameDraft = (a: Draft, b: Draft) => (Object.keys(a) as (keyof Draft)[]).every((k) => a[k] === b[k]);

/** Kết quả "Thử kết nối": lỗi, đạt, hoặc đạt nhưng kho không ghi có điều kiện được (cảnh báo ghi đè). */
export function ProbeResult({ probe }: { probe: SyncProbe }) {
  if (probe.error) return <p className="text-[11.5px]/[15px] text-red">Không kết nối được: {probe.error}</p>;
  if (!probe.ok) return <p className="text-[11.5px]/[15px] text-red">Kết nối chưa đạt: kho không cho liệt kê, ghi, đọc hoặc xoá dưới prefix này.</p>;
  if (!probe.conditional) return <p className="rounded-[6px] bg-amber-soft px-[8px] py-[5px] text-[11.5px]/[15px] text-text-2" data-testid="probe-warn">Kết nối được. {NO_CONDITIONAL_NOTE}</p>;
  return <p className="text-[11.5px]/[15px] text-green">Kết nối được; kho hỗ trợ ghi có điều kiện nên hai người đẩy cùng lúc không ghi đè nhau.</p>;
}

export function SyncSettingsView({
  cfg,
  canEdit,
  busy,
  probe,
  onSave,
  onSaveKeys,
  onClearKeys,
  onProbe,
}: {
  cfg: SyncConfig;
  /** Có quyền cqs.credentials: hiện ô nhập, nút lưu, khoá, thử kết nối. */
  canEdit: boolean;
  busy?: boolean;
  probe?: SyncProbe | null;
  onSave?: (cfg: SyncConfig) => void;
  /** Giá trị khoá chỉ đi một chiều tới Go; ô nhập được xoá ngay khi gửi. */
  onSaveKeys?: (access: string, secret: string) => void;
  onClearKeys?: () => void;
  onProbe?: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(cfg));
  useEffect(() => setDraft(draftOf(cfg)), [cfg]);
  const [access, setAccess] = useState('');
  const [secret, setSecret] = useState('');
  const d = trimmed(draft);
  const badEndpoint = !validEndpoint(d.endpoint);
  const badRegion = !validRegion(d.region);
  const half = (d.endpoint === '') !== (d.bucket === '');
  const dirty = !sameDraft(d, draftOf(cfg));
  const keysOk = validKey(access) && validKey(secret);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((x) => ({ ...x, [k]: v }));
  const ro = !canEdit;
  return (
    <Card title="Đồng bộ nhóm (S3/MinIO)">
      <div className="flex flex-col gap-[10px]" data-testid="sync-settings">
        <Muted>
          Tài liệu, ca, flow, ghi chú và evidence lượt chạy được đồng bộ với đồng đội qua một bucket S3 hoặc MinIO của công ty. Để trống endpoint và bucket để
          tắt đồng bộ.
        </Muted>
        <form
          className="flex flex-col gap-[10px]"
          data-testid="sync-config-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (ro || !dirty || badEndpoint || badRegion || half) return;
            onSave?.({ ...cfg, ...d });
          }}
        >
          <div className="grid grid-cols-1 gap-[10px] sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_140px]">
            <Input label="Endpoint" mono placeholder="minio.congty.vn:9000" value={draft.endpoint} readOnly={ro} invalid={badEndpoint} onChange={(e) => set('endpoint', e.target.value)} />
            <Input label="Bucket" mono placeholder="chatqa" value={draft.bucket} readOnly={ro} onChange={(e) => set('bucket', e.target.value)} />
            <Input label="Region" mono placeholder="us-east-1" value={draft.region} readOnly={ro} invalid={badRegion} onChange={(e) => set('region', e.target.value)} />
          </div>
          <div className="flex flex-wrap gap-[16px]">
            <Checkbox checked={draft.useTLS} disabled={ro} onChange={(v) => set('useTLS', v)}>
              Dùng TLS (https)
            </Checkbox>
            <Checkbox checked={draft.pathStyle} disabled={ro} onChange={(v) => set('pathStyle', v)}>
              Path-style (MinIO thường cần)
            </Checkbox>
          </div>
          <div className="flex items-start gap-[10px]">
            <Toggle size="setting" slot={false} checked={draft.evidenceAuto} locked={ro} dirty={draft.evidenceAuto !== cfg.evidenceAuto} label="Tự chia sẻ evidence mọi lượt" onChange={(v) => set('evidenceAuto', v)} />
            <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
              <span className="text-[12.5px]/[16px] font-semibold text-text">Tự chia sẻ evidence mọi lượt</span>
              <p className="text-[11.5px]/[15px] text-amber" data-testid="evidence-auto-note">
                {EVIDENCE_AUTO_NOTE}
              </p>
            </div>
          </div>
          <p className="text-[11.5px]/[15px] text-text-2">
            Prefix trên kho:{' '}
            {cfg.prefix ? (
              <span className="font-mono" data-testid="sync-prefix">
                {cfg.prefix}
              </span>
            ) : (
              <span className="text-text-3">tenants/&lt;mã tổ chức&gt;/chatqa, có khi đăng nhập tài khoản công ty.</span>
            )}
          </p>
          {(badEndpoint || badRegion || half) && (
            <p className="text-[11.5px]/[15px] text-red">
              {badEndpoint
                ? 'Endpoint chỉ gồm host và cổng (vd minio.congty.vn:9000), không có https:// hay đường dẫn.'
                : badRegion
                  ? 'Region chỉ gồm chữ thường, số và - (vd us-east-1).'
                  : 'Nhập cả endpoint và bucket, hoặc để trống cả hai để tắt đồng bộ.'}
            </p>
          )}
          {canEdit && (
            <Button type="submit" className="self-start" disabled={busy || !dirty || badEndpoint || badRegion || half}>
              Lưu
            </Button>
          )}
        </form>
        <div className="flex flex-col gap-[6px] border-t border-divider pt-[8px]">
          <span className="text-[12px]/[15px] font-semibold text-text-2">Khoá S3</span>
          {cfg.credentialsSet ? (
            <div className="flex flex-wrap items-center gap-[10px]" data-testid="sync-keys-saved">
              <span className="text-[12.5px]/[16px] text-green">Đã lưu</span>
              <span className="text-[11.5px]/[15px] text-text-3">Giá trị nằm trong kho bí mật của máy, không hiện lại.</span>
              {canEdit && (
                <Button size="xs" variant="danger" disabled={busy} icon={<Trash2 size={13} />} onClick={onClearKeys}>
                  Xoá khoá
                </Button>
              )}
            </div>
          ) : canEdit ? (
            <form
              className="grid grid-cols-1 items-end gap-[10px] sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"
              data-testid="sync-keys-form"
              onSubmit={(e) => {
                e.preventDefault();
                if (!keysOk) return;
                const [a, s] = [access, secret];
                setAccess('');
                setSecret('');
                onSaveKeys?.(a, s);
              }}
            >
              <Input label="Access key" password autoComplete="off" value={access} invalid={access !== '' && !validKey(access)} onChange={(e) => setAccess(e.target.value)} />
              <Input label="Secret key" password autoComplete="off" value={secret} invalid={secret !== '' && !validKey(secret)} onChange={(e) => setSecret(e.target.value)} />
              <Button type="submit" className="self-end" disabled={busy || !keysOk} icon={<KeyRound size={15} />}>
                Lưu khoá
              </Button>
            </form>
          ) : (
            <Muted>Chưa đặt.</Muted>
          )}
        </div>
        {canEdit && (
          <div className="flex flex-col gap-[6px] border-t border-divider pt-[8px]">
            <div className="flex items-center gap-[10px]">
              <Button size="sm" variant="secondary" disabled={busy || !cfg.configured || dirty} icon={<PlugZap size={13} />} onClick={onProbe}>
                Thử kết nối
              </Button>
              {!cfg.configured ? (
                <span className="text-[11.5px]/[15px] text-text-3">Lưu endpoint, bucket và khoá trước khi thử.</span>
              ) : (
                dirty && <span className="text-[11.5px]/[15px] text-text-3">Lưu thay đổi trước khi thử.</span>
              )}
            </div>
            {probe && <ProbeResult probe={probe} />}
          </div>
        )}
        {!canEdit && <Muted>Cần quyền quản lý credentials để đổi cấu hình và khoá đồng bộ.</Muted>}
      </div>
    </Card>
  );
}

/** Đọc/lưu cấu hình đồng bộ qua Go; lỗi thành toast. Core cũ chưa có đồng bộ thì không hiện khối. */
export function SyncSettingsCard() {
  const { show } = useToast();
  const canEdit = useSession().can('cqs.credentials');
  const [cfg, setCfg] = useState<SyncConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [probe, setProbe] = useState<SyncProbe | null>(null);
  const load = useCallback(async () => {
    try {
      setCfg(await testApi.syncConfig());
    } catch (e) {
      if ((e as { code?: string } | null)?.code === 'incompatible') return;
      setCfg(EMPTY_SYNC_CONFIG);
      show(syncErrorText(e));
    }
  }, [show]);
  useEffect(() => {
    void load();
  }, [load]);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      show(syncErrorText(e));
    } finally {
      setBusy(false);
    }
  };
  if (!cfg) return null;
  return (
    <SyncSettingsView
      cfg={cfg}
      canEdit={canEdit}
      busy={busy}
      probe={probe}
      onSave={(next) => {
        if (next.evidenceAuto && !cfg.evidenceAuto && !window.confirm(`${EVIDENCE_AUTO_NOTE}\n\nBật tự chia sẻ evidence?`)) return;
        void run(async () => {
          setCfg(await testApi.setSyncConfig(next));
          setProbe(null);
          show('Đã lưu cấu hình đồng bộ nhóm.');
        });
      }}
      onSaveKeys={(access, secret) =>
        void run(async () => {
          await testApi.setSyncCredentials(access, secret);
          setProbe(null);
          show('Đã lưu khoá S3.');
          await load();
        })
      }
      onClearKeys={() => {
        if (!window.confirm('Xoá khoá S3 khỏi máy này? Đồng bộ nhóm sẽ dừng tới khi nhập lại khoá.')) return;
        void run(async () => {
          await testApi.clearSyncCredentials();
          setProbe(null);
          show('Đã xoá khoá S3.');
          await load();
        });
      }}
      onProbe={() =>
        void run(async () => {
          setProbe(await testApi.testSyncConnection());
        })
      }
    />
  );
}
