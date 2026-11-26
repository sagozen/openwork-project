// Trạng thái khung chat agent: gộp sự kiện từ Go thành danh sách mục để vẽ. Thuần, test độc lập.
import { errorText, knownErrorCodes } from '@shell/lib/errors';
import type { AgentEvent } from './bridge';

export type ToolMsg = { type: 'tool'; id: string; author: string; name: string; args: string; status: 'running' | 'done'; resultKind?: string; imageRef?: string };

/**
 * Lỗi từ Go dạng thô ("anthropicmodel: api error (status 409) [type=ai_key_invalid]: ai_key_invalid"): nếu mang mã đã biết
 * của Worker thì hiện đúng câu tiếng Việt trong contracts/errors.json, còn lại giữ nguyên.
 */
export function friendlyError(raw: string): string {
  const code = /\[type=([a-z0-9_]+)\]/.exec(raw)?.[1] ?? /^([a-z0-9_]+)(?::|$)/.exec(raw.trim())?.[1];
  return code && knownErrorCodes().includes(code) ? errorText({ code }) : raw;
}

/** Hộp duyệt một tool: open = đang chờ; closed = đã trả lời từ trước hoặc bị bỏ khi người dùng nhắn câu khác. */
export type ConfirmMsg = {
  type: 'confirm';
  id: string;
  author: string;
  tool: string;
  args: string;
  text: string;
  risk: string;
  consequence: string;
  status: 'open' | 'approved' | 'rejected' | 'closed';
};

/** Một flow trong yêu cầu duyệt của pipeline (payload của request_input). */
export interface ApprovalFlow {
  key: string;
  app: string;
  flow: string;
  reason?: string;
}

/** Một mục Triage đề xuất lưu vào trí nhớ QA (payload của bước save_memory). */
export interface MemoryProposal {
  key: string;
  text: string;
}

/** Payload của request_input: bước duyệt flow (flows, others) hoặc bước lưu trí nhớ (memories). */
export interface ApprovalPayload {
  flows: ApprovalFlow[];
  others: string[];
  memories: MemoryProposal[];
}

/** Bước cần người của pipeline: open = đang chờ; answered = vừa trả lời; closed = đã trả lời từ trước. */
export type RequestMsg = { type: 'request'; id: string; author: string; text: string; payload: ApprovalPayload | null; status: 'open' | 'answered' | 'closed' };

export type Msg =
  | { type: 'user'; text: string }
  | { type: 'text'; author: string; text: string; streaming: boolean }
  | { type: 'progress'; author: string; text: string }
  | ToolMsg
  | ConfirmMsg
  | RequestMsg
  | { type: 'error'; text: string };

export interface ChatState {
  msgs: Msg[];
  busy: boolean;
  /** Chi phí của lượt vừa xong (từ sự kiện done). */
  costUsd: number;
  costVnd: number;
}

export const emptyState: ChatState = { msgs: [], busy: false, costUsd: 0, costVnd: 0 };

/** Câu hiện thay người dùng khi pipeline chạy từ màn Git impact. Vd "Chạy pipeline receiving abc1234..HEAD". */
export function pipelineLabel(repo: string, from: string, to: string): string {
  const name = repo.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || repo;
  return `Chạy pipeline ${name} ${from}..${to || 'HEAD'}`;
}

/** Hộp duyệt tool còn mở bị bỏ khi người dùng nhắn câu khác (Go cũng coi như bỏ). */
const dropOpenConfirms = (m: Msg[]): Msg[] => m.map((x) => (x.type === 'confirm' && x.status === 'open' ? { ...x, status: 'closed' } : x));

/** Người dùng vừa gửi: thêm câu của họ và đánh dấu đang chạy. */
export const sendUser = (s: ChatState, text: string): ChatState => ({ ...s, msgs: [...dropOpenConfirms(s.msgs), { type: 'user', text }], busy: true, costUsd: 0, costVnd: 0 });

