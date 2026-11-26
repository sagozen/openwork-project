// Soạn/dán Markdown của một tài liệu nghiệp vụ: loại, tiêu đề, nội dung trong <textarea> (không xem trước Markdown). Lưu qua
// test.Service.SaveDoc; Go tự gán mã cho tiêu đề/mục danh sách chưa có neo và trả bản đã lưu, trang hiện các mã vừa gán.
import { useEffect, useState } from 'react';
import { Save, Trash2 } from 'lucide-react';
import { Button, Input } from '@shell/components/ui';
import { useToast } from '@shell/components/overlays/ToastHost';
import { Muted } from '../chat/components/shared';
import { testApi, type Doc, type DocType } from '../testing/bridge';
import { ANCHOR_HINT, ANCHOR_SCOPE, assignedIds, composeDoc, DOC_TYPES, docErrorText, splitDoc, validDocId, type DocParts } from './docs-api';

const field = 'stroke-in rounded-[8px] bg-surface px-[12px] text-[13px]/[16px] text-text';

export interface EditorDraft extends DocParts {
  id: string;
}

/** Bản nháp từ tài liệu đã lưu (null = tài liệu mới). */
export const draftOf = (doc: Doc | null): EditorDraft => (doc ? { id: doc.id, ...splitDoc(doc.markdown), type: doc.type, title: doc.title } : { id: '', type: 'PRD', title: '', extra: [], body: '' });

/** Lý do chưa lưu được ("" = lưu được). */
export function draftProblem(d: EditorDraft, isNew: boolean, existing: string[]): string {
  if (isNew && !validDocId(d.id)) return 'Mã tài liệu chỉ gồm chữ thường, số, gạch nối (vd prd-dang-nhap).';
  if (isNew && existing.includes(d.id)) return `Đã có tài liệu ${d.id}.`;
  if (d.body.trim() === '') return 'Nội dung trống.';
  return '';
}

export interface DocEditorViewProps {
  draft: EditorDraft;
  isNew: boolean;
  rev?: number;
  reqCount?: number;
  problem?: string;
  /** Mã app vừa gán ở lần lưu gần nhất. */
  assigned?: string[] | null;
  error?: string;
  busy?: boolean;
  onChange?: (d: EditorDraft) => void;
  /** Không có (thiếu quyền chạy flow) = chỉ xem. */
  onSave?: () => void;
  onDelete?: () => void;
}

