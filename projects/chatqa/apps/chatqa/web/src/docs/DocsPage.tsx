// Trang Kiểm thử › Tài liệu (/kiem-thu/tai-lieu): tài liệu nghiệp vụ (PRD/BRD/URD/SRS/AC) dạng Markdown theo từng app, mỗi mục
// yêu cầu có mã ổn định {#REQ-012}. Soạn/dán, lưu (app tự gán mã), lịch sử + diff + khôi phục, ma trận độ phủ yêu cầu ↔ ca ↔
// kết quả chạy, ca bị ảnh hưởng khi sửa yêu cầu, ghi chú "nguồn có thể sai". Sinh ca dùng form biên dịch (testing/RunForm).
import { useCallback, useEffect, useState } from 'react';
import { FilePlus2, FolderOpen, X } from 'lucide-react';
import { Button, Input, Tabs } from '@shell/components/ui';
import { errorText, useSession } from '@shell/lib/session';
import { useToast } from '@shell/components/overlays/ToastHost';
import { Card, Muted } from '../chat/components/shared';
import { CompileForm } from '../testing/RunForm';
import { testApi, type AffectedCase, type Doc, type DocInfo, type Note, type ReqIndex } from '../testing/bridge';
import { AffectedCases } from './AffectedCases';
import { CoveragePane } from './CoveragePane';
import { DocEditor } from './DocEditor';
import { DocHistory } from './DocHistory';
import { NotesList } from './NoteDialog';
import { DOC_TYPES, docErrorText, reqCountByDoc, validAppName } from './docs-api';

type PageTab = 'docs' | 'coverage' | 'notes';
type EditorTab = 'edit' | 'history';

