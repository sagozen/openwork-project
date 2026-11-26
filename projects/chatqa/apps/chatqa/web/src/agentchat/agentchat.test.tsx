import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { AdminProvider } from '@shell/pages/admin/admin-context';
import type { AgentEvent, AgentStatus } from './bridge';
import { AgentTranscriptView, ModelPicker, parsePlan, PendingBadge, SessionList } from './AgentChatPane';
import { approvalAnswer } from './ApprovalForm';
import { ChatBar, ChatSurface, EngineProvider, surfaceFor } from './engine';
import { AgentSettingsView } from './AgentSettingsPage';
import { answerConfirm, answerRequest, emptyState, formatUsd, formatVnd, friendlyError, fromHistory, parseApprovalPayload, parseRunLines, pipelineLabel, reduce, reopen, sendUser, toolLabel, type RequestMsg } from './state';
import { PipelineButton, PipelineButtonView } from './PipelineButton';
import { DraftsView, diffLines } from './Drafts';
import type { FlowDraft } from './bridge';

const ev = (e: Partial<AgentEvent> & Pick<AgentEvent, 'kind'>): AgentEvent => ({ sessionId: 's1', ...e });
const fold = (events: AgentEvent[]) => events.reduce(reduce, sendUser(emptyState, 'chạy flow login trên Android'));
const load = () => Promise.resolve('data:image/png;base64,AAAA');

const status: AgentStatus = {
  enabled: true,
  engine: 'adk',
  ready: true,
  models: [
    { alias: 'sonnet', name: 'Claude Sonnet 5.5', id: 'claude-sonnet-5-5', inUsdPerM: 2, outUsdPerM: 10 },
    { alias: 'haiku', name: 'Claude Haiku 5.5', id: 'claude-haiku-5-5', inUsdPerM: 0.1, outUsdPerM: 0.5 },
  ],
  defaultModel: 'sonnet',
  agents: { coordinator: 'sonnet', planner: 'haiku', triage: 'sonnet', reporter: 'haiku', flowfixer: 'sonnet', summarizer: 'haiku' },
  agentNames: ['coordinator', 'planner', 'triage', 'reporter', 'flowfixer', 'summarizer'],
  maxCostUsd: 1,
};

