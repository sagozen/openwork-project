// Cầu nối tới chat agent ADK ở Go (window.go.agentchat.Service.*, apps/chatqa/desktop/internal/modules/agentchat).
// Kiểu dưới đây khớp JSON của agentx/runtime.Event và Service.Status.
import { ApiError } from '@shell/platform';
import { goFn } from '@shell/platform/desktop';
import { parseErrorCode, parseErrorParams } from '@shell/lib/errors';

export type AgentEventKind = 'text' | 'text_delta' | 'progress' | 'tool_call' | 'tool_result' | 'confirmation' | 'request_input' | 'error' | 'done';

export interface AgentEvent {
  sessionId: string;
  invocationId?: string;
  author?: string;
  kind: AgentEventKind;
  text?: string;
  toolName?: string;
  toolCallId?: string;
  argsPreview?: string;
  resultKind?: string;
  imageRef?: string;
  partial?: boolean;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  costVnd?: number;
  at?: number;
  /** confirmation: mức rủi ro của tool đang chờ duyệt (read | run | write | dangerous) và hậu quả. */
  risk?: string;
  consequence?: string;
  /** request_input: JSON (đã che bí mật) để dựng form trả lời. */
  payload?: string;
  /** Trong lịch sử: câu hỏi đã được trả lời hoặc đã bỏ. */
  resolved?: boolean;
}

/** Câu hỏi đang chờ người dùng (Status.pending), kể cả từ trước khi mở lại app. */
export interface PendingItem {
  sessionId: string;
  title: string;
  kind: 'confirmation' | 'request_input';
  callId: string;
  toolName?: string;
  text?: string;
  at: number;
}

export interface ModelPrice {
  alias: string;
  name: string;
  id: string;
  inUsdPerM: number;
  outUsdPerM: number;
}

export interface AgentStatus {
  enabled: boolean;
  engine: 'legacy' | 'adk';
  ready: boolean;
  error?: string;
  models: ModelPrice[];
  defaultModel: string;
  agents: Record<string, string>;
  agentNames: string[];
  maxCostUsd: number;
  pending?: PendingItem[];
}

export interface SessionInfo {
  id: string;
  title: string;
  updatedAt: number;
  running: boolean;
  pending?: boolean;
}

/** Bản nháp sửa flow do FlowFixer đề xuất (agents.DraftInfo). Flow chỉ đổi khi người dùng bấm Áp dụng. */
export interface FlowDraft {
  id: string;
  app: string;
  flow: string;
  reason: string;
  /** Các dòng "-"/"+"/" " so với flow lúc đề xuất. */
  diff: string;
  valid: boolean;
  errors?: string[];
  createdAt: string;
  applied: boolean;
}

/** Kết quả ApplyDraft: needsConfirm = chưa ghi gì, cần người dùng duyệt rồi gọi lại với confirmed. */
export interface ApplyDraftResult {
  needsConfirm: boolean;
  risk?: string;
  consequence?: string;
  reasons?: string[];
  applied: boolean;
  flow?: string;
}

async function call<T>(fn: string, ...args: unknown[]): Promise<T> {
  try {
    return (await goFn(`agentchat.Service.${fn}`)(...args)) as T;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    const msg = String(e instanceof Error ? e.message : e);
    throw new ApiError(parseErrorCode(msg), 0, parseErrorParams(msg));
  }
}

export const agentApi = {
  status: () => call<AgentStatus>('Status'),
  send: (sessionId: string, text: string) => call<string>('Send', sessionId, text),
  /** Chạy pipeline sau deploy cho diff from..to (to rỗng = HEAD); trả mã phiên ngay, tiến độ qua "agent:event". */
  runPipeline: (repo: string, from: string, to: string) => call<string>('RunPipeline', repo, from, to),
  /** Trả lời hộp duyệt tool rồi chạy tiếp lượt đó; tiến độ qua "agent:event". payload là {} chứ không phải null: với đối số `any` bằng null, lời gọi Wails treo im lặng và không tới Go. */
  approve: (sessionId: string, callId: string, approved: boolean) => call<void>('Approve', sessionId, callId, approved, {}),
  /** Trả lời bước duyệt của pipeline bằng một đối tượng JSON rồi chạy tiếp pipeline. */
  respond: (sessionId: string, interruptId: string, reply: unknown) => call<void>('Respond', sessionId, interruptId, JSON.stringify(reply)),
  cancel: (sessionId: string) => call<boolean>('Cancel', sessionId),
  sessions: () => call<SessionInfo[] | null>('Sessions').then((r) => r ?? []),
  session: (id: string) => call<AgentEvent[] | null>('Session', id).then((r) => r ?? []),
  deleteSession: (id: string) => call<void>('DeleteSession', id),
  image: (ref: string) => call<string>('Image', ref),
  setModel: (agent: string, alias: string) => call<void>('SetModel', agent, alias),
  setEngine: (engine: 'legacy' | 'adk') => call<void>('SetEngine', engine),
  reloadConfig: () => call<void>('ReloadConfig'),
  drafts: () => call<FlowDraft[] | null>('Drafts').then((r) => r ?? []),
  /** Áp dụng bản nháp qua test_apply_repair; lần đầu confirmed=false để Go nói có cần duyệt không. */
  applyDraft: (id: string, confirmed: boolean) => call<ApplyDraftResult>('ApplyDraft', id, confirmed),
  discardDraft: (id: string) => call<void>('DiscardDraft', id),
};

/** Nghe tiến độ agent do Go phát ("agent:event"); trả hàm huỷ nghe. */
export function onAgentEvent(cb: (ev: AgentEvent) => void): () => void {
  const rt = (window as unknown as { runtime?: { EventsOn: (n: string, cb: (d: unknown) => void) => unknown; EventsOff: (n: string) => void } }).runtime;
  if (!rt) return () => undefined;
  const off = rt.EventsOn('agent:event', (d) => cb(d as AgentEvent));
  return typeof off === 'function' ? (off as () => void) : () => rt.EventsOff('agent:event');
}
