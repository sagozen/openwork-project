import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { McpView, mcpSnippets, type McpActions } from './McpPage';

const actions: McpActions = { enable: () => undefined, disable: () => undefined, hideToken: () => undefined };
const url = 'http://127.0.0.1:39017/mcp';
const exe = '/Applications/ChatQASoftware.app/Contents/MacOS/ChatQASoftware';

describe('Kết nối AI (MCP)', () => {
  it('cấu hình dán sẵn cho Claude Code, Claude Desktop, Codex và Cursor', () => {
    const [code, desktop, codex, cursor] = mcpSnippets(url, exe, 'cqs_abc');
    expect(code.code).toBe(`claude mcp add --transport http chatqa ${url} --header "Authorization: Bearer cqs_abc"`);
    expect(JSON.parse(desktop.code)).toEqual({ mcpServers: { chatqa: { command: exe, args: ['--mcp'], env: { CHATQA_MCP_TOKEN: 'cqs_abc' } } } });
    expect(codex.code).toContain(`url = "${url}"`);
    expect(codex.code).toContain('bearer_token_env_var = "CHATQA_MCP_TOKEN"');
    expect(codex.code).not.toContain('cqs_abc'); // Codex đọc token từ biến môi trường, không ghi vào file
    expect(cursor.client).toBe('Cursor');
    expect(JSON.parse(cursor.code)).toEqual({ mcpServers: { chatqa: { url, headers: { Authorization: 'Bearer cqs_abc' } } } });
  });

  it('tắt: chỉ có nút bật, không có cấu hình', () => {
    const html = renderToStaticMarkup(<McpView status={{ enabled: false, url, running: false }} token={null} actions={actions} />);
    expect(html).toContain('Bật MCP');
    expect(html).not.toContain('Tắt MCP');
    expect(html).not.toContain('claude mcp add');
  });

  it('vừa bật: hiện token một lần và cấu hình có token; bật rồi mà không có token thì để chỗ trống', () => {
    const on = { enabled: true, url, running: true, command: exe };
    const fresh = renderToStaticMarkup(<McpView status={on} token="cqs_abc" actions={actions} />);
    expect(fresh).toContain('chỉ hiện lần này');
    expect(fresh).toContain('Bearer cqs_abc');
    const later = renderToStaticMarkup(<McpView status={on} token={null} actions={actions} />);
    expect(later).not.toContain('cqs_abc');
    expect(later).toContain('Bearer &lt;token&gt;');
    expect(later).toContain('Cấp token mới');
  });
});
