// Chat ở khung giữa của màn làm việc (desktop): lịch sử chữ và component, thanh lệnh ⌘K ở dưới.
// Lệnh ngắn chạy ngay không qua AI (Go quyết định); câu khác qua agent, chữ hiện dần qua sự kiện "chat:event".
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { MessageSquareText, Send, Square } from 'lucide-react';
import { ApiError } from '@shell/platform';
import { cx } from '@shell/components/ui/cx';
import { CentreEmpty, searchShortcut } from '../workspace/Workspace';
import { chatApi, onChatEvent, type ChatItem } from './bridge';
import { ChatComponent, type ChatActions } from './components';
import { noActions } from './components/shared';
import { useLiveOptional } from '../live/LiveProvider';
import { useOpenTestSettings } from '../live/DeviceList';
import { testApi } from '../testing/bridge';

interface ChatState {
  items: ChatItem[];
  busy: boolean;
  send: (text: string) => Promise<void>;
  cancel: () => void;
  actions: ChatActions;
}

const Ctx = createContext<ChatState | null>(null);

/** Hành động của component chat (gọi tool, xác nhận) dùng được ngoài khung chat, vd ô Hoạt động. */
export const useChatActions = (): ChatActions => useContext(Ctx)?.actions ?? noActions;

function useChat(): ChatState {
  const c = useContext(Ctx);
  if (!c) throw new Error('ChatProvider chưa bọc ngoài');
  return c;
}

const errorItem = (e: unknown): ChatItem => ({
  role: 'component',
  kind: 'ErrorCard',
  data: { code: e instanceof ApiError ? e.code : 'error', message: e instanceof Error ? e.message : String(e) },
});

export function ChatProvider({ children }: { children: ReactNode }) {
  const [convId, setConvId] = useState<string>();
  const [items, setItems] = useState<ChatItem[]>([]);
  const [busy, setBusy] = useState(false);
  const openLive = useLiveOptional()?.open;
  const openSettings = useOpenTestSettings();
  const conv = useRef<string | undefined>(undefined);
  conv.current = convId;

  // Mở lại cuộc chat gần nhất.
  useEffect(() => {
    void (async () => {
      try {
        const list = await chatApi.conversations();
        if (list[0]) {
          setConvId(list[0].id);
          setItems(await chatApi.history(list[0].id));
        }
      } catch {
        // chưa có tháp/engine hoặc chưa đăng nhập: chat trống
      }
    })();
  }, []);

  // Chữ đang viết nối vào mục trả lời cuối; component thành mục riêng.
  useEffect(
    () =>
      onChatEvent((ev) => {
        if (ev.conversationId !== conv.current) return;
        if (ev.type === 'done') return setBusy(false);
        setItems((prev) => {
          if (ev.type === 'text') {
            const last = prev[prev.length - 1];
            if (last?.role === 'assistant') return [...prev.slice(0, -1), { ...last, text: (last.text ?? '') + (ev.text ?? '') }];
            return [...prev, { role: 'assistant', text: ev.text ?? '' }];
          }
          return [...prev, { role: 'component', kind: ev.kind, data: ev.data }];
        });
      }),
    [],
  );

  const ensureConv = useCallback(async (title: string) => {
    if (conv.current) return conv.current;
    const c = await chatApi.newConversation(title.slice(0, 60));
    setConvId(c.id);
    conv.current = c.id;
    return c.id;
  }, []);

  const run = useCallback(async (fn: (id: string) => Promise<void>, title: string) => {
    setBusy(true);
    try {
      await fn(await ensureConv(title));
    } catch (e) {
      setItems((prev) => [...prev, errorItem(e)]);
    } finally {
      setBusy(false);
    }
  }, [ensureConv]);

  const send = useCallback(
    async (text: string) => {
      const t = text.trim();
      if (!t) return;
      setItems((prev) => [...prev, { role: 'user', text: t }]);
      await run((id) => chatApi.send(id, t), t);
    },
    [run],
  );

  const actions = useMemo<ChatActions>(
    () => ({
      runTool: (tool, args) => void run((id) => chatApi.runTool(id, tool, args), tool),
      confirmChat: (token) => void run((id) => chatApi.send(id, '', token), 'Xác nhận'),
      openLive,
      openSettings,
      // Báo cáo nằm trên máy: mở thư mục lượt hoặc evidence.html; lỗi hiện thành thẻ lỗi trong chat.
      openRun: (runId, what) =>
        void (what === 'folder' ? testApi.openRunFolder(runId) : testApi.openRunReport(runId)).catch((e: unknown) => setItems((prev) => [...prev, errorItem(e)])),
    }),
    [run, openLive, openSettings],
  );

  const cancel = useCallback(() => {
    if (conv.current) void chatApi.cancel(conv.current);
  }, []);

  const value = useMemo(() => ({ items, busy, send, cancel, actions }), [items, busy, send, cancel, actions]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Lịch sử chat (thuần, render và test độc lập). */
export function Transcript({ items, actions, busy }: { items: ChatItem[]; actions: ChatActions; busy?: boolean }) {
  if (items.length === 0) return <CentreEmpty />;
  return (
    <div className="flex flex-col gap-[10px] px-[16px] py-[14px]" data-testid="chat-transcript">
      {items.map((it, i) =>
        it.role === 'user' ? (
          <p key={i} className="max-w-[80%] self-end whitespace-pre-wrap rounded-[12px] bg-accent px-[12px] py-[8px] text-[13px]/[18px] text-white">
            {it.text}
          </p>
        ) : it.role === 'assistant' ? (
          <p key={i} className="max-w-[90%] whitespace-pre-wrap text-[13px]/[19px] text-text">
            {it.text}
          </p>
        ) : (
          <div key={i} className="max-w-full">
            <ChatComponent kind={it.kind ?? ''} data={it.data} actions={actions} />
          </div>
        ),
      )}
      {busy && <p className="text-[12px]/[16px] text-text-3">Đang làm…</p>}
    </div>
  );
}

/**
 * Khung lịch sử chat: theo nội dung mới khi người dùng đang ở cuối, không kéo màn hình khi họ đã cuộn lên đọc.
 * Chữ trả lời hiện dần nên theo cả chiều dài chứ không chỉ số mục.
 */
export function ChatTranscript() {
  const { items, actions, busy, send } = useChat();
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    const el = box.current;
    // Người dùng vừa gửi tin thì luôn kéo xuống cuối để thấy câu trả lời, kể cả khi trước đó họ đã cuộn lên đọc.
    if (items[items.length - 1]?.role === 'user') stick.current = true;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items]);
  if (items.length === 0)
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <CentreEmpty onExample={(t) => void send(t)} busy={busy} />
      </div>
    );
  return (
    <div
      ref={box}
      role="log"
      aria-label="Lịch sử trò chuyện"
      aria-live="polite"
      aria-relevant="additions text"
      aria-busy={busy || undefined}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
      }}
      className="min-h-0 flex-1 overflow-y-auto"
    >
      <Transcript items={items} actions={actions} busy={busy} />
    </div>
  );
}