/** Người dùng bấm Đồng ý / Từ chối: hộp đổi trạng thái và lượt chạy tiếp. */
export const answerConfirm = (s: ChatState, id: string, approved: boolean): ChatState => ({
  ...s,
  msgs: s.msgs.map((m) => (m.type === 'confirm' && m.id === id && m.status === 'open' ? { ...m, status: approved ? 'approved' : 'rejected' } : m)),
  busy: true,
});

/** Người dùng gửi câu trả lời cho bước duyệt của pipeline. */
export const answerRequest = (s: ChatState, id: string): ChatState => ({
  ...s,
  msgs: s.msgs.map((m) => (m.type === 'request' && m.id === id && m.status === 'open' ? { ...m, status: 'answered' } : m)),
  busy: true,
});

/** Trả lời bị Go từ chối (vd đã có người trả lời): mở lại để người dùng thấy và thử lại. */
export const reopen = (s: ChatState, id: string): ChatState => ({
  ...s,
  msgs: s.msgs.map((m) => ((m.type === 'confirm' || m.type === 'request') && m.id === id ? { ...m, status: 'open' } : m)),
  busy: false,
});

/** Đọc payload của yêu cầu duyệt pipeline; sai dạng thì null (form chỉ hiện câu hỏi). */
export function parseApprovalPayload(raw?: string): ApprovalPayload | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { flows?: unknown; others?: unknown; memories?: unknown };
    const flows = Array.isArray(v.flows)
      ? v.flows.filter((f): f is ApprovalFlow => !!f && typeof (f as ApprovalFlow).key === 'string' && typeof (f as ApprovalFlow).flow === 'string')
      : [];
    const others = Array.isArray(v.others) ? v.others.filter((o): o is string => typeof o === 'string') : [];
    const memories = Array.isArray(v.memories)
      ? v.memories.filter((m): m is MemoryProposal => !!m && typeof (m as MemoryProposal).key === 'string' && typeof (m as MemoryProposal).text === 'string')
      : [];
    return { flows, others, memories };
  } catch {
    return null;
  }
}

const lastOf = (m: Msg[]) => m[m.length - 1];
const withoutTrailingProgress = (m: Msg[]) => (lastOf(m)?.type === 'progress' ? m.slice(0, -1) : m);

