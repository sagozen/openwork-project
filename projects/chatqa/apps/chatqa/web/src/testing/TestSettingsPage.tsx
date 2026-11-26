// Cài đặt › Kiểm thử: cài đặt của App 2 trên máy này. Hiện có Apple Team ID (ký agent trên iPhone thật); thiếu thì live view và
// lượt chạy trên iPhone dừng ở câu "Cần Apple Team ID" (contracts/errors.json). Thêm trình duyệt (web), biến bí mật, đồng bộ nhóm (S3/MinIO)
// và số ngày giữ dữ liệu cục bộ.
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Button, Input } from '@shell/components/ui';
import { useToast } from '@shell/components/overlays/ToastHost';
import { errorText } from '@shell/lib/session';
import { AdminPage } from '@shell/pages/admin/parts';
import { Card, Muted } from '../chat/components/shared';
import { towerApi } from '../live/bridge';
import { testApi } from './bridge';
import { BrowserProfilesCard } from './BrowserProfiles';
import { SyncSettingsCard } from '../sync/SyncSettings';

/** Khớp testengine.ValidTeamID (Go): 10 chữ hoa hoặc số. Để trống = xoá. */
export const validTeamId = (s: string) => s === '' || /^[A-Z0-9]{10}$/.test(s);

/** Khớp testengine.secretNameRe (Go); WEBHOOK_ là khoá của app. */
export const validSecretName = (s: string) => /^[A-Z_][A-Z0-9_]{0,63}$/.test(s) && !s.startsWith('WEBHOOK_');

/** Khớp SetRetentionDays (Go): số nguyên 7..3650 ngày. */
export const RETENTION_MIN = 7;
export const RETENTION_MAX = 3650;
export const validRetention = (s: string) => /^\d+$/.test(s.trim()) && Number(s) >= RETENTION_MIN && Number(s) <= RETENTION_MAX;

/** Thẻ số ngày giữ dữ liệu (thuần, test được): saved = 0 khi chưa đọc được. */
export function RetentionView({ saved, busy, onSave }: { saved: number; busy?: boolean; onSave: (days: number) => void }) {
  const [draft, setDraft] = useState(saved ? String(saved) : '');
  useEffect(() => setDraft(saved ? String(saved) : ''), [saved]);
  const ok = validRetention(draft);
  const days = ok ? Number(draft.trim()) : 0;
  return (
    <Card title="Giữ dữ liệu">
      <Muted>
        Lượt chạy (ảnh, video, báo cáo), sổ gọi AI và tool, lịch sử sử dụng trên máy này cũ hơn số ngày này sẽ bị xoá (dọn lúc mở app và mỗi ngày).
      </Muted>
      <form
        className="flex items-end gap-[10px]"
        data-testid="retention-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (ok && days !== saved) onSave(days);
        }}
      >
        <Input
          label="Số ngày giữ"
          type="number"
          min={RETENTION_MIN}
          max={RETENTION_MAX}
          value={draft}
          invalid={draft !== '' && !ok}
          onChange={(e) => setDraft(e.target.value)}
        />
        <Button type="submit" disabled={busy || !ok || days === saved}>
          Lưu
        </Button>
      </form>
      <p className={draft !== '' && !ok ? 'text-[11.5px]/[15px] text-red' : 'text-[11.5px]/[15px] text-text-3'}>
        {draft !== '' && !ok ? `Từ ${RETENTION_MIN} đến ${RETENTION_MAX} ngày.` : 'Giảm số ngày sẽ xoá ngay phần cũ hơn, không khôi phục được.'}
      </p>
    </Card>
  );
}

/** Đọc/lưu số ngày giữ qua Go; lưu cần quyền tự động hoá (xoá lịch sử dùng chung). */
export function RetentionCard() {
  const { show } = useToast();
  const [saved, setSaved] = useState(0);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      setSaved(await testApi.retention());
    } catch (e) {
      show(errorText(e));
    }
  }, [show]);
  useEffect(() => {
    void load();
  }, [load]);
  const save = async (days: number) => {
    if (days < saved && !window.confirm(`Xoá ngay dữ liệu cũ hơn ${days} ngày trên máy này?`)) return;
    setBusy(true);
    try {
      await testApi.setRetention(days);
      show(`Đã đặt giữ dữ liệu ${days} ngày.`);
    } catch (e) {
      show(errorText(e));
    } finally {
      // Lỗi dọn vẫn lưu số ngày (Go): đọc lại để ô hiện đúng giá trị đang áp dụng.
      await load();
      setBusy(false);
    }
  };
  return <RetentionView saved={saved} busy={busy} onSave={(d) => void save(d)} />;
}

