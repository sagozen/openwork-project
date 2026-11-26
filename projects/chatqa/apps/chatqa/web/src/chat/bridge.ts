// Cầu nối tới chat ở Go (window.go.chat.Service.*, apps/chatqa/desktop/internal/modules/chat).
import { ApiError } from '@shell/platform';
import { goFn } from '@shell/platform/desktop';
import { parseErrorCode, parseErrorParams } from '@shell/lib/errors';

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatItem {
  at?: string;
  role: 'user' | 'assistant' | 'component';
  text?: string;
  kind?: string;
  data?: unknown;
}

export interface ChatEvent {
  conversationId: string;
  type: 'text' | 'component' | 'done';
  text?: string;
  kind?: string;
  data?: unknown;
}

async function call<T>(fn: string, ...args: unknown[]): Promise<T> {
  try {
    return (await goFn(`chat.Service.${fn}`)(...args)) as T;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    const msg = String(e instanceof Error ? e.message : e);
    throw new ApiError(parseErrorCode(msg), 0, parseErrorParams(msg));
  }
}

export const chatApi = {
  conversations: () => call<Conversation[] | null>('Conversations').then((r) => r ?? []),
  newConversation: (title: string) => call<Conversation>('NewConversation', title),
  history: (id: string) => call<ChatItem[] | null>('History', id).then((r) => r ?? []),
  send: (id: string, text: string, confirmToken = '') => call<void>('Send', id, text, confirmToken),
  runTool: (id: string, tool: string, args: Record<string, unknown>) => call<void>('RunTool', id, tool, JSON.stringify(args)),
  cancel: (id: string) => call<boolean>('Cancel', id),
};

/** Nghe tiến độ chat do Go phát ("chat:event"); trả hàm huỷ nghe. */
export function onChatEvent(cb: (ev: ChatEvent) => void): () => void {
  const rt = (window as unknown as { runtime?: { EventsOn: (n: string, cb: (d: unknown) => void) => unknown; EventsOff: (n: string) => void } }).runtime;
  if (!rt) return () => undefined;
  const off = rt.EventsOn('chat:event', (d) => cb(d as ChatEvent));
  return typeof off === 'function' ? (off as () => void) : () => rt.EventsOff('chat:event');
}