/** Thanh lệnh: ⌘K/Ctrl K để gõ; Enter gửi. */
export function ChatInput() {
  const { send, busy, cancel } = useChat();
  const [text, setText] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);
  const submit = () => {
    if (!text.trim() || busy) return;
    void send(text);
    setText('');
  };
  return (
    <form
      className="stroke-in flex h-[40px] items-center gap-[10px] rounded-[10px] bg-surface px-[12px] focus-within:[--stroke-c:var(--color-accent)]"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <MessageSquareText size={16} className="shrink-0 text-text-3" />
      <input
        ref={input}
        value={text}
        onChange={(e) => setText(e.target.value)}
        aria-label="Lệnh cho ChatQASoftware"
        placeholder="Gõ lệnh: “chạy flow đăng nhập trên 3 máy, báo p95”, “dừng tất cả”…"
        className="min-w-0 flex-1 bg-transparent text-[13px]/[16px] outline-none placeholder:text-text-3"
      />
      <kbd className="hidden shrink-0 font-mono text-[10.5px]/[14px] text-text-3 lg:inline">{searchShortcut()}</kbd>
      {busy ? (
        <button
          type="button"
          onClick={cancel}
          aria-label="Dừng trả lời"
          title="Dừng trả lời"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[7px] text-text-2 hover:bg-muted-box hover:text-text"
        >
          <Square size={15} />
        </button>
      ) : (
        <button
          type="submit"
          aria-label="Gửi lệnh"
          title="Gửi lệnh"
          disabled={!text.trim()}
          className={cx(
            'flex h-8 w-8 shrink-0 items-center justify-center rounded-[7px] disabled:cursor-not-allowed',
            text.trim() ? 'text-accent hover:bg-accent-soft' : 'text-text-3',
          )}
        >
          <Send size={15} />
        </button>
      )}
    </form>
  );
}