describe('chat agent: gộp sự kiện', () => {
  it('chữ hiện dần nối thành một câu rồi bản cuối thay bản đang hiện, không nhân đôi', () => {
    const s1 = fold([ev({ kind: 'text_delta', author: 'coordinator', text: 'Đang ', partial: true }), ev({ kind: 'text_delta', author: 'coordinator', text: 'chạy…', partial: true })]);
    expect(s1.msgs.at(-1)).toMatchObject({ type: 'text', text: 'Đang chạy…', streaming: true });
    const s2 = reduce(s1, ev({ kind: 'text', author: 'coordinator', text: 'Đang chạy… xong' }));
    expect(s2.msgs.filter((m) => m.type === 'text')).toHaveLength(1);
    expect(s2.msgs.at(-1)).toMatchObject({ text: 'Đang chạy… xong', streaming: false });
  });

  it('dòng tiến độ của Runner thay nhau, biến mất khi có kết quả; mỗi agent một huy hiệu', () => {
    const s = fold([
      ev({ kind: 'progress', author: 'runner', text: 'Đang chạy 01_login.yaml trên android (emu-1)' }),
      ev({ kind: 'progress', author: 'runner', text: 'Vẫn đang chạy 01_login.yaml trên android (emu-1)' }),
    ]);
    expect(s.msgs.filter((m) => m.type === 'progress')).toHaveLength(1);
    const done = reduce(s, ev({ kind: 'text', author: 'runner', text: 'mexpress trên android (emu-1):\n  ✓ 01_login.yaml đạt\nTổng: 1 đạt, 0 lỗi.' }));
    expect(done.msgs.some((m) => m.type === 'progress')).toBe(false);
    const html = renderToStaticMarkup(<AgentTranscriptView msgs={done.msgs} busy={false} load={load} />);
    expect(html).toContain('Chạy flow');
    expect(html).toContain('data-testid="run-lines"');
    expect(html).toContain('aria-label="đạt"');
  });

  it('tool chạy rồi xong: hàng đổi từ đang chạy sang xong và mang loại kết quả; ảnh gắn vào đúng hàng', () => {
    const running = fold([ev({ kind: 'tool_call', author: 'planner', toolName: 'test_flows', toolCallId: 'c1', argsPreview: '{"app":"mexpress"}' })]);
    expect(running.msgs.at(-1)).toMatchObject({ type: 'tool', status: 'running', name: 'test_flows' });
    expect(renderToStaticMarkup(<AgentTranscriptView msgs={running.msgs} busy load={load} />)).toContain('aria-label="đang chạy"');
    const done = reduce(running, ev({ kind: 'tool_result', author: 'planner', toolName: 'test_flows', toolCallId: 'c1', resultKind: 'FlowList' }));
    expect(done.msgs.at(-1)).toMatchObject({ status: 'done', resultKind: 'FlowList' });
    const html = renderToStaticMarkup(<AgentTranscriptView msgs={done.msgs} busy={false} load={load} />);
    expect(html).toContain('data-status="done"');
    expect(html).toContain('FlowList');
    expect(html).not.toContain('aria-label="đang chạy"');
  });

  it('hai tool cùng tên chạy song song: kết quả khớp theo mã gọi', () => {
    const s = fold([
      ev({ kind: 'tool_call', toolName: 'device_screenshot', toolCallId: 'a' }),
      ev({ kind: 'tool_call', toolName: 'device_screenshot', toolCallId: 'b' }),
      ev({ kind: 'tool_result', toolName: 'device_screenshot', toolCallId: 'b', imageRef: 'shot://2' }),
    ]);
    const tools = s.msgs.filter((m) => m.type === 'tool');
    expect(tools[0]).toMatchObject({ id: 'a', status: 'running' });
    expect(tools[1]).toMatchObject({ id: 'b', status: 'done', imageRef: 'shot://2' });
  });

  it('lượt dừng giữa chừng: tool đang chạy không quay mãi, chi phí lấy từ sự kiện done', () => {
    const s = fold([ev({ kind: 'tool_call', toolName: 'test_run', toolCallId: 'x' }), ev({ kind: 'done', costUsd: 0.0123, costVnd: 326 })]);
    expect(s.busy).toBe(false);
    expect(s.msgs.find((m) => m.type === 'tool')).toMatchObject({ status: 'done' });
    expect(s).toMatchObject({ costUsd: 0.0123, costVnd: 326 });
  });

  it('lỗi ngân sách hiện thành thẻ lỗi với đúng lời của máy chủ', () => {
    const s = fold([ev({ kind: 'error', text: 'ai_budget_exceeded' })]);
    const html = renderToStaticMarkup(<AgentTranscriptView msgs={s.msgs} busy={false} load={load} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain('Đã dùng hết ngân sách AI tháng này');
  });
});

describe('chat agent: mở lại phiên và giao diện', () => {
  const stored: AgentEvent[] = [
    ev({ kind: 'text', author: 'user', text: 'chạy flow login trên Android' }),
    ev({ kind: 'tool_call', author: 'coordinator', toolName: 'transfer_to_agent', toolCallId: 't', argsPreview: '{"agent_name":"plan_and_run"}' }),
    ev({ kind: 'tool_result', author: 'coordinator', toolName: 'transfer_to_agent', toolCallId: 't' }),
    ev({ kind: 'text', author: 'runner', text: '  ✗ 02_pay.yaml lỗi [selector]: không thấy nút\nTổng: 0 đạt, 1 lỗi.' }),
  ];

  it('phiên đã lưu vẽ lại đủ: câu người dùng, chuyển agent, kết quả có chip lỗi', () => {
    const s = fromHistory(stored);
    expect(s.busy).toBe(false);
    const html = renderToStaticMarkup(<AgentTranscriptView msgs={s.msgs} busy={false} load={load} />);
    const at = ['chạy flow login trên Android', 'chuyển cho plan_and_run', '02_pay.yaml lỗi'].map((t) => html.indexOf(t));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(html).toContain('aria-label="lỗi"');
  });

  it('kế hoạch của agent Lập kế hoạch hiện thành danh sách, không in JSON thô; chữ thường giữ nguyên', () => {
    const plan = '{"flows":[{"app":"e2e-web","flow":"mo-trang.spec.ts","reason":"đổi trang chủ"}],"platforms":["web"],"error":""}';
    const s = fromHistory([ev({ kind: 'text', author: 'planner', text: plan })]);
    const html = renderToStaticMarkup(<AgentTranscriptView msgs={s.msgs} busy={false} load={load} />);
    expect(html).toContain('Chạy 1 flow trên web');
    expect(html).toContain('e2e-web › mo-trang.spec.ts');
    expect(html).toContain('đổi trang chủ');
    expect(html).not.toContain('&quot;flows&quot;');
    expect(parsePlan('Xin chào')).toBeNull();
    expect(parsePlan('{"flows": ')).toBeNull();
    const none = renderToStaticMarkup(<AgentTranscriptView msgs={fromHistory([ev({ kind: 'text', author: 'planner', text: '{"flows":[],"platforms":[]}' })]).msgs} busy={false} load={load} />);
    expect(none).toContain('Không có flow nào cần chạy');
  });

  it('danh sách phiên: phiên đang mở được đánh dấu; trống thì báo chưa có', () => {
    const list = [
      { id: 'a', title: 'chạy flow login', updatedAt: 2, running: false },
      { id: 'b', title: 'kiểm tra thanh toán', updatedAt: 1, running: false },
    ];
    const html = renderToStaticMarkup(<SessionList sessions={list} activeId="a" onOpen={() => undefined} onNew={() => undefined} onDelete={() => undefined} />);
    expect(html).toContain('chạy flow login');
    expect(html).toMatch(/aria-current="true"[^>]*>chạy flow login/);
    expect(renderToStaticMarkup(<SessionList sessions={[]} activeId="" onOpen={() => undefined} onNew={() => undefined} onDelete={() => undefined} />)).toContain('Chưa có phiên nào');
  });

  it('chọn model: mỗi agent một ô theo danh sách máy chủ, chi phí lượt hiện cả USD và đồng', () => {
    const html = renderToStaticMarkup(<ModelPicker status={status} costUsd={0.0123} costVnd={326} onChange={() => undefined} />);
    expect(html).toContain('Model của Lập kế hoạch');
    expect(html).toMatch(/<option value="haiku" selected/);
    expect(html).not.toContain('Model của summarizer');
    expect(html).toContain('$0.0123');
    expect(html).toContain('326 đ');
    expect(renderToStaticMarkup(<ModelPicker status={status} costUsd={0} costVnd={0} onChange={() => undefined} />)).not.toContain('Lượt này');
  });

  it('định dạng: tiền, tên tool, dòng kết quả', () => {
    expect(formatUsd(0.0123)).toBe('$0.0123');
    expect(formatUsd(1.5)).toBe('$1.50');
    expect(formatVnd(26500.4)).toMatch(/^26\.500 đ$|^26,500 đ$/);
    expect(toolLabel('test_run', '{}')).toBe('test_run');
    expect(parseRunLines('app:\n  ✓ a đạt\n  ⚠ b').map((l) => l.tone)).toEqual(['plain', 'pass', 'warn']);
  });
});

describe('chọn khung chat theo engine', () => {
  it('engine adk vẽ khung agent; engine legacy vẽ chat cũ', () => {
    const adk = renderToStaticMarkup(
      <EngineProvider engine="adk">
        <ChatSurface />
        <ChatBar />
      </EngineProvider>,
    );
    expect(adk).toContain('data-testid="agent-chat"');
    expect(adk).toContain('Nhắn cho đội agent');
    // Chat cũ cần phiên đăng nhập và router của app nên chỉ kiểm lựa chọn; máy chưa bật agent giữ nguyên chat cũ.
    expect(surfaceFor('adk')).toBe('agent');
    expect(surfaceFor('legacy')).toBe('classic');
  });

  it('Cài đặt › Agent: nút của khung đang dùng bị tắt, khung kia bấm được', () => {
    const html = (s: AgentStatus | null) =>
      renderToStaticMarkup(
        <MemoryRouter>
          <AdminProvider base="/cai-dat" extraTabs={[{ key: 'agent', label: 'Agent', path: 'agent', element: null }]}>
            <AgentSettingsView status={s} onEngine={() => undefined} onReload={() => undefined} />
          </AdminProvider>
        </MemoryRouter>,
      );
    const onAdk = html(status);
    expect(onAdk).toMatch(/aria-checked="true"[^>]*disabled=""[^>]*>Đội agent ADK|disabled=""[^>]*aria-checked="true"[^>]*>Đội agent ADK/);
    const onLegacy = html({ ...status, engine: 'legacy' });
    expect(onLegacy).toMatch(/aria-checked="true"[^>]*>Chat cũ|disabled=""[^>]*>Chat cũ/);
    expect(html(null)).toContain('Tải lại cấu hình');
  });
});

describe('pipeline sau deploy từ màn Git impact', () => {
  it('câu hiện thay người dùng: tên repo và khoảng commit, mới rỗng là HEAD', () => {
    expect(pipelineLabel('/Users/me/code/receiving/', 'abc1234', '')).toBe('Chạy pipeline receiving abc1234..HEAD');
    expect(pipelineLabel('C:\\code\\mexpress', 'v1.2', 'def5678')).toBe('Chạy pipeline mexpress v1.2..def5678');
  });

  it('nút Chạy pipeline: tắt khi chưa đủ repo và commit cũ, đổi chữ khi đang mở', () => {
    const idle = renderToStaticMarkup(<PipelineButtonView disabled={false} busy={false} onRun={() => undefined} />);
    expect(idle).toContain('Chạy pipeline');
    expect(idle).not.toContain('disabled=""');
    expect(renderToStaticMarkup(<PipelineButtonView disabled busy={false} onRun={() => undefined} />)).toContain('disabled=""');
    expect(renderToStaticMarkup(<PipelineButtonView disabled={false} busy onRun={() => undefined} />)).toContain('Đang mở pipeline');
  });

  it('chat cũ (không có đội agent) không hiện nút', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <PipelineButton repo="/r" from="a" to="" disabled={false} onError={() => undefined} />
      </MemoryRouter>,
    );
    expect(html).toBe('');
  });

  it('dòng trạng thái của pipeline mang huy hiệu Pipeline; báo cáo mang huy hiệu Báo cáo', () => {
    const s = fold([
      ev({ kind: 'text', author: 'pipeline', text: 'Đã lấy diff abc..HEAD: 2 file (+10 −3).' }),
      ev({ kind: 'text', author: 'runner', text: 'ios: bỏ qua (không có máy ios rảnh).' }),
      ev({ kind: 'text', author: 'reporter', text: 'Kết luận: đạt hết.' }),
    ]);
    const html = renderToStaticMarkup(<AgentTranscriptView msgs={s.msgs} busy={false} load={load} />);
    expect(html).toContain('>Pipeline<');
    expect(html).toContain('>Báo cáo<');
  });
});