/** Gộp một sự kiện vào trạng thái. */
export function reduce(s: ChatState, ev: AgentEvent): ChatState {
  const author = ev.author ?? '';
  const msgs = s.msgs;
  switch (ev.kind) {
    case 'text_delta': {
      const l = lastOf(msgs);
      if (l?.type === 'text' && l.streaming && l.author === author) return { ...s, msgs: [...msgs.slice(0, -1), { ...l, text: l.text + (ev.text ?? '') }] };
      return { ...s, msgs: [...withoutTrailingProgress(msgs), { type: 'text', author, text: ev.text ?? '', streaming: true }] };
    }
    case 'text': {
      if (author === 'user') return { ...s, msgs: [...msgs, { type: 'user', text: ev.text ?? '' }] };
      const l = lastOf(msgs);
      // Bản cuối thay bản đang hiện dần cùng tác giả; dòng tiến độ biến mất khi có kết quả.
      if (l?.type === 'text' && l.streaming && l.author === author) return { ...s, msgs: [...msgs.slice(0, -1), { type: 'text', author, text: ev.text ?? '', streaming: false }] };
      return { ...s, msgs: [...withoutTrailingProgress(msgs), { type: 'text', author, text: ev.text ?? '', streaming: false }] };
    }
    case 'progress': {
      const l = lastOf(msgs);
      const item: Msg = { type: 'progress', author, text: ev.text ?? '' };
      return { ...s, msgs: l?.type === 'progress' && l.author === author ? [...msgs.slice(0, -1), item] : [...msgs, item] };
    }
    case 'tool_call':
      return { ...s, msgs: [...msgs, { type: 'tool', id: ev.toolCallId ?? '', author, name: ev.toolName ?? '', args: ev.argsPreview ?? '', status: 'running' }] };
    case 'tool_result': {
      const i = msgs.findIndex((m) => m.type === 'tool' && m.status === 'running' && (ev.toolCallId ? m.id === ev.toolCallId : m.name === ev.toolName));
      if (i < 0) return { ...s, msgs: [...msgs, { type: 'tool', id: ev.toolCallId ?? '', author, name: ev.toolName ?? '', args: '', status: 'done', resultKind: ev.resultKind, imageRef: ev.imageRef }] };
      const t = msgs[i] as ToolMsg;
      return { ...s, msgs: msgs.map((m, j) => (j === i ? { ...t, status: 'done', resultKind: ev.resultKind, imageRef: ev.imageRef } : m)) };
    }
    case 'confirmation':
      return {
        ...s,
        msgs: [
          ...withoutTrailingProgress(msgs),
          {
            type: 'confirm',
            id: ev.toolCallId ?? '',
            author,
            tool: ev.toolName ?? '',
            args: ev.argsPreview ?? '',
            text: ev.text ?? '',
            risk: ev.risk ?? '',
            consequence: ev.consequence ?? '',
            status: ev.resolved ? 'closed' : 'open',
          },
        ],
      };
    case 'request_input':
      return {
        ...s,
        msgs: [
          ...withoutTrailingProgress(msgs),
          { type: 'request', id: ev.toolCallId ?? '', author, text: ev.text ?? '', payload: parseApprovalPayload(ev.payload), status: ev.resolved ? 'closed' : 'open' },
        ],
      };
    case 'error':
      return { ...s, msgs: [...msgs, { type: 'error', text: friendlyError(ev.text ?? '') }] };
    case 'done':
      // Tool còn "đang chạy" khi lượt dừng (bấm dừng, lỗi) không được quay mãi.
      return {
        msgs: msgs
          .filter((m) => m.type !== 'progress')
          .map((m): Msg => (m.type === 'tool' && m.status === 'running' ? { ...m, status: 'done' } : m.type === 'text' ? { ...m, streaming: false } : m)),
        busy: false,
        costUsd: ev.costUsd ?? 0,
        costVnd: ev.costVnd ?? 0,
      };
    default:
      return s;
  }
}

/** Vẽ lại một phiên đã lưu từ các sự kiện của nó. */
export function fromHistory(events: AgentEvent[]): ChatState {
  return events.reduce(reduce, emptyState);
}

/** Một dòng kết quả flow của Runner: "✓ flow đạt", "✗ flow lỗi [lớp]: lý do", "⚠ ...". */
export interface RunLine {
  tone: 'pass' | 'fail' | 'warn' | 'plain';
  text: string;
}

export function parseRunLines(text: string): RunLine[] {
  return text
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((raw): RunLine => {
      const t = raw.trim();
      if (t.startsWith('✓')) return { tone: 'pass', text: t.slice(1).trim() };
      if (t.startsWith('✗')) return { tone: 'fail', text: t.slice(1).trim() };
      if (t.startsWith('⚠')) return { tone: 'warn', text: t.slice(1).trim() };
      return { tone: 'plain', text: raw.trimEnd() };
    });
}

export const formatUsd = (v: number) => (v < 0.1 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`);
export const formatVnd = (v: number) => `${Math.round(v).toLocaleString('vi-VN')} đ`;

/** Tên tool hiện cho người dùng; chuyển agent hiện là "chuyển cho …". */
export function toolLabel(name: string, args: string): string {
  if (name === 'transfer_to_agent') {
    const m = /"agent_name"\s*:\s*"([^"]+)"/.exec(args);
    return m ? `chuyển cho ${m[1]}` : 'chuyển agent';
  }
  return name;
}