const TYPE_SHORT = Object.fromEntries(DOC_TYPES.map((t) => [t.key, t.key === 'other' ? 'Khác' : t.key]));
const when = (iso: string) => (iso ? new Date(iso).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' }) : '');

/** Danh sách tài liệu: loại, tiêu đề, mã, bản, số yêu cầu; bấm để mở. */
export function DocList({ docs, counts, openId, onOpen }: { docs: DocInfo[]; counts: Record<string, number>; openId?: string; onOpen?: (id: string) => void }) {
  if (docs.length === 0) return <Muted>App này chưa có tài liệu. Bấm “Tài liệu mới” rồi dán PRD, BRD, URD, SRS hoặc tiêu chí nghiệm thu dạng Markdown.</Muted>;
  return (
    <ul data-testid="doc-list">
      {docs.map((d) => (
        <li key={d.id} className="border-t border-divider first:border-t-0">
          <button
            type="button"
            onClick={() => onOpen?.(d.id)}
            aria-current={openId === d.id ? 'true' : undefined}
            className={`flex w-full items-center gap-[10px] py-[7px] text-left text-[12px]/[16px] ${openId === d.id ? 'text-accent' : 'text-text'}`}
          >
            <span className="w-[44px] shrink-0 rounded-[5px] bg-chip-neutral px-[6px] py-px text-center text-[10.5px]/[14px] font-semibold text-text-2">{TYPE_SHORT[d.type] ?? d.type}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-semibold">{d.title || d.id}</span>
              <span className="block truncate font-mono text-[11px]/[14px] text-text-3">
                {d.id} · bản {d.rev} · {when(d.updatedAt)}
              </span>
            </span>
            <span className="shrink-0 text-[11.5px]/[15px] text-text-2">{counts[d.id] ?? 0} yêu cầu</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Chọn app: app trong kho flow + app đang mở, hoặc gõ tên app mới (chưa có flow). */
function AppPicker({ apps, app, onPick }: { apps: string[]; app: string; onPick: (a: string) => void }) {
  const [typed, setTyped] = useState('');
  const name = typed.trim();
  const ok = validAppName(name);
  const list = app && !apps.includes(app) ? [...apps, app] : apps;
  return (
    <div className="flex flex-wrap items-end gap-[10px]">
      {list.length > 0 && (
        <label className="flex w-[240px] flex-col gap-[6px] leading-[normal]">
          <span className="text-[12px]/[15px] font-semibold text-text-2">App</span>
          <select className="stroke-in h-[40px] rounded-[8px] bg-surface px-[12px] text-[13px]/[16px] text-text" value={app} onChange={(e) => onPick(e.target.value)}>
            {list.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
      )}
      <Input
        label="Hoặc app khác"
        mono
        placeholder="mexpress"
        value={typed}
        invalid={name !== '' && !ok}
        onChange={(e) => setTyped(e.target.value)}
        wrapperClassName="w-[220px]"
      />
      <Button
        variant="secondary"
        disabled={!ok}
        icon={<FolderOpen size={15} />}
        onClick={() => {
          onPick(name);
          setTyped('');
        }}
      >
        Mở
      </Button>
      {name !== '' && !ok && <span className="text-[11.5px]/[15px] text-red">Tên app chỉ gồm chữ thường, số, dấu . _ - (tối đa 64 ký tự).</span>}
    </div>
  );
}

export default function DocsPage() {
  const { show } = useToast();
  const canEdit = useSession().can('cqs.run');
  const [apps, setApps] = useState<string[]>([]);
  const [app, setApp] = useState('');
  const [tab, setTab] = useState<PageTab>('docs');
  const [docs, setDocs] = useState<DocInfo[]>([]);
  const [index, setIndex] = useState<ReqIndex>({ reqs: [], duplicates: [] });
  const [affected, setAffected] = useState<AffectedCase[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [error, setError] = useState('');
  /** Tài liệu đang mở: '' = không mở, null doc + 'new' = tài liệu mới. */
  const [openId, setOpenId] = useState('');
  const [doc, setDoc] = useState<Doc | null>(null);
  const [editorTab, setEditorTab] = useState<EditorTab>('edit');
  const [compile, setCompile] = useState<{ reqs: string[]; title: string } | null>(null);
  const [coverageKey, setCoverageKey] = useState(0);
  const [busy, setBusy] = useState('');

  useEffect(() => {
    testApi.apps().then(
      (list) => {
        setApps(list);
        setApp((cur) => cur || list[0] || '');
      },
      (e) => setError(errorText(e)),
    );
  }, []);

  const refresh = useCallback(async (a: string) => {
    if (!a) return;
    try {
      const [d, idx, aff, ns] = await Promise.all([testApi.docs(a), testApi.requirements(a), testApi.affectedCases(a), testApi.notes(a)]);
      setDocs(d);
      setIndex(idx);
      setAffected(aff);
      setNotes(ns);
      setError('');
    } catch (e) {
      setError(docErrorText(e));
    }
    setCoverageKey((k) => k + 1);
  }, []);

  useEffect(() => {
    setOpenId('');
    setDoc(null);
    setCompile(null);
    void refresh(app);
  }, [app, refresh]);

  const open = async (id: string) => {
    setEditorTab('edit');
    if (id === 'new') {
      setOpenId('new');
      setDoc(null);
      return;
    }
    try {
      setDoc(await testApi.doc(app, id));
      setOpenId(id);
    } catch (e) {
      show(docErrorText(e));
    }
  };
  const saved = (d: Doc) => {
    setDoc(d);
    setOpenId(d.id);
    void refresh(app);
  };
  const ack = async (caseId: string) => {
    setBusy(caseId);
    try {
      await testApi.ackCase(app, caseId);
      void testApi.track('docs_case_ack', { app });
      show(`Đã giữ nguyên ca ${caseId}.`);
      await refresh(app);
    } catch (e) {
      show(docErrorText(e));
    } finally {
      setBusy('');
    }
  };
  const resolve = async (id: string) => {
    setBusy(id);
    try {
      const n = await testApi.resolveNote(app, id);
      setNotes((list) => list.map((x) => (x.id === n.id ? n : x)));
    } catch (e) {
      show(docErrorText(e));
    } finally {
      setBusy('');
    }
  };
  const generate = (reqs: string[], title: string) => {
    setCompile({ reqs: [...reqs], title });
    void testApi.track('docs_compile_open', { app, reqs: reqs.length });
  };

  const openNotes = notes.filter((n) => n.status === 'open').length;
  return (
    <div className="flex flex-col gap-[10px] px-[16px] py-[14px]" data-testid="docs-page">
      <Card title="Tài liệu nghiệp vụ">
        <Muted>Mỗi mục yêu cầu có mã ổn định để nối với ca kiểm thử: sửa một mục thì các ca nối với nó hiện “cần xem lại”. Chỉ Markdown hoặc văn bản thường.</Muted>
        <AppPicker apps={apps} app={app} onPick={setApp} />
      </Card>
      {error && <p className="text-[12px]/[16px] text-red">{error}</p>}
      {!app ? (
        <Muted>Chọn hoặc nhập tên app để xem tài liệu.</Muted>
      ) : (
        <>
          {index.duplicates.length > 0 && (
            <Card title="Mã yêu cầu bị trùng" tone="warn">
              <Muted>
                Các mã <span className="font-mono">{index.duplicates.join(', ')}</span> có ở nhiều tài liệu (thường do đồng bộ từ máy khác). Đổi mã ở một bên;
                tới lúc đó không sinh ca được cho các mã này.
              </Muted>
            </Card>
          )}
          {compile && (
            <CompileForm
              app={app}
              reqs={compile.reqs}
              title={compile.title}
              onClose={() => setCompile(null)}
              onDone={() => void refresh(app)}
            />
          )}
          <AffectedCases
            cases={affected}
            busy={busy}
            onRegenerate={canEdit ? (reqs) => generate(reqs, 'Sinh lại ca bị ảnh hưởng') : undefined}
            onAck={canEdit ? (id) => void ack(id) : undefined}
          />
          <Tabs<PageTab>
            items={[
              { key: 'docs', label: 'Tài liệu' },
              { key: 'coverage', label: 'Độ phủ' },
              { key: 'notes', label: 'Ghi chú', ...(openNotes ? { count: openNotes } : {}) },
            ]}
            value={tab}
            onChange={setTab}
          />
          {tab === 'docs' && (
            <>
              <Card
                title={`Tài liệu · ${docs.length}`}
                aside={
                  canEdit && (
                    <Button size="xs" icon={<FilePlus2 size={13} />} onClick={() => void open('new')}>
                      Tài liệu mới
                    </Button>
                  )
                }
              >
                <DocList docs={docs} counts={reqCountByDoc(index.reqs)} openId={openId} onOpen={(id) => void open(id)} />
              </Card>
              {openId && (
                <Card
                  title={doc ? doc.title || doc.id : 'Tài liệu mới'}
                  aside={
                    <Button size="xs" variant="secondary" icon={<X size={13} />} onClick={() => setOpenId('')}>
                      Đóng
                    </Button>
                  }
                >
                  {doc && (
                    <Tabs<EditorTab>
                      items={[
                        { key: 'edit', label: 'Soạn thảo' },
                        { key: 'history', label: 'Lịch sử' },
                      ]}
                      value={editorTab}
                      onChange={setEditorTab}
                    />
                  )}
                  {editorTab === 'history' && doc ? (
                    <DocHistory app={app} docId={doc.id} rev={doc.rev} onRestored={canEdit ? saved : undefined} />
                  ) : (
                    <DocEditor
                      app={app}
                      doc={doc}
                      existing={docs.map((d) => d.id)}
                      canEdit={canEdit}
                      onSaved={saved}
                      onDeleted={() => {
                        setOpenId('');
                        setDoc(null);
                        void refresh(app);
                      }}
                    />
                  )}
                </Card>
              )}
            </>
          )}
          {tab === 'coverage' && <CoveragePane app={app} reload={coverageKey} onGenerate={canEdit ? (reqs) => generate(reqs, 'Sinh ca kiểm thử') : undefined} />}
          {tab === 'notes' && <NotesList notes={notes} busy={busy} onResolve={canEdit ? (id) => void resolve(id) : undefined} />}
        </>
      )}
    </div>
  );
}