describe('duyệt trước khi chạy', () => {
  const confirmation = ev({
    kind: 'confirmation',
    author: 'runner',
    toolName: 'test_run',
    toolCallId: 'confirm-1',
    argsPreview: '{"jobs":[{"app":"mexpress","flows":["02_order/001.yaml"],"device":"emu-1"}]}',
    text: 'Duyệt trước khi chạy mexpress/02_order/001.yaml (android): có flow tạo hoặc thay đổi dữ liệu.',
    risk: 'run',
    consequence: 'Điều khiển thiết bị hoặc chạy flow.',
  });
  const payload = JSON.stringify({ flows: [{ key: 'mexpress/02_order/001.yaml', app: 'mexpress', flow: '02_order/001.yaml', reason: 'tạo đơn' }], others: ['mexpress/01_login.yaml'] });
  const request = ev({ kind: 'request_input', author: 'pipeline', toolCallId: 'approve-inv1', toolName: 'adk_request_input', text: 'Pipeline dừng ở bước duyệt.', payload });

  it('hộp duyệt hiện việc, tool, tham số, hậu quả và hai nút', () => {
    const s = fold([confirmation, ev({ kind: 'done' })]);
    expect(s.msgs.at(-1)).toMatchObject({ type: 'confirm', id: 'confirm-1', status: 'open' });
    const html = renderToStaticMarkup(<AgentTranscriptView msgs={s.msgs} busy={false} load={load} onConfirm={() => undefined} />);
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain('test_run');
    expect(html).toContain('02_order/001.yaml');
    expect(html).toContain('Chạy trên thiết bị');
    expect(html).toContain('Điều khiển thiết bị');
    expect(html).toContain('>Đồng ý<');
    expect(html).toContain('>Từ chối<');
  });

  it('bấm Đồng ý: hộp đóng, lượt chạy tiếp; Go từ chối thì mở lại', () => {
    const s = answerConfirm(fold([confirmation, ev({ kind: 'done' })]), 'confirm-1', true);
    expect(s.busy).toBe(true);
    expect(s.msgs.at(-1)).toMatchObject({ status: 'approved' });
    const html = renderToStaticMarkup(<AgentTranscriptView msgs={s.msgs} busy load={load} onConfirm={() => undefined} />);
    expect(html).toContain('Đã đồng ý');
    expect(html).not.toContain('>Đồng ý<');
    expect(answerConfirm(fold([confirmation]), 'confirm-1', false).msgs.at(-1)).toMatchObject({ status: 'rejected' });
    expect(reopen(s, 'confirm-1')).toMatchObject({ busy: false });
    expect(reopen(s, 'confirm-1').msgs.at(-1)).toMatchObject({ status: 'open' });
  });

  it('nhắn câu khác thay vì trả lời: hộp duyệt bị bỏ; lịch sử đã trả lời thì không còn nút', () => {
    const s = sendUser(fold([confirmation, ev({ kind: 'done' })]), 'thôi');
    expect(s.msgs.find((m) => m.type === 'confirm')).toMatchObject({ status: 'closed' });
    const hist = fromHistory([ev({ ...confirmation, resolved: true })]);
    expect(hist.msgs[0]).toMatchObject({ type: 'confirm', status: 'closed' });
    expect(renderToStaticMarkup(<AgentTranscriptView msgs={hist.msgs} busy={false} load={load} />)).not.toContain('>Từ chối<');
  });

  it('bước duyệt pipeline: tick từng flow dữ liệu, các flow khác vẫn chạy, gửi danh sách đã chọn', () => {
    const s = fold([request, ev({ kind: 'done' })]);
    const m = s.msgs.at(-1) as RequestMsg;
    expect(m).toMatchObject({ type: 'request', id: 'approve-inv1', status: 'open' });
    expect(m.payload?.flows[0].key).toBe('mexpress/02_order/001.yaml');
    const html = renderToStaticMarkup(<AgentTranscriptView msgs={s.msgs} busy={false} load={load} onRespond={() => undefined} />);
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('mexpress/02_order/001.yaml');
    expect(html).toContain('tạo đơn');
    expect(html).toContain('Vẫn chạy (không đổi dữ liệu): mexpress/01_login.yaml');
    expect(html).toContain('Không chạy flow dữ liệu');
    expect(approvalAnswer(m, ['mexpress/02_order/001.yaml', 'bịa/ra.yaml'], '  ')).toEqual({ approved_flows: ['mexpress/02_order/001.yaml'] });
    expect(approvalAnswer(m, [], ' chỉ thử ')).toEqual({ approved_flows: [], note: 'chỉ thử' });
    const answered = answerRequest(s, 'approve-inv1');
    expect(answered.msgs.at(-1)).toMatchObject({ status: 'answered' });
    expect(renderToStaticMarkup(<AgentTranscriptView msgs={answered.msgs} busy load={load} />)).toContain('Đã gửi câu trả lời');
  });

  it('payload hỏng thì form chỉ hiện câu hỏi', () => {
    expect(parseApprovalPayload('{oops')).toBeNull();
    expect(parseApprovalPayload(undefined)).toBeNull();
    expect(parseApprovalPayload('{"flows":[{"key":1}],"others":[2,"a"],"memories":[{"key":"k"},{"key":"k2","text":"t"}]}')).toEqual({
      flows: [],
      others: ['a'],
      memories: [{ key: 'k2', text: 't' }],
    });
  });

  it('bước lưu trí nhớ: tick mục Triage đề xuất, gửi approved_memories', () => {
    const memPayload = JSON.stringify({ memories: [{ key: 'k2', text: 'Lỗi đã biết: Không thấy nút Thanh toán. Nguyên nhân: nút đổi id.' }] });
    const s = fold([
      ev({ kind: 'request_input', author: 'pipeline', toolCallId: 'save_memory-inv1', toolName: 'adk_request_input', text: 'Triage đề xuất lưu 1 mục.', payload: memPayload }),
      ev({ kind: 'done' }),
    ]);
    const m = s.msgs.at(-1) as RequestMsg;
    expect(m.payload?.memories).toHaveLength(1);
    const html = renderToStaticMarkup(<AgentTranscriptView msgs={s.msgs} busy={false} load={load} onRespond={() => undefined} />);
    expect(html).toContain('Pipeline chờ duyệt lưu trí nhớ');
    expect(html).toContain('Không thấy nút Thanh toán');
    expect(html).toContain('Không lưu mục nào');
    expect(html).not.toContain('Không chạy flow dữ liệu');
    expect(approvalAnswer(m, ['k2', 'bịa'], ' đúng ')).toEqual({ approved_memories: ['k2'], note: 'đúng' });
    expect(approvalAnswer(m, [], '')).toEqual({ approved_memories: [] });
  });

  it('huy hiệu chờ duyệt đếm câu hỏi; phiên chờ có chấm trong danh sách', () => {
    const pending = [
      { sessionId: 'a', title: 'Pipeline mexpress abc..def', kind: 'request_input' as const, callId: 'approve-1', at: 2 },
      { sessionId: 'b', title: 'tạo đơn', kind: 'confirmation' as const, callId: 'confirm-1', at: 1 },
    ];
    expect(renderToStaticMarkup(<PendingBadge pending={pending} activeId="" onOpen={() => undefined} />)).toContain('2 chờ duyệt');
    expect(renderToStaticMarkup(<PendingBadge pending={[]} activeId="" onOpen={() => undefined} />)).toBe('');
    const list = [{ id: 'a', title: 'Pipeline mexpress', updatedAt: 1, running: false, pending: true }];
    expect(renderToStaticMarkup(<SessionList sessions={list} activeId="" onOpen={() => undefined} onNew={() => undefined} onDelete={() => undefined} />)).toContain('aria-label="chờ duyệt"');
  });
});

