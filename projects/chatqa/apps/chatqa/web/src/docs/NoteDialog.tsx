// Hộp ghi chú "nguồn có thể sai": lượt chạy lỗi có thể do tài liệu sai chứ không phải app sai. Ghi chú gắn vào một mã yêu cầu
// (kèm lượt chạy, flow) để người viết tài liệu xem lại; danh sách và đánh dấu đã xử lý ở trang Tài liệu.
import { useState } from 'react';
import { Check, MessageSquareWarning } from 'lucide-react';
import { Button, Dialog } from '@shell/components/ui';
import { useToast } from '@shell/components/overlays/ToastHost';
import { Card, Muted } from '../chat/components/shared';
import { testApi, type Note } from '../testing/bridge';
import { docErrorText } from './docs-api';

export interface NoteDraft {
  req: string;
  runId: string;
  flow: string;
  text: string;
}

/** Bản nháp điền sẵn từ lượt chạy: yêu cầu đầu tiên của flow được chọn. */
export const noteDraft = (p: { runId: string; flow: string; reqs: string[]; req?: string }): NoteDraft => ({
  req: p.req && p.reqs.includes(p.req) ? p.req : (p.reqs[0] ?? ''),
  runId: p.runId,
  flow: p.flow,
  text: '',
});

const field = 'stroke-in rounded-[8px] bg-surface px-[12px] text-[13px]/[16px] text-text';

export function NoteDialogView({
  draft,
  reqs,
  busy,
  error,
  onChange,
  onSave,
  onClose,
}: {
  draft: NoteDraft;
  /** Mã yêu cầu nối với flow; nhiều mã thì chọn một. */
  reqs: string[];
  busy?: boolean;
  error?: string;
  onChange?: (d: NoteDraft) => void;
  onSave?: () => void;
  onClose?: () => void;
}) {
  const ok = draft.req !== '' && draft.text.trim() !== '';
  return (
    <Dialog
      icon={<MessageSquareWarning size={18} />}
      tone="amber"
      title="Nguồn có thể sai"
      subtitle="Ghi lại chỗ tài liệu có thể sai để người viết tài liệu xem lại."
      width={500}
      onClose={onClose}
      note={
        <span data-testid="note-source">
          Lượt <span className="font-mono">{draft.runId}</span> · flow <span className="font-mono">{draft.flow}</span>
        </span>
      }
      actions={
        <>
          <Button variant="secondary" onClick={onClose}>
            Huỷ
          </Button>
          <Button disabled={busy || !ok} onClick={onSave}>
            {busy ? 'Đang lưu…' : 'Lưu ghi chú'}
          </Button>
        </>
      }
    >
      <label className="flex flex-col gap-[6px] leading-[normal]">
        <span className="text-[12px]/[15px] font-semibold text-text-2">Yêu cầu</span>
        <select className={`${field} h-[40px] font-mono`} value={draft.req} onChange={(e) => onChange?.({ ...draft, req: e.target.value })}>
          {reqs.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-[6px] leading-[normal]">
        <span className="text-[12px]/[15px] font-semibold text-text-2">Ghi chú</span>
        <textarea
          className={`${field} min-h-[110px] py-[10px]`}
          placeholder="Vd: tài liệu ghi nút “Gửi” nhưng app hiện “Xác nhận”; hỏi lại khách bản nào đúng."
          value={draft.text}
          onChange={(e) => onChange?.({ ...draft, text: e.target.value })}
        />
      </label>
      {error && <p className="text-[12px]/[16px] text-red">{error}</p>}
    </Dialog>
  );
}

/** Hộp ghi chú nối với Go (test.Service.AddNote); lưu xong báo toast và đóng. */
export function NoteDialog({
  app,
  runId,
  flow,
  reqs,
  onClose,
  onSaved,
}: {
  app: string;
  runId: string;
  flow: string;
  reqs: string[];
  onClose: () => void;
  onSaved?: (n: Note) => void;
}) {
  const { show } = useToast();
  const [draft, setDraft] = useState(() => noteDraft({ runId, flow, reqs }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const n = await testApi.addNote(app, draft.req, draft.runId, draft.flow, draft.text.trim());
      void testApi.track('docs_note_add', { app, req: n.req });
      show(`Đã ghi chú cho ${n.req}.`);
      onSaved?.(n);
      onClose();
    } catch (e) {
      setError(docErrorText(e));
    } finally {
      setBusy(false);
    }
  };
  return <NoteDialogView draft={draft} reqs={reqs} busy={busy} error={error} onChange={setDraft} onSave={() => void save()} onClose={onClose} />;
}

/** Ghi chú theo mã yêu cầu (giữ thứ tự mới nhất trước của Go trong từng nhóm); nhóm có ghi chú đang mở lên trước. */
export function notesByReq(notes: Note[]): [string, Note[]][] {
  const groups = new Map<string, Note[]>();
  for (const n of notes) groups.set(n.req, [...(groups.get(n.req) ?? []), n]);
  const open = (list: Note[]) => list.some((n) => n.status === 'open');
  return [...groups.entries()].sort((a, b) => Number(open(b[1])) - Number(open(a[1])) || a[0].localeCompare(b[0]));
}

const noteTime = (iso: string) => (iso ? new Date(iso).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' }) : '');

/** Danh sách ghi chú "nguồn có thể sai" theo yêu cầu; onResolve không có (thiếu quyền chạy flow) = không hiện nút. */
export function NotesList({ notes, busy, onResolve }: { notes: Note[]; busy?: string; onResolve?: (id: string) => void }) {
  const open = notes.filter((n) => n.status === 'open').length;
  return (
    <Card title={`Ghi chú nguồn có thể sai · ${open} đang mở`}>
      {notes.length === 0 ? (
        <Muted>Chưa có ghi chú. Ở chi tiết lượt chạy, flow lỗi nối với yêu cầu có nút “Nguồn có thể sai”.</Muted>
      ) : (
        <div className="flex flex-col gap-[10px]" data-testid="notes">
          {notesByReq(notes).map(([req, list]) => (
            <section key={req} className="flex flex-col gap-[4px]">
              <h4 className="font-mono text-[12px]/[16px] font-semibold text-text">{req}</h4>
              <ul>
                {list.map((n) => (
                  <li key={n.id} className="flex items-start gap-[8px] border-t border-divider py-[6px] text-[12px]/[16px] first:border-t-0">
                    <div className="min-w-0 flex-1">
                      <p className={n.status === 'resolved' ? 'text-text-3 line-through' : 'text-text'}>{n.text}</p>
                      <p className="truncate text-[11px]/[14px] text-text-3">
                        {n.author} · {noteTime(n.at)}
                        {n.runId ? ` · lượt ${n.runId}` : ''}
                        {n.flow ? ` · ${n.flow}` : ''}
                      </p>
                    </div>
                    {n.status === 'resolved' ? (
                      <span className="shrink-0 rounded-[5px] bg-green-soft px-[6px] py-px text-[10.5px]/[14px] font-semibold text-green">Đã xử lý</span>
                    ) : (
                      onResolve && (
                        <Button size="xs" variant="secondary" disabled={busy === n.id} icon={<Check size={13} />} onClick={() => onResolve(n.id)}>
                          Đánh dấu đã xử lý
                        </Button>
                      )
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </Card>
  );
}
