// Chat với đội agent ADK (engine: adk): chữ hiện dần, agent nào đang làm, tool đang chạy, kết quả flow, lịch sử phiên,
// chọn model từng agent và chi phí sau mỗi lượt. Thay cho ChatPane khi agent.engine = adk (xem engine.tsx).
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowUp, BellRing, Check, CheckCircle2, ChevronDown, Copy, Loader2, Pin, PinOff, Plus, Sparkles, Square, Trash2, TriangleAlert, Wrench, X, XCircle } from 'lucide-react';
import { ApiError } from '@shell/platform';
import { cx } from '@shell/components/ui/cx';
import { agentApi, onAgentEvent, type AgentStatus, type PendingItem, type SessionInfo } from './bridge';
import { answerConfirm, answerRequest, emptyState, formatUsd, formatVnd, fromHistory, parseRunLines, pipelineLabel, reduce, reopen, sendUser, toolLabel, type ChatState, type Msg, type ToolMsg } from './state';
import { ConfirmDialog } from './ConfirmDialog';
import { ApprovalForm, type ApprovalAnswer } from './ApprovalForm';
import { DraftsPanel } from './Drafts';
import { RichText, renderInline } from './RichText';
import { pinKey, usePins, type Pin as PinT } from './pins';
import { followUps, STARTERS } from './suggestions';

interface AgentChat {
  state: ChatState;
  status: AgentStatus | null;
  sessions: SessionInfo[];
  sessionId: string;
  send: (text: string) => Promise<void>;
  /** Chạy pipeline sau deploy trong một phiên mới và hiện phiên đó; trả mã phiên. */
  startPipeline: (repo: string, from: string, to: string) => Promise<string>;
  cancel: () => void;
  openSession: (id: string) => Promise<void>;
  newSession: () => void;
  deleteSession: (id: string) => Promise<void>;
  setModel: (agent: string, alias: string) => Promise<void>;
  /** Trả lời hộp duyệt tool của phiên đang mở. */
  approve: (callId: string, approved: boolean) => Promise<void>;
  /** Trả lời bước duyệt của pipeline trong phiên đang mở. */
  respond: (interruptId: string, answer: ApprovalAnswer) => Promise<void>;
}

const Ctx = createContext<AgentChat | null>(null);

/** Chat agent nếu đang dùng engine adk, ngược lại null (để màn khác chỉ hiện nút khi có đội agent). */
export const useOptionalAgentChat = (): AgentChat | null => useContext(Ctx);

function useAgentChat(): AgentChat {
  const c = useContext(Ctx);
  if (!c) throw new Error('AgentChatProvider chưa bọc ngoài');
  return c;
}

const errText = (e: unknown) => (e instanceof ApiError ? `${e.code}${e.params && Object.keys(e.params).length ? `: ${JSON.stringify(e.params)}` : ''}` : e instanceof Error ? e.message : String(e));