export function DocEditorView({ draft, isNew, rev, reqCount, problem, assigned, error, busy, onChange, onSave, onDelete }: DocEditorViewProps) {
  const readOnly = !onSave;
  const set = (p: Partial<EditorDraft>) => onChange?.({ ...draft, ...p });
  return (
    <div className="flex flex-col gap-[10px]" data-testid="doc-editor">
      <div className="flex flex-wrap gap-[10px]">
        {isNew ? (
          <Input label="Mã tài liệu (tên tệp)" mono placeholder="prd-dang-nhap" value={draft.id} onChange={(e) => set({ id: e.target.value.trim() })} wrapperClassName="max-w-[240px]" />
        ) : (
          <div className="flex flex-col gap-[6px] leading-[normal]">
            <span className="text-[12px]/[15px] font-semibold text-text-2">Mã tài liệu</span>
            <span className="flex h-[40px] items-center font-mono text-[13px]/[16px] text-text">
              {draft.id}
              {rev ? <span className="ml-[8px] text-text-3">· bản {rev}</span> : null}
              {reqCount !== undefined ? <span className="ml-[8px] text-text-3">· {reqCount} yêu cầu</span> : null}
            </span>
          </div>
        )}
        <label className="flex w-[220px] flex-col gap-[6px] leading-[normal]">
          <span className="text-[12px]/[15px] font-semibold text-text-2">Loại</span>
          <select className={`${field} h-[40px]`} value={draft.type} disabled={readOnly} onChange={(e) => set({ type: e.target.value as DocType })}>
            {DOC_TYPES.map((t) => (
              <option key={t.key} value={t.key}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <Input label="Tiêu đề" placeholder="Đăng nhập bằng OTP" value={draft.title} disabled={readOnly} onChange={(e) => set({ title: e.target.value })} wrapperClassName="min-w-[200px] flex-1" />
      </div>
      <label className="flex flex-col gap-[6px] leading-[normal]">
        <span className="text-[12px]/[15px] font-semibold text-text-2">Nội dung Markdown</span>
        <textarea
          className={`${field} min-h-[320px] py-[10px] font-mono text-[12.5px]/[18px]`}
          spellCheck={false}
          readOnly={readOnly}
          placeholder={'## Đăng nhập bằng OTP {#REQ-001}\nNgười dùng nhập số điện thoại, nhận mã OTP 6 số...\n\n## Khoá tài khoản sau 5 lần sai\n...'}
          value={draft.body}
          onChange={(e) => set({ body: e.target.value })}
        />
      </label>
      <Muted>{ANCHOR_HINT}.</Muted>
      <Muted>{ANCHOR_SCOPE}</Muted>
      {assigned && (
        <p className="rounded-[6px] bg-green-soft px-[8px] py-[6px] text-[12px]/[16px] text-green" data-testid="assigned-ids">
          {assigned.length > 0 ? (
            <>
              Đã lưu. Mã vừa gán: <span className="font-mono font-semibold">{assigned.join(', ')}</span>
            </>
          ) : (
            'Đã lưu. Không có mục nào cần gán mã mới.'
          )}
        </p>
      )}
      {error && <p className="text-[12px]/[16px] text-red">{error}</p>}
      {!readOnly && (
        <div className="flex flex-wrap items-center gap-[10px]">
          <Button disabled={busy || !!problem} onClick={onSave} icon={<Save size={15} />}>
            {busy ? 'Đang lưu…' : 'Lưu'}
          </Button>
          {onDelete && !isNew && (
            <Button variant="secondary" disabled={busy} onClick={onDelete} icon={<Trash2 size={15} />}>
              Xoá tài liệu
            </Button>
          )}
          {problem && <span className="text-[11.5px]/[15px] text-amber">{problem}</span>}
        </div>
      )}
    </div>
  );
}

/**
 * Lưu bản nháp qua Go và tính các mã vừa gán (có trong bản đã lưu, chưa có neo trong nội dung gửi đi). Dùng chung cho
 * trình soạn thảo và test.
 */
export async function saveDraft(app: string, d: EditorDraft): Promise<{ doc: Doc; assigned: string[] }> {
  const markdown = composeDoc(d);
  const doc = await testApi.saveDoc(app, d.id, markdown);
  return { doc, assigned: assignedIds(markdown, doc) };
}

/** Trình soạn thảo nối với Go. doc null = tài liệu mới; existing = mã đã dùng (chặn tạo trùng). */
export function DocEditor({
  app,
  doc,
  existing,
  canEdit,
  onSaved,
  onDeleted,
}: {
  app: string;
  doc: Doc | null;
  existing: string[];
  canEdit: boolean;
  onSaved: (d: Doc, assigned: string[]) => void;
  onDeleted: (id: string) => void;
}) {
  const { show } = useToast();
  const [draft, setDraft] = useState(() => draftOf(doc));
  // Mã vừa gán theo mã tài liệu: chỉ hiện khi đang mở đúng tài liệu vừa lưu.
  const [assigned, setAssigned] = useState<{ id: string; ids: string[] } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const isNew = doc === null;
  // Đổi tài liệu, hoặc Go trả bản mới (lưu/khôi phục): nạp lại nội dung đã gắn mã.
  useEffect(() => {
    setDraft(draftOf(doc));
    setError('');
  }, [doc]);

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await saveDraft(app, draft);
      void testApi.track('docs_save', { app, doc: res.doc.id, rev: res.doc.rev, assigned: res.assigned.length });
      onSaved(res.doc, res.assigned);
      setAssigned({ id: res.doc.id, ids: res.assigned });
    } catch (e) {
      setError(docErrorText(e));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!doc || !window.confirm(`Xoá tài liệu ${doc.id}? Bản cuối vẫn còn trong lịch sử; ca nối với các mã của tài liệu này sẽ cần xem lại.`)) return;
    setBusy(true);
    try {
      await testApi.deleteDoc(app, doc.id);
      void testApi.track('docs_delete', { app, doc: doc.id });
      show(`Đã xoá tài liệu ${doc.id}.`);
      onDeleted(doc.id);
    } catch (e) {
      setError(docErrorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <DocEditorView
      draft={draft}
      isNew={isNew}
      rev={doc?.rev}
      reqCount={doc?.requirements.length}
      problem={canEdit ? draftProblem(draft, isNew, existing) : ''}
      assigned={assigned && assigned.id === draft.id ? assigned.ids : null}
      error={error}
      busy={busy}
      onChange={setDraft}
      onSave={canEdit ? () => void save() : undefined}
      onDelete={canEdit ? () => void remove() : undefined}
    />
  );
}