describe('bản nháp sửa flow', () => {
  const draft = (p: Partial<FlowDraft>): FlowDraft => ({
    id: 'mexpress/01_login.yaml.20261124T083000000',
    app: 'mexpress',
    flow: '01_login.yaml',
    reason: 'nút đổi chữ thành có dấu',
    diff: '  appId: com.example\n- - tapOn: "Dang nhap"\n+ - tapOn: "Đăng nhập"\n',
    valid: true,
    createdAt: '2026-11-24T08:30:00Z',
    applied: false,
    ...p,
  });
  const noop = () => undefined;
  const view = (drafts: FlowDraft[], extra: Partial<Parameters<typeof DraftsView>[0]> = {}) =>
    renderToStaticMarkup(
      <DraftsView drafts={drafts} openId="" confirm={null} busy={false} error="" expanded onToggle={noop} onOpen={noop} onApply={noop} onConfirm={noop} onCancel={noop} onDiscard={noop} {...extra} />,
    );

  it('diff tách dòng thêm, bớt, giữ nguyên', () => {
    expect(diffLines('  a\n- b\n+ c\n')).toEqual([
      { tone: 'same', text: 'a' },
      { tone: 'del', text: 'b' },
      { tone: 'add', text: 'c' },
    ]);
  });

  it('không có bản nháp thì không hiện gì; có thì đếm bản chờ duyệt', () => {
    expect(view([])).toBe('');
    const html = view([draft({}), draft({ id: 'x/b.yaml.20261124T083000001', valid: false }), draft({ id: 'x/c.yaml.20261124T083000002', applied: true })]);
    expect(html).toContain('Bản nháp sửa flow (3)');
    expect(html).toContain('1 chờ duyệt');
    expect(html).toContain('Không hợp lệ');
    expect(html).toContain('Đã áp dụng');
  });

  it('mở bản nháp: lý do, diff tô màu, nút Áp dụng; bản không hợp lệ hiện lỗi và không áp dụng được', () => {
    const ok = draft({});
    const html = view([ok], { openId: ok.id });
    expect(html).toContain('nút đổi chữ thành có dấu');
    expect(html).toContain('data-tone="add"');
    expect(html).toContain('data-tone="del"');
    expect(html).toMatch(/<button type="button"[^>]*>Áp dụng<\/button>/);
    const bad = draft({ valid: false, errors: ['01_login.yaml:4: lỗi cú pháp'] });
    const badHtml = view([bad], { openId: bad.id });
    expect(badHtml).toContain('data-testid="draft-errors"');
    expect(badHtml).toMatch(/<button type="button" disabled=""[^>]*>Áp dụng<\/button>/);
  });

  it('Go đòi duyệt: hiện hậu quả và nút Đồng ý áp dụng thay cho Áp dụng', () => {
    const d = draft({});
    const html = view([d], { openId: d.id, confirm: { id: d.id, result: { needsConfirm: true, risk: 'write', consequence: 'Lưu hoặc ghi đè file', applied: false, flow: d.flow } } });
    expect(html).toContain('data-testid="draft-confirm"');
    expect(html).toContain('Ghi dữ liệu');
    expect(html).toContain('Lưu hoặc ghi đè file');
    expect(html).toContain('Đồng ý áp dụng');
    expect(html).not.toMatch(/>Áp dụng<\/button>/);
  });
});

describe('friendlyError', () => {
  it('turns a Worker code inside the raw Go error into the Vietnamese sentence', () => {
    const raw = 'anthropicmodel: api error (status 409) [type=ai_key_invalid]: ai_key_invalid';
    expect(friendlyError(raw)).toMatch(/Khoá dịch vụ AI/);
    expect(fold([ev({ kind: 'error', text: raw })]).msgs.at(-1)).toMatchObject({ type: 'error', text: expect.stringMatching(/Khoá dịch vụ AI/) });
  });
  it('keeps text it cannot map', () => {
    expect(friendlyError('agent đã gọi mô hình quá 30 lần trong một lượt')).toBe('agent đã gọi mô hình quá 30 lần trong một lượt');
  });
});