export function AgentChatProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ChatState>(emptyState);
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [sessionId, setSessionId] = useState('');
  const current = useRef('');
  current.current = sessionId;

  const refreshSessions = useCallback(async () => {
    try {
      setSessions(await agentApi.sessions());
    } catch {
      // chưa sẵn sàng (chưa đăng nhập, agent chưa bật): danh sách trống
    }
  }, []);

  // Trạng thái mang cả câu hỏi đang chờ (kể cả từ trước khi mở lại app): đọc lại sau mỗi lượt.
  const refreshStatus = useCallback(() => {
    void agentApi.status().then(setStatus, () => undefined);
  }, []);

  useEffect(() => {
    refreshStatus();
    void refreshSessions();
  }, [refreshSessions, refreshStatus]);

  // Phiên mới chưa có mã: lượt đầu trả mã, sự kiện của nó cũng mang mã đó nên nhận khi chưa có phiên hiện tại.
  useEffect(
    () =>
      onAgentEvent((ev) => {
        if (current.current && ev.sessionId !== current.current) return;
        if (!current.current) {
          current.current = ev.sessionId;
          setSessionId(ev.sessionId);
        }
        setState((s) => reduce(s, ev));
        if (ev.kind === 'done') {
          void refreshSessions();
          refreshStatus();
        }
      }),
    [refreshSessions, refreshStatus],
  );

  const send = useCallback(async (text: string) => {
    const t = text.trim();
    if (!t) return;
    setState((s) => sendUser(s, t));
    try {
      const id = await agentApi.send(current.current, t);
      if (id && id !== current.current) {
        current.current = id;
        setSessionId(id);
      }
    } catch (e) {
      setState((s) => ({ ...reduce(s, { sessionId: current.current, kind: 'error', text: errText(e) }), busy: false }));
    }
  }, []);

  const startPipeline = useCallback(
    async (repo: string, from: string, to: string) => {
      // Phiên mới: sự kiện đầu tiên mang mã phiên nên được nhận trước cả khi Go trả mã.
      current.current = '';
      setSessionId('');
      setState(sendUser(emptyState, pipelineLabel(repo, from, to)));
      try {
        const id = await agentApi.runPipeline(repo, from, to);
        current.current = id;
        setSessionId(id);
        void refreshSessions();
        return id;
      } catch (e) {
        setState((s) => ({ ...reduce(s, { sessionId: '', kind: 'error', text: errText(e) }), busy: false }));
        throw e;
      }
    },
    [refreshSessions],
  );

  const cancel = useCallback(() => {
    if (current.current) void agentApi.cancel(current.current);
  }, []);

  const openSession = useCallback(async (id: string) => {
    try {
      const events = await agentApi.session(id);
      current.current = id;
      setSessionId(id);
      setState(fromHistory(events));
    } catch (e) {
      setState((s) => reduce(s, { sessionId: id, kind: 'error', text: errText(e) }));
    }
  }, []);

  const newSession = useCallback(() => {
    current.current = '';
    setSessionId('');
    setState(emptyState);
  }, []);

  const deleteSession = useCallback(
    async (id: string) => {
      await agentApi.deleteSession(id);
      if (id === current.current) newSession();
      await refreshSessions();
    },
    [newSession, refreshSessions],
  );

  const setModel = useCallback(async (agent: string, alias: string) => {
    await agentApi.setModel(agent, alias);
    setStatus(await agentApi.status());
  }, []);

  // Trả lời chạy tiếp lượt đó tới khi xong; tiến độ về qua "agent:event". Go từ chối (đã có người trả lời, phiên đang
  // chạy) thì mở lại hộp và hiện lỗi.
  const answer = useCallback(
    async (id: string, mark: (s: ChatState) => ChatState, run: (sessionId: string) => Promise<void>) => {
      const sid = current.current;
      if (!sid) return;
      setState(mark);
      try {
        await run(sid);
      } catch (e) {
        setState((s) => reduce(reopen(s, id), { sessionId: sid, kind: 'error', text: errText(e) }));
      } finally {
        refreshStatus();
        void refreshSessions();
      }
    },
    [refreshSessions, refreshStatus],
  );

  const approve = useCallback(
    (callId: string, approved: boolean) => answer(callId, (s) => answerConfirm(s, callId, approved), (sid) => agentApi.approve(sid, callId, approved)),
    [answer],
  );

  const respond = useCallback(
    (interruptId: string, reply: ApprovalAnswer) => answer(interruptId, (s) => answerRequest(s, interruptId), (sid) => agentApi.respond(sid, interruptId, reply)),
    [answer],
  );

  const value = useMemo(
    () => ({ state, status, sessions, sessionId, send, startPipeline, cancel, openSession, newSession, deleteSession, setModel, approve, respond }),
    [state, status, sessions, sessionId, send, startPipeline, cancel, openSession, newSession, deleteSession, setModel, approve, respond],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

const AUTHOR_LABEL: Record<string, string> = {
  coordinator: 'Điều phối',
  planner: 'Lập kế hoạch',
  runner: 'Chạy flow',
  triage: 'Phân loại lỗi',
  reporter: 'Báo cáo',
  flowfixer: 'Sửa flow',
  author: 'Soạn flow',
  pipeline: 'Pipeline',
};

/** Màu và chữ viết tắt của ảnh đại diện từng agent, như avatar bot trong Telegram. */
const AVATAR: Record<string, { bg: string; ch: string }> = {
  coordinator: { bg: 'bg-[#0b2244]', ch: 'ĐP' },
  planner: { bg: 'bg-[#5b4bdb]', ch: 'KH' },
  runner: { bg: 'bg-[#0e7c66]', ch: 'CF' },
  triage: { bg: 'bg-[#c2410c]', ch: 'PL' },
  reporter: { bg: 'bg-[#0369a1]', ch: 'BC' },
  flowfixer: { bg: 'bg-[#a21caf]', ch: 'SF' },
  pipeline: { bg: 'bg-[#e4002b]', ch: 'PL' },
};

function AgentAvatar({ author }: { author: string }) {
  const a = AVATAR[author] ?? { bg: 'bg-text-2', ch: (AUTHOR_LABEL[author] ?? author).slice(0, 2).toUpperCase() || 'AI' };
  return (
    <span aria-hidden className={cx('flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full text-[10.5px]/[12px] font-bold tracking-[0.3px] text-white shadow-sm', a.bg)}>
      {a.ch}
    </span>
  );
}

/** Huy hiệu agent đang nói. */
export function AgentBadge({ author }: { author: string }) {
  if (!author || author === 'user') return null;
  return (
    <span className="text-[12px]/[16px] font-semibold text-text" data-testid="agent-badge">
      {AUTHOR_LABEL[author] ?? author}
    </span>
  );
}

type PlanJson = { flows?: { app?: string; flow?: string; reason?: string }[]; platforms?: string[]; error?: string };

/** Kế hoạch của agent Lập kế hoạch là JSON; đọc được thì trả về, không thì null (hiện nguyên văn). */
export function parsePlan(text: string): PlanJson | null {
  const t = text.trim();
  if (!t.startsWith('{')) return null;
  try {
    const v = JSON.parse(t) as PlanJson;
    return v && typeof v === 'object' && Array.isArray(v.flows) ? v : null;
  } catch {
    return null;
  }
}

/** Kế hoạch dạng danh sách: chạy flow nào, trên nền tảng nào, vì sao. */
export function PlanText({ plan }: { plan: PlanJson }) {
  const flows = plan.flows ?? [];
  const where = plan.platforms?.length ? ` trên ${plan.platforms.join(', ')}` : '';
  return (
    <div className="flex flex-col gap-[3px] text-[13px]/[18px]" data-testid="plan">
      <p className="font-semibold text-text">{flows.length === 0 ? 'Không có flow nào cần chạy' : `Chạy ${flows.length} flow${where}`}</p>
      {flows.length > 0 && (
        <ul className="flex flex-col gap-[3px]">
          {flows.map((f, i) => (
            <li key={i} className="text-text-2">
              <span className="font-medium text-text">{[f.app, f.flow].filter(Boolean).join(' › ')}</span>
              {f.reason ? <span> — {f.reason}</span> : null}
            </li>
          ))}
        </ul>
      )}
      {plan.error ? <p className="text-red">{plan.error}</p> : null}
    </div>
  );
}

/** Thẻ kết quả chạy flow: thanh tổng đạt/lỗi/cảnh báo rồi từng dòng; dòng thường vẽ như nội dung giàu. */
function RunCard({ text }: { text: string }) {
  const lines = parseRunLines(text);
  const count = (t: string) => lines.filter((l) => l.tone === t).length;
  const [pass, fail, warn] = [count('pass'), count('fail'), count('warn')];
  const total = pass + fail + warn;
  return (
    <div className="flex flex-col gap-[8px]" data-testid="run-card">
      <div className="flex flex-wrap items-center gap-[6px] text-[11.5px]/[15px] font-semibold">
        {pass > 0 && <span className="rounded-full bg-green-soft px-[8px] py-[2px] text-green">{pass} đạt</span>}
        {fail > 0 && <span className="rounded-full bg-red-soft px-[8px] py-[2px] text-red">{fail} lỗi</span>}
        {warn > 0 && <span className="rounded-full bg-amber-soft px-[8px] py-[2px] text-text">{warn} cảnh báo</span>}
      </div>
      <div className="flex h-[5px] overflow-hidden rounded-full bg-muted-box" aria-hidden>
        <span className="bg-green" style={{ width: `${(pass / total) * 100}%` }} />
        <span className="bg-red" style={{ width: `${(fail / total) * 100}%` }} />
        <span className="bg-amber" style={{ width: `${(warn / total) * 100}%` }} />
      </div>
      <ul className="flex flex-col gap-[2px] text-[13px]/[18px]" data-testid="run-lines">
        {lines.map((l, i) => (
          <li
            key={i}
            className={cx(
              'flex items-start gap-[7px] rounded-[6px]',
              l.tone === 'fail' && 'bg-red-soft/60 px-[6px] py-[3px]',
              l.tone === 'plain' && 'mt-[2px] font-semibold text-text-2',
              (l.tone === 'pass' || l.tone === 'warn') && 'px-[6px] py-[2px]',
            )}
          >
            {l.tone === 'pass' && <CheckCircle2 size={14} className="mt-[2px] shrink-0 text-green" aria-label="đạt" />}
            {l.tone === 'fail' && <XCircle size={14} className="mt-[2px] shrink-0 text-red" aria-label="lỗi" />}
            {l.tone === 'warn' && <TriangleAlert size={14} className="mt-[2px] shrink-0 text-amber" aria-label="cảnh báo" />}
            <span className="min-w-0">{renderInline(l.text.trim())}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Nội dung một câu trả lời: kế hoạch dạng danh sách, thẻ kết quả nếu có dòng ✓ ✗ ⚠, ngược lại nội dung giàu. */
function MessageBody({ author, text }: { author: string; text: string }) {
  const plan = author === 'planner' ? parsePlan(text) : null;
  if (plan) return <PlanText plan={plan} />;
  return parseRunLines(text).some((l) => l.tone !== 'plain') ? <RunCard text={text} /> : <RichText text={text} />;
}

/** Ảnh màn hình theo mã; tải khi hiện ra, bấm để phóng to. */
function Shot({ imageRef, load }: { imageRef: string; load: (ref: string) => Promise<string> }) {
  const [src, setSrc] = useState('');
  const [big, setBig] = useState(false);
  useEffect(() => {
    let live = true;
    void load(imageRef).then((s) => live && setSrc(s), () => undefined);
    return () => {
      live = false;
    };
  }, [imageRef, load]);
  if (!src) return null;
  return (
    <>
      <button type="button" onClick={() => setBig(true)} className="mt-[6px] self-start overflow-hidden rounded-[8px] border border-border hover:brightness-95" title="Phóng to">
        <img src={src} alt="Ảnh màn hình" className="max-h-[180px]" />
      </button>
      {big && (
        <div role="dialog" aria-label="Ảnh màn hình" className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-[24px]" onClick={() => setBig(false)}>
          <img src={src} alt="Ảnh màn hình" className="max-h-full max-w-full rounded-[10px] shadow-2xl" />
          <button type="button" aria-label="Đóng" className="absolute right-[16px] top-[16px] rounded-full bg-white/15 p-[6px] text-white hover:bg-white/25">
            <X size={18} />
          </button>
        </div>
      )}
    </>
  );
}

export function ToolRow({ t, load }: { t: ToolMsg; load: (ref: string) => Promise<string> }) {
  return (
    <div className="flex flex-col" data-testid="tool-row" data-status={t.status}>
      <div className="flex items-center gap-[7px] text-[12px]/[16px] text-text-2">
        {t.status === 'running' ? <Loader2 size={13} className="shrink-0 animate-spin text-accent" aria-label="đang chạy" /> : <CheckCircle2 size={13} className="shrink-0 text-green" aria-label="xong" />}
        <span className="truncate font-mono">{toolLabel(t.name, t.args)}</span>
        {t.status === 'done' && t.resultKind && <span className="shrink-0 rounded-[4px] bg-surface px-[5px] text-[10.5px]/[14px] text-text-3 ring-1 ring-border">{t.resultKind}</span>}
      </div>
      {t.imageRef && <Shot imageRef={t.imageRef} load={load} />}
    </div>
  );
}

/** Các bước tool liền nhau gom thành một thẻ gập được; đang chạy thì mở sẵn. */
function ToolGroup({ tools, load }: { tools: ToolMsg[]; load: (ref: string) => Promise<string> }) {
  const running = tools.some((t) => t.status === 'running');
  const shots = tools.some((t) => t.imageRef);
  return (
    <details open={running || shots || tools.length <= 2} className="group/tools ml-[40px] max-w-[min(560px,85%)] rounded-[10px] border border-border bg-muted-box" data-testid="tool-group">
      <summary className="flex cursor-pointer list-none items-center gap-[7px] px-[10px] py-[6px] text-[11.5px]/[15px] font-semibold text-text-2 [&::-webkit-details-marker]:hidden">
        {running ? <Loader2 size={13} className="animate-spin text-accent" /> : <Wrench size={13} className="text-text-3" />}
        {running ? 'Đang dùng công cụ' : 'Đã dùng công cụ'} · {tools.length} bước
        <ChevronDown size={13} className="ml-auto text-text-3 transition-transform group-open/tools:rotate-180" />
      </summary>
      <div className="flex flex-col gap-[6px] border-t border-border px-[10px] py-[8px]">
        {tools.map((t, i) => (
          <ToolRow key={t.id || i} t={t} load={load} />
        ))}
      </div>
    </details>
  );
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      aria-label="Chép"
      title="Chép"
      onClick={() =>
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        })
      }
      className="rounded-[6px] p-[4px] text-text-3 hover:bg-muted-box hover:text-text"
    >
      {done ? <Check size={13} className="text-green" /> : <Copy size={13} />}
    </button>
  );
}

function PinButton({ pinned, onClick }: { pinned: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={pinned ? 'Bỏ ghim' : 'Ghim tin'}
      aria-pressed={pinned}
      title={pinned ? 'Bỏ ghim' : 'Ghim tin'}
      onClick={onClick}
      className={cx('rounded-[6px] p-[4px] hover:bg-muted-box', pinned ? 'text-accent' : 'text-text-3 hover:text-text')}
    >
      {pinned ? <PinOff size={13} /> : <Pin size={13} />}
    </button>
  );
}

type Item = { kind: 'msg'; m: Msg; i: number } | { kind: 'tools'; tools: ToolMsg[]; i: number };

/** Gom các tool liền nhau thành một nhóm. */
function groupItems(msgs: Msg[]): Item[] {
  const out: Item[] = [];
  msgs.forEach((m, i) => {
    const prev = out[out.length - 1];
    if (m.type === 'tool') {
      if (prev?.kind === 'tools') prev.tools.push(m);
      else out.push({ kind: 'tools', tools: [m], i });
    } else out.push({ kind: 'msg', m, i });
  });
  return out;
}

/** Thẻ khởi đầu khi phiên trống: bấm là gửi. */
function Starters({ onPick }: { onPick?: (text: string) => void }) {
  return (
    <div className="mx-auto flex w-full max-w-[640px] flex-col items-center gap-[14px] px-[16px] py-[28px] text-center" data-testid="agent-starters">
      <span className="flex h-[44px] w-[44px] items-center justify-center rounded-[14px] bg-accent-soft text-accent">
        <Sparkles size={22} />
      </span>
      <div>
        <p className="text-[15px]/[20px] font-bold text-text">Đội agent QA sẵn sàng</p>
        <p className="mt-[2px] text-[12.5px]/[17px] text-text-3">Gõ một câu để bắt đầu, ví dụ “chạy flow login trên Android”, hoặc chọn một gợi ý.</p>
      </div>
      <div className="grid w-full grid-cols-1 gap-[8px] sm:grid-cols-2">
        {STARTERS.map((s) => (
          <button
            key={s.text}
            type="button"
            disabled={!onPick}
            onClick={() => onPick?.(s.text)}
            className="stroke-in flex flex-col items-start gap-[2px] rounded-[10px] bg-surface px-[12px] py-[9px] text-left hover:[--stroke-c:var(--color-accent)] disabled:cursor-default"
          >
            <span className="text-[12.5px]/[16px] font-semibold text-text">{s.title}</span>
            <span className="text-[12px]/[16px] text-text-3">{s.text}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Lịch sử chat (thuần, render và test độc lập). Hộp duyệt và form duyệt pipeline nằm đúng chỗ trong dòng thời gian. */
export function AgentTranscriptView({
  msgs,
  busy,
  load,
  onConfirm,
  onRespond,
  pinned,
  onPin,
  onSuggest,
}: {
  msgs: Msg[];
  busy: boolean;
  load: (ref: string) => Promise<string>;
  onConfirm?: (callId: string, approved: boolean) => void;
  onRespond?: (interruptId: string, answer: ApprovalAnswer) => void;
  /** Khoá các tin đang ghim (xem pins.ts); bỏ trống thì không hiện nút ghim. */
  pinned?: ReadonlySet<string>;
  onPin?: (m: Msg) => void;
  onSuggest?: (text: string) => void;
}) {
  if (msgs.length === 0) return <Starters onPick={onSuggest} />;
  let lastAuthor = '';
  return (
    <div className="mx-auto flex w-full max-w-[860px] flex-col gap-[12px] px-[16px] py-[16px]" data-testid="agent-transcript">
      {groupItems(msgs).map((it) => {
        if (it.kind === 'tools') return <ToolGroup key={it.i} tools={it.tools} load={load} />;
        const { m, i } = it;
        const key = pinKey(m);
        const isPinned = !!key && !!pinned?.has(key);
        const actions = (text: string) => (
          <div className="flex items-center gap-[1px] opacity-0 transition-opacity focus-within:opacity-100 group-hover/msg:opacity-100">
            <CopyButton text={text} />
            {onPin && key && <PinButton pinned={isPinned} onClick={() => onPin(m)} />}
          </div>
        );
        switch (m.type) {
          case 'user':
            lastAuthor = 'user';
            return (
              <div key={i} data-pin={key ?? undefined} className="group/msg flex items-center justify-end gap-[6px]">
                {actions(m.text)}
                <div className={cx('max-w-[78%] rounded-[16px] rounded-br-[5px] bg-accent px-[13px] py-[8px] text-[13.5px]/[19px] text-white shadow-sm', isPinned && 'ring-2 ring-accent/30 ring-offset-1')}>
                  <p className="whitespace-pre-wrap break-words">{m.text}</p>
                </div>
              </div>
            );
          case 'text': {
            const head = m.author !== lastAuthor;
            lastAuthor = m.author;
            return (
              <div key={i} data-pin={key ?? undefined} className="group/msg flex items-start gap-[10px]">
                {head ? <AgentAvatar author={m.author} /> : <span className="w-[30px] shrink-0" />}
                <div className="flex min-w-0 max-w-[min(680px,88%)] flex-col gap-[4px]">
                  {head && (
                    <div className="flex items-center gap-[6px]">
                      <AgentBadge author={m.author} />
                      {isPinned && <Pin size={11} className="text-accent" aria-label="đã ghim" />}
                    </div>
                  )}
                  <div className={cx('rounded-[14px] rounded-tl-[5px] bg-surface px-[13px] py-[10px] shadow-[0_1px_2px_rgba(16,28,48,0.06)] ring-1 ring-border', isPinned && 'ring-accent/40')}>
                    <MessageBody author={m.author} text={m.text} />
                    {m.streaming && <span className="ml-[2px] inline-block h-[14px] w-[6px] animate-pulse rounded-[1px] bg-accent align-middle" aria-hidden />}
                  </div>
                </div>
                {!m.streaming && <div className="self-end">{actions(m.text)}</div>}
              </div>
            );
          }
          case 'progress':
            return (
              <p key={i} className="ml-[40px] flex items-center gap-[7px] text-[12px]/[16px] text-text-3" data-testid="progress-line">
                <Loader2 size={12} className="animate-spin text-accent" />
                {m.text}
              </p>
            );
          case 'confirm':
            lastAuthor = '';
            return <ConfirmDialog key={i} msg={m} disabled={busy || !onConfirm} onAnswer={(ok) => onConfirm?.(m.id, ok)} />;
          case 'request':
            lastAuthor = '';
            return <ApprovalForm key={i} msg={m} disabled={busy || !onRespond} onSubmit={(a) => onRespond?.(m.id, a)} />;
          case 'error':
            lastAuthor = '';
            return (
              <p key={i} role="alert" className="flex items-start gap-[8px] rounded-[10px] border border-line-red bg-red-soft px-[12px] py-[8px] text-[12.5px]/[17px] text-red" data-testid="error-card">
                <TriangleAlert size={15} className="mt-[1px] shrink-0" />
                <span className="min-w-0 break-words">{m.text}</span>
              </p>
            );
          default:
            return null;
        }
      })}
      {busy && !msgs.some((m) => m.type === 'progress') && (
        <div className="ml-[40px] flex items-center gap-[4px] text-[12px]/[16px] text-text-3" aria-label="Đang làm…">
          {[0, 150, 300].map((d) => (
            <span key={d} className="h-[6px] w-[6px] animate-bounce rounded-full bg-text-3" style={{ animationDelay: `${d}ms` }} />
          ))}
          <span className="ml-[4px]">Đang làm…</span>
        </div>
      )}
    </div>
  );
}

/** Thanh tin ghim kiểu Telegram ở đầu khung chat: hiện một tin, bấm để nhảy tới và chuyển sang tin ghim kế. */
export function PinnedBar({ pins, onJump, onUnpin }: { pins: PinT[]; onJump: (key: string) => void; onUnpin: (key: string) => void }) {
  const [at, setAt] = useState(pins.length - 1);
  useEffect(() => setAt(pins.length - 1), [pins.length]);
  if (pins.length === 0) return null;
  const idx = Math.min(Math.max(at, 0), pins.length - 1);
  const p = pins[idx];
  return (
    <div className="flex items-center gap-[10px] border-b border-border bg-surface px-[12px] py-[6px]" data-testid="pinned-bar">
      <div className="flex h-[30px] flex-col gap-[2px]" aria-hidden>
        {pins.slice(-4).map((x) => (
          <span key={x.key} className={cx('w-[2.5px] flex-1 rounded-full', x.key === p.key ? 'bg-accent' : 'bg-accent/25')} />
        ))}
      </div>
      <button
        type="button"
        className="min-w-0 flex-1 text-left"
        onClick={() => {
          onJump(p.key);
          setAt((idx - 1 + pins.length) % pins.length);
        }}
        title="Nhảy tới tin ghim"
      >
        <span className="block text-[11.5px]/[15px] font-semibold text-accent">
          Tin đã ghim{pins.length > 1 ? ` #${idx + 1}/${pins.length}` : ''} · {p.author === 'user' ? 'Bạn' : (AUTHOR_LABEL[p.author] ?? p.author)}
        </span>
        <span className="block truncate text-[12.5px]/[16px] text-text">{p.preview}</span>
      </button>
      <button type="button" aria-label="Bỏ ghim" title="Bỏ ghim" onClick={() => onUnpin(p.key)} className="rounded-[6px] p-[5px] text-text-3 hover:bg-muted-box hover:text-text">
        <PinOff size={14} />
      </button>
    </div>
  );
}

export function SessionList({ sessions, activeId, onOpen, onNew, onDelete }: { sessions: SessionInfo[]; activeId: string; onOpen: (id: string) => void; onNew: () => void; onDelete: (id: string) => void }) {
  return (
    <nav aria-label="Lịch sử phiên" className="flex w-[170px] shrink-0 flex-col gap-[4px] border-r border-border p-[8px]" data-testid="session-list">
      <button type="button" onClick={onNew} className="flex items-center gap-[6px] rounded-[7px] px-[8px] py-[5px] text-[12.5px]/[16px] font-semibold text-accent hover:bg-accent-soft">
        <Plus size={14} /> Phiên mới
      </button>
      {sessions.length === 0 && <p className="px-[8px] text-[11.5px]/[15px] text-text-3">Chưa có phiên nào.</p>}
      {sessions.map((s) => (
        <div key={s.id} className={cx('group flex items-center rounded-[7px]', s.id === activeId ? 'bg-accent-soft' : 'hover:bg-muted-box')}>
          <button type="button" onClick={() => onOpen(s.id)} className="min-w-0 flex-1 truncate px-[8px] py-[5px] text-left text-[12px]/[16px]" title={s.title} aria-current={s.id === activeId || undefined}>
            {s.pending && <span className="mr-[4px] inline-block h-[7px] w-[7px] rounded-full bg-amber align-middle" role="img" aria-label="chờ duyệt" />}
            {s.title || 'Phiên'}
          </button>
          <button type="button" onClick={() => onDelete(s.id)} aria-label="Xoá phiên" title="Xoá phiên" className="mr-[4px] hidden rounded-[5px] p-[3px] text-text-3 hover:text-red group-hover:block">
            <Trash2 size={12} />
          </button>
        </div>
      ))}
    </nav>
  );
}

/** Chọn model cho từng agent (theo danh sách Worker trả) và hiện chi phí lượt vừa xong. */
export function ModelPicker({ status, costUsd, costVnd, onChange }: { status: AgentStatus | null; costUsd: number; costVnd: number; onChange: (agent: string, alias: string) => void }) {
  if (!status) return null;
  const aliases = status.models.map((m) => m.alias);
  return (
    <div className="flex flex-wrap items-center gap-x-[12px] gap-y-[4px] border-b border-border px-[12px] py-[6px] text-[11.5px]/[15px] text-text-2" data-testid="model-picker">
      {status.agentNames
        .filter((a) => a !== 'summarizer')
        .map((a) => (
          <label key={a} className="flex items-center gap-[4px]">
            {AUTHOR_LABEL[a] ?? a}
            <select
              aria-label={`Model của ${AUTHOR_LABEL[a] ?? a}`}
              value={status.agents[a]}
              disabled={aliases.length === 0}
              onChange={(e) => onChange(a, e.target.value)}
              className="rounded-[5px] border border-border bg-surface px-[4px] py-[1px]"
            >
              {[...new Set([status.agents[a], ...aliases])].map((al) => (
                <option key={al} value={al}>
                  {al}
                </option>
              ))}
            </select>
          </label>
        ))}
      {costUsd > 0 && (
        <span className="ml-auto font-semibold text-text" data-testid="run-cost">
          Lượt này: {formatUsd(costUsd)} · {formatVnd(costVnd)}
        </span>
      )}
    </div>
  );
}

/** Huy hiệu câu hỏi đang chờ (cả từ trước khi mở lại app); bấm để mở phiên chờ lâu nhất chưa mở. */
export function PendingBadge({ pending, activeId, onOpen }: { pending: PendingItem[]; activeId: string; onOpen: (id: string) => void }) {
  const others = pending.filter((p) => p.sessionId !== activeId);
  if (pending.length === 0) return null;
  const target = others.at(-1) ?? pending.at(-1);
  return (
    <button
      type="button"
      onClick={() => target && onOpen(target.sessionId)}
      data-testid="pending-badge"
      title={pending.map((p) => p.title || p.sessionId).join('\n')}
      className="flex items-center gap-[5px] rounded-[7px] bg-amber-soft px-[8px] py-[3px] text-[11.5px]/[15px] font-semibold text-text hover:brightness-95"
    >
      <BellRing size={13} className="text-amber" aria-hidden />
      {pending.length} chờ duyệt
    </button>
  );
}

/** Khung giữa: danh sách phiên, chọn model, tin ghim, lịch sử chat; tự cuộn theo nội dung mới khi đang ở cuối. */
export function AgentTranscript() {
  const { state, status, sessions, sessionId, send, openSession, newSession, deleteSession, setModel, approve, respond } = useAgentChat();
  const { pins, toggle, unpin, enabled } = usePins(sessionId);
  const pinnedKeys = useMemo(() => new Set(pins.map((p) => p.key)), [pins]);
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    const el = box.current;
    // Người dùng vừa gửi tin thì luôn kéo xuống cuối, kể cả khi trước đó họ đã cuộn lên đọc.
    if (state.msgs[state.msgs.length - 1]?.type === 'user') stick.current = true;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [state.msgs]);
  const jump = (key: string) => {
    const el = box.current?.querySelector<HTMLElement>(`[data-pin="${CSS.escape(key)}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.animate([{ backgroundColor: 'rgba(228,0,43,0.10)' }, { backgroundColor: 'transparent' }], { duration: 1400, easing: 'ease-out' });
  };
  return (
    <div className="flex min-h-0 flex-1" data-testid="agent-chat">
      <SessionList sessions={sessions} activeId={sessionId} onOpen={(id) => void openSession(id)} onNew={newSession} onDelete={(id) => void deleteSession(id)} />
      <div className="flex min-w-0 flex-1 flex-col bg-bg/40">
        <ModelPicker status={status} costUsd={state.costUsd} costVnd={state.costVnd} onChange={(a, m) => void setModel(a, m)} />
        {(status?.pending?.length ?? 0) > 0 && (
          <div className="flex justify-end border-b border-border px-[12px] py-[4px]">
            <PendingBadge pending={status?.pending ?? []} activeId={sessionId} onOpen={(id) => void openSession(id)} />
          </div>
        )}
        <PinnedBar pins={pins} onJump={jump} onUnpin={unpin} />
        {status?.ready && <DraftsPanel />}
        {status && !status.ready && status.error && (
          <p role="alert" className="m-[12px] rounded-[8px] border border-border bg-muted-box px-[10px] py-[6px] text-[12.5px]/[17px] text-text-2">
            Đội agent chưa sẵn sàng: {status.error}
          </p>
        )}
        <div
          ref={box}
          role="log"
          aria-label="Lịch sử trò chuyện với agent"
          aria-live="polite"
          aria-busy={state.busy || undefined}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
          }}
          className="min-h-0 flex-1 overflow-y-auto"
        >
          <AgentTranscriptView
            msgs={state.msgs}
            busy={state.busy}
            load={agentApi.image}
            onConfirm={(id, ok) => void approve(id, ok)}
            onRespond={(id, a) => void respond(id, a)}
            pinned={pinnedKeys}
            onPin={enabled ? toggle : undefined}
            onSuggest={(t) => void send(t)}
          />
        </div>
      </div>
    </div>
  );
}

/** Nút trả lời nhanh sau lượt vừa xong. */
export function SuggestionChips({ items, onPick }: { items: string[]; onPick: (text: string) => void }) {
  if (items.length === 0) return null;
  return (
    <div className="flex gap-[6px] overflow-x-auto pb-[2px]" data-testid="suggestion-chips">
      {items.map((s) => (
        <button
          key={s}
          type="button"
          onClick={() => onPick(s)}
          className="flex shrink-0 items-center gap-[5px] rounded-full border border-border bg-surface px-[10px] py-[4px] text-[12px]/[16px] font-medium text-text-2 hover:border-accent hover:bg-accent-soft hover:text-accent-ink"
        >
          <Sparkles size={12} className="text-accent" />
          {s}
        </button>
      ))}
    </div>
  );
}

const MAX_INPUT_H = 180;

/** Thanh lệnh của chat agent: ô nhập nhiều dòng tự giãn, Enter gửi, Shift+Enter xuống dòng, ⌘K để gõ, nút vuông dừng lượt. */
export function AgentInput() {
  const { send, state, cancel } = useAgentChat();
  const [text, setText] = useState('');
  const area = useRef<HTMLTextAreaElement>(null);
  const chips = followUps(state.msgs, state.busy);
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        area.current?.focus();
      }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_INPUT_H)}px`;
  }, [text]);
  const submit = () => {
    if (!text.trim() || state.busy) return;
    void send(text);
    setText('');
  };
  const ready = !!text.trim() && !state.busy;
  return (
    <div className="flex flex-col gap-[8px]">
      <SuggestionChips items={chips} onPick={(s) => void send(s)} />
      <form
        className="stroke-in flex flex-col gap-[6px] rounded-[14px] bg-surface px-[14px] pb-[8px] pt-[11px] focus-within:[--stroke-c:var(--color-accent)] focus-within:[--stroke-w:1.5px]"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <textarea
          ref={area}
          rows={2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          aria-label="Nhắn cho đội agent"
          placeholder="Nhắn cho đội agent: “chạy flow login trên Android”…"
          className="max-h-[180px] min-h-[44px] w-full resize-none bg-transparent text-[14px]/[21px] text-text outline-none placeholder:text-text-3"
        />
        <div className="flex items-center gap-[8px]">
          <span className="text-[11px]/[14px] text-text-3">
            <kbd className="font-mono">Enter</kbd> gửi · <kbd className="font-mono">Shift</kbd>+<kbd className="font-mono">Enter</kbd> xuống dòng · <kbd className="font-mono">{searchKey}</kbd> để gõ
          </span>
          <span className="flex-1" />
          {state.busy ? (
            <button
              type="button"
              onClick={cancel}
              aria-label="Dừng"
              title="Dừng"
              className="flex h-[34px] items-center gap-[6px] rounded-full border border-border px-[12px] text-[12.5px]/[16px] font-semibold text-text-2 hover:bg-muted-box hover:text-text"
            >
              <Square size={12} className="fill-current" /> Dừng
            </button>
          ) : (
            <button
              type="submit"
              aria-label="Gửi"
              title="Gửi"
              disabled={!ready}
              className={cx('flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full transition-colors disabled:cursor-not-allowed', ready ? 'bg-accent text-white hover:bg-accent-ink' : 'bg-muted-box text-text-3')}
            >
              <ArrowUp size={17} />
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

const searchKey = typeof navigator !== 'undefined' && !/Mac|iPhone|iPad/.test(navigator.platform) ? 'Ctrl K' : '⌘K';
