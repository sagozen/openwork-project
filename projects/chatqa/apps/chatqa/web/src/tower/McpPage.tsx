// Kết nối AI bên ngoài (Claude Code, Claude Desktop, Codex, Cursor) qua máy chủ MCP cục bộ của app (window.go.tools.Service.*,
// apps/chatqa/desktop/internal/modules/tools). Token chỉ hiện đúng một lần khi bật; máy chỉ lưu băm.
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@shell/components/ui';
import { errorText } from '@shell/lib/session';
import { useToast } from '@shell/components/overlays/ToastHost';
import { Card, Muted } from '../chat/components/shared';
import { goCall } from '../live/bridge';

export interface McpStatus {
  enabled: boolean;
  url: string;
  running: boolean;
  command?: string;
}

const t = (name: string) => `tools.Service.${name}`;
export const mcpApi = {
  status: () => goCall<McpStatus>(t('MCPStatus')),
  enable: () => goCall<{ token: string; status: McpStatus }>(t('EnableMCP')),
  disable: () => goCall<void>(t('DisableMCP')),
};

export interface McpSnippet {
  client: string;
  where: string;
  code: string;
}

/** Cấu hình dán sẵn cho từng client. Không có token thì để chỗ trống <token>. */
export function mcpSnippets(url: string, command: string, token = '<token>'): McpSnippet[] {
  const cmd = command || '<đường dẫn ChatQASoftware>';
  const desktop = { mcpServers: { chatqa: { command: cmd, args: ['--mcp'], env: { CHATQA_MCP_TOKEN: token } } } };
  return [
    {
      client: 'Claude Code',
      where: 'Chạy trong Terminal',
      code: `claude mcp add --transport http chatqa ${url} --header "Authorization: Bearer ${token}"`,
    },
    {
      client: 'Claude Desktop',
      where: 'Thêm vào claude_desktop_config.json (Settings → Developer → Edit Config), rồi mở lại Claude Desktop',
      code: JSON.stringify(desktop, null, 2),
    },
    {
      client: 'Codex',
      where: 'Thêm vào ~/.codex/config.toml; đặt biến môi trường CHATQA_MCP_TOKEN bằng token trước khi chạy codex',
      code: `[mcp_servers.chatqa]\nurl = "${url}"\nbearer_token_env_var = "CHATQA_MCP_TOKEN"\ndefault_tools_approval_mode = "approve"`,
    },
    {
      client: 'Cursor',
      where: 'Thêm vào ~/.cursor/mcp.json (Cursor Settings → MCP → Add new global MCP server), rồi mở lại Cursor',
      code: JSON.stringify({ mcpServers: { chatqa: { url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2),
    },
  ];
}

export interface McpActions {
  enable: () => void;
  disable: () => void;
  hideToken: () => void;
}

export function McpView({ status, token, actions }: { status: McpStatus | null; token: string | null; actions: McpActions }) {
  const on = !!status?.enabled;
  return (
    <div className="flex flex-col gap-[10px] px-[16px] py-[14px]" data-testid="mcp">
      <Card
        title="Kết nối AI bên ngoài (MCP)"
        aside={
          <span className="text-[11.5px]/[15px] text-text-3">{on ? (status?.running ? 'Đang bật' : 'Đã bật, chưa chạy') : 'Đang tắt'}</span>
        }
      >
        <Muted>
          Claude Code, Claude Desktop, Codex hoặc Cursor trên máy này gọi được các tool của tháp (xem máy, chạy flow, đọc báo cáo, chụp màn hình,
          viết flow YAML) với quyền của bạn. Chỉ nhận kết nối từ chính máy này; token chỉ dùng được khi bạn đang đăng nhập.
        </Muted>
        {on && status?.url && <code className="select-all font-mono text-[11.5px]/[16px] text-text">{status.url}</code>}
        <div className="flex gap-[8px]">
          <Button size="sm" onClick={actions.enable}>
            {on ? 'Cấp token mới' : 'Bật MCP'}
          </Button>
          {on && (
            <Button size="sm" variant="secondary" onClick={actions.disable}>
              Tắt MCP
            </Button>
          )}
        </div>
        {on && !token && <Muted>Token cũ không xem lại được. Mất token thì bấm "Cấp token mới" (token cũ hết hiệu lực).</Muted>}
      </Card>
      {token && (
        <Card title="Token (chỉ hiện lần này, hãy lưu ngay)" tone="warn">
          <code className="select-all break-all rounded-[6px] bg-surface px-[8px] py-[6px] font-mono text-[11.5px]/[16px] text-text">{token}</code>
          <Button size="sm" variant="secondary" className="self-start" onClick={actions.hideToken}>
            Đã lưu token
          </Button>
        </Card>
      )}
      {on &&
        mcpSnippets(status?.url ?? '', status?.command ?? '', token ?? undefined).map((s) => (
          <Card key={s.client} title={s.client}>
            <Muted>{s.where}</Muted>
            <pre className="select-all overflow-x-auto whitespace-pre rounded-[6px] bg-muted-box px-[8px] py-[6px] font-mono text-[11.5px]/[16px] text-text">
              {s.code}
            </pre>
          </Card>
        ))}
    </div>
  );
}

export default function McpPage() {
  const { show } = useToast();
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const run = useCallback(
    async (f: () => Promise<void>) => {
      try {
        await f();
      } catch (e) {
        show(errorText(e));
      }
    },
    [show],
  );
  useEffect(() => {
    void run(async () => setStatus(await mcpApi.status()));
  }, [run]);
  const actions: McpActions = {
    enable: () =>
      void run(async () => {
        const r = await mcpApi.enable();
        setStatus(r.status);
        setToken(r.token);
      }),
    disable: () =>
      void run(async () => {
        await mcpApi.disable();
        setToken(null);
        setStatus(await mcpApi.status());
      }),
    hideToken: () => setToken(null),
  };
  return <McpView status={status} token={token} actions={actions} />;
}
