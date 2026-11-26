// Cài đặt › Agent: chọn khung chat (chat cũ hoặc đội agent ADK) và tải lại agent.yaml. Ghi qua Go, không sửa tay file.
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@shell/components/ui';
import { useToast } from '@shell/components/overlays/ToastHost';
import { errorText } from '@shell/lib/session';
import { AdminPage } from '@shell/pages/admin/parts';
import { Card, Muted } from '../chat/components/shared';
import { agentApi, type AgentStatus } from './bridge';

/** Thẻ chọn khung chat (thuần, test được). */
export function AgentSettingsView({
  status,
  busy,
  onEngine,
  onReload,
}: {
  status: AgentStatus | null;
  busy?: boolean;
  onEngine: (engine: 'legacy' | 'adk') => void;
  onReload: () => void;
}) {
  const adk = !!status?.enabled && status.engine === 'adk';
  return (
    <AdminPage tab="agent" crumb="Cài đặt › Agent · chỉ Admin" title="Agent">
      <div className="flex w-full max-w-[560px] flex-col gap-[10px]" data-testid="agent-settings">
        <Card title="Khung chat">
          <Muted>
            Chat cũ là khung hiện tại. Đội agent ADK gồm Điều phối, Lập kế hoạch và Chạy flow; chúng gọi đúng các tool của app, qua máy chủ, không cần khoá AI trên máy này. Đổi xong, mở lại màn làm việc.
          </Muted>
          <div role="radiogroup" aria-label="Khung chat" className="flex gap-[8px]">
            <Button type="button" role="radio" aria-checked={!adk} disabled={busy || !status || !adk} onClick={() => onEngine('legacy')}>
              Chat cũ
            </Button>
            <Button type="button" role="radio" aria-checked={adk} disabled={busy || !status || adk} onClick={() => onEngine('adk')}>
              Đội agent ADK
            </Button>
          </div>
          {status?.error && <p className="text-[12px]/[16px] text-red">{status.error}</p>}
        </Card>
        <Card title="Cấu hình">
          <Muted>Model của từng agent đổi ngay trong khung chat. File agent.yaml nằm trong thư mục dữ liệu của app và không chứa khoá nào. Sửa tay xong bấm tải lại.</Muted>
          <div>
            <Button type="button" disabled={busy || !status} onClick={onReload}>
              Tải lại cấu hình
            </Button>
          </div>
        </Card>
      </div>
    </AdminPage>
  );
}

export default function AgentSettingsPage() {
  const { show } = useToast();
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      setStatus(await agentApi.status());
    } catch (e) {
      show(errorText(e));
    }
  }, [show]);
  useEffect(() => {
    void load();
  }, [load]);
  const run = async (fn: () => Promise<void>, done: string) => {
    setBusy(true);
    try {
      await fn();
      show(done);
      await load();
    } catch (e) {
      show(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <AgentSettingsView
      status={status}
      busy={busy}
      onEngine={(e) => void run(() => agentApi.setEngine(e), e === 'adk' ? 'Đã chọn đội agent ADK.' : 'Đã chọn chat cũ.')}
      onReload={() => void run(() => agentApi.reloadConfig(), 'Đã tải lại cấu hình.')}
    />
  );
}