/** Thẻ biến bí mật của flow (${PASSWORD}...): đặt, ghi đè, xoá. Giá trị chỉ đi một chiều vào kho, không hiện lại. */
export function SecretsCard() {
  const { show } = useToast();
  const [names, setNames] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      setNames(await testApi.secretNames());
    } catch (e) {
      show(errorText(e));
    }
  }, [show]);
  useEffect(() => {
    void load();
  }, [load]);
  const key = name.trim().toUpperCase();
  const badName = key !== '' && !validSecretName(key);
  const badValue = /[\r\n\0]/.test(value);
  const run = async (fn: () => Promise<void>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      show(ok);
      await load();
    } catch (e) {
      show(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Biến bí mật">
      <Muted>
        Giá trị cho {'${TÊN}'} trong flow (vd PASSWORD). Lưu mã hoá trên máy này, dùng chung cho mọi app; không hiện lại, AI/MCP chỉ thấy tên.
      </Muted>
      <form
        className="flex items-end gap-[10px]"
        data-testid="secret-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!key || badName || !value || badValue) return;
          const v = value;
          void run(async () => {
            await testApi.setSecret(key, v);
            setName('');
            setValue('');
          }, `Đã lưu ${key}.`);
        }}
      >
        <Input label="Tên" mono placeholder="PASSWORD" maxLength={64} value={name} invalid={badName} onChange={(e) => setName(e.target.value)} />
        <Input label="Giá trị" password autoComplete="off" value={value} invalid={badValue} onChange={(e) => setValue(e.target.value)} />
        <Button type="submit" disabled={busy || !key || badName || !value || badValue}>
          Lưu
        </Button>
      </form>
      {badName && <p className="text-[11.5px]/[15px] text-red">Chỉ chữ hoa, số và _, không bắt đầu bằng số hay WEBHOOK_.</p>}
      {names.length === 0 ? (
        <p className="text-[11.5px]/[15px] text-text-3">Chưa có biến nào.</p>
      ) : (
        <ul className="flex flex-col gap-[6px]" data-testid="secret-list">
          {names.map((n) => (
            <li key={n} className="flex items-center justify-between gap-[10px]">
              <span className="font-mono text-[13px]">{n}</span>
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  if (window.confirm(`Xoá biến ${n}?`)) void run(() => testApi.deleteSecret(n), `Đã xoá ${n}.`);
                }}
              >
                Xoá
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function TestSettingsView({
  saved,
  busy,
  onSave,
  extra,
}: {
  saved: string;
  busy?: boolean;
  onSave: (team: string) => void;
  /** Thẻ thêm dưới Apple Team ID (thẻ Biến bí mật, cần ToastProvider và Go). */
  extra?: ReactNode;
}) {
  const [draft, setDraft] = useState(saved);
  useEffect(() => setDraft(saved), [saved]);
  const team = draft.trim().toUpperCase();
  const invalid = !validTeamId(team);
  return (
    <AdminPage tab="test" crumb="Cài đặt › Kiểm thử · chỉ Admin" title="Kiểm thử">
      <div className="flex w-full max-w-[560px] flex-col gap-[10px]" data-testid="test-settings">
        <Card title="Apple Team ID">
          <Muted>Cần để chạy và xem màn hình iPhone thật: ChatQASoftware ký agent trên máy bằng tài khoản developer của bạn. Android và simulator không cần.</Muted>
          <form
            className="flex items-end gap-[10px]"
            onSubmit={(e) => {
              e.preventDefault();
              if (!invalid && team !== saved) onSave(team);
            }}
          >
            <Input
              label="Team ID"
              mono
              maxLength={10}
              placeholder="ABCDE12345"
              value={draft}
              invalid={invalid}
              onChange={(e) => setDraft(e.target.value)}
            />
            <Button type="submit" disabled={busy || invalid || team === saved}>
              Lưu
            </Button>
          </form>
          <p className={invalid ? 'text-[11.5px]/[15px] text-red' : 'text-[11.5px]/[15px] text-text-3'}>
            {invalid ? 'Gồm đúng 10 chữ hoa hoặc số.' : 'Xem ở developer.apple.com › Membership details. Để trống để xoá.'}
          </p>
        </Card>
        {extra}
      </div>
    </AdminPage>
  );
}

export default function TestSettingsPage() {
  const { show } = useToast();
  const [saved, setSaved] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      setSaved(await towerApi.teamId());
    } catch (e) {
      show(errorText(e));
    }
  }, [show]);
  useEffect(() => {
    void load();
  }, [load]);
  const save = async (team: string) => {
    setBusy(true);
    try {
      await towerApi.setTeamId(team);
      show(team ? 'Đã lưu Apple Team ID.' : 'Đã xoá Apple Team ID.');
      await load();
    } catch (e) {
      show(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <TestSettingsView
      saved={saved}
      busy={busy}
      onSave={(t) => void save(t)}
      extra={
        <>
          <BrowserProfilesCard />
          <SecretsCard />
          <SyncSettingsCard />
          <RetentionCard />
        </>
      }
    />
  );
}
