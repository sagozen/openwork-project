// App 2 - Kiểm thử, mở ở khung giữa (/kiem-thu): flow của từng app trong kho (trạng thái cũ, lỗi kiểm tra) và các lượt
// chạy gần nhất (bấm để xem chi tiết từng bước). Chạy tay ở thẻ Chạy flow; biên dịch, sửa flow vẫn làm qua chat hoặc client MCP.
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { FolderOpen, GitCompareArrows, PackageOpen } from 'lucide-react';
import { Button, Input } from '@shell/components/ui';
import { errorText, useSession } from '@shell/lib/session';
import { useToast } from '@shell/components/overlays/ToastHost';
import { FlowList } from '../chat/components/cards';
import { moduleByCode, pagePath } from '../modules/registry';
import { Card, Muted, StateBadge, timeOf } from '../chat/components/shared';
import { towerApi, type BrowserProfile } from '../live/bridge';
import { isSpecFlow, onTestEvent, testApi, type FlowInfo, type GitDiffResult, type RunRecord } from './bridge';
import { RunForm } from './RunForm';
import { PipelineButton } from '../agentchat/PipelineButton';
import { ExportHistoryCard, exportSpecWith, RunDetail, RunOpenButtons, useRunOpeners } from './RunDetail';

export interface TestingData {
  apps: { app: string; flows: FlowInfo[] }[];
  runs: RunRecord[];
}

const runState = (r: RunRecord) => (r.canceled ? 'canceled' : r.failed > 0 ? 'failed' : 'passed');

/** Tên file tải về: tên repo + ngày giờ xuất, chỉ giữ ký tự an toàn. Vd receiving_20261118-111730.json. */
export function diffFileName(repo: string, at = new Date()): string {
  const base = (repo.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'repo').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'repo';
  const p = (n: number) => String(n).padStart(2, '0');
  const d = `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`;
  return `${base}_${d}.json`;
}

/** Tải một chuỗi JSON về máy (thẻ <a download>, WebView2 hiện hộp lưu). */
function downloadJson(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Tên file từ đường dẫn đầy đủ (Go trả về), dùng luôn để bản tải về khớp bản đã lưu. */
export function fileNameOf(p?: string): string {
  return p ? p.split(/[\\/]/).pop() ?? '' : '';
}

/** git-impact trên giao diện: nhập repo + 2 commit, xuất diff và tải về theo tên repo + ngày giờ xuất. */
export function GitImpactCard() {
  const { show } = useToast();
  const [repo, setRepo] = useState('');
  const [base, setBase] = useState('');
  const [head, setHead] = useState('');
  const [paths, setPaths] = useState('');
  const [mergeBase, setMergeBase] = useState(false);
  const [busy, setBusy] = useState(false);
  const [opening, setOpening] = useState(false);
  const [result, setResult] = useState<GitDiffResult | null>(null);
  const ready = repo.trim() !== '' && base.trim() !== '';
  const run = async () => {
    if (!ready) return;
    setBusy(true);
    try {
      const d = await testApi.gitDiff({
        repo: repo.trim(),
        base: base.trim(),
        head: head.trim(),
        paths: paths.split(',').map((s) => s.trim()).filter(Boolean),
        mergeBase,
      });
      setResult(d);
      const name = fileNameOf(d.path) || diffFileName(d.repo);
      downloadJson(name, JSON.stringify(d, null, 1));
      show(`Đã xuất ${d.stats.files} file (+${d.stats.add} −${d.stats.del}). Đã lưu và tải về ${name}.`);
    } catch (e) {
      show(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  // Mở thư mục chứa file vừa xuất (chưa xuất lần nào: mở thư mục git-impact).
  const openFolder = async () => {
    setOpening(true);
    try {
      show(`Đã mở thư mục ${await testApi.openDiffFolder(result?.path ?? '')}`);
    } catch (e) {
      show(errorText(e));
    } finally {
      setOpening(false);
    }
  };
  return (
    <Card
      title="Đánh giá ảnh hưởng (git-impact)"
      aside={
        <Button size="xs" variant="secondary" disabled={opening} onClick={() => void openFolder()} icon={<FolderOpen size={13} />}>
          Mở thư mục
        </Button>
      }
    >
      <Muted>
        Xuất diff gọn giữa 2 commit của một repo git trên máy này để AI lập kế hoạch test. Chỉ đọc git, không tốn tiền AI. File lưu ngay
        trong thư mục git-impact với tên repo + ngày giờ xuất.
      </Muted>
      <div className="flex flex-col gap-[10px]">
        <Input label="Đường dẫn repo" mono placeholder="/Users/me/code/receiving" value={repo} onChange={(e) => setRepo(e.target.value)} />
        <div className="flex gap-[10px]">
          <Input label="Commit cũ (base)" mono placeholder="v1.2.0 hoặc 8 ký tự commit" value={base} onChange={(e) => setBase(e.target.value)} />
          <Input label="Commit mới (head)" mono placeholder="HEAD (để trống = HEAD)" value={head} onChange={(e) => setHead(e.target.value)} />
        </div>
        <Input label="Chỉ các đường dẫn (phân tách bằng dấu phẩy, để trống = cả repo)" mono placeholder="src/, worker/" value={paths} onChange={(e) => setPaths(e.target.value)} />
        <label className="flex items-center gap-[7px] text-[12.5px]/[16px] text-text-2">
          <input type="checkbox" checked={mergeBase} onChange={(e) => setMergeBase(e.target.checked)} />
          So kiểu pull request (từ điểm rẽ nhánh của 2 commit)
        </label>
        <div className="flex flex-wrap gap-[10px]">
          <Button disabled={busy || !ready} onClick={() => void run()} icon={<GitCompareArrows size={15} />}>
            {busy ? 'Đang xuất…' : 'Xuất diff & tải về'}
          </Button>
          <PipelineButton repo={repo.trim()} from={base.trim()} to={head.trim()} disabled={!ready} onError={(e) => show(errorText(e))} />
        </div>
      </div>
      {result && (
        <p className="text-[11.5px]/[15px] text-text-3">
          {result.stats.files} file · +{result.stats.add} −{result.stats.del} · đã lưu {fileNameOf(result.path) || 'diff'} trong thư mục xuất.
        </p>
      )}
    </Card>
  );
}

/**
 * Nút "Xuất chạy độc lập" của một flow .spec.ts: zip chạy bằng `npx playwright test` ngoài app. Có từ 2 hồ sơ trình duyệt thì
 * chọn hồ sơ lấy baseURL, viewport cho config (mặc định hồ sơ đầu tiên).
 */
export function SpecExportButton({ profiles, onExport }: { profiles: BrowserProfile[]; onExport: (profileId: string) => Promise<unknown> }) {
  const [picked, setPicked] = useState<string>();
  const [busy, setBusy] = useState(false);
  const profileId = picked ?? profiles[0]?.id ?? '';
  return (
    <span className="flex shrink-0 items-center gap-[6px]">
      {profiles.length > 1 && (
        <select
          aria-label="Hồ sơ trình duyệt cho bản xuất"
          className="stroke-in h-[24px] rounded-[6px] bg-surface px-[6px] text-[11.5px]/[14px] text-text"
          value={profileId}
          onChange={(e) => setPicked(e.target.value)}
        >
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
          <option value="">Không dùng hồ sơ</option>
        </select>
      )}
      <Button
        size="xs"
        variant="secondary"
        disabled={busy}
        icon={<PackageOpen size={13} />}
        onClick={() => {
          setBusy(true);
          void onExport(profileId).finally(() => setBusy(false));
        }}
      >
        {busy ? 'Đang xuất…' : 'Xuất chạy độc lập'}
      </Button>
    </span>
  );
}

/** Lối vào các trang con của Kiểm thử (Tài liệu, Đồng bộ...) theo danh mục: app không có sidebar nên đặt ở đầu màn. */
export function TestingLinks({ onOpen }: { onOpen: (path: string) => void }) {
  const m = moduleByCode('cqs.test');
  return (
    <nav className="flex flex-wrap gap-[8px]" aria-label="Trang con của Kiểm thử">
      {m.pages
        .filter((pg) => pg.path !== '')
        .map((pg) => (
          <Button key={pg.path} size="sm" variant="secondary" icon={<pg.icon size={13} />} onClick={() => onOpen(pagePath(m, pg))}>
            {pg.label}
          </Button>
        ))}
    </nav>
  );
}

export function TestingView({
  data,
  extra,
  selected,
  onSelect,
  detail,
  onOpenFolder,
  onOpenReport,
  flowAction,
}: {
  data: TestingData;
  extra?: ReactNode;
  /** Lượt đang mở chi tiết; detail vẽ ngay dưới dòng của lượt đó. */
  selected?: string;
  onSelect?: (id: string) => void;
  detail?: ReactNode;
  /** Mở thư mục lượt / evidence.html trên máy; không có = không hiện nút. */
  onOpenFolder?: (id: string) => void;
  onOpenReport?: (id: string) => void;
  /** Nút thêm cuối dòng của từng flow (vd xuất flow .spec.ts chạy độc lập). */
  flowAction?: (app: string, f: FlowInfo) => ReactNode;
}) {
  return (
    <div className="flex flex-col gap-[10px] px-[16px] py-[14px]" data-testid="testing">
      {extra}
      {data.apps.length === 0 ? (
        <Card title="Flow">
          <Muted>Chưa có flow nào. Nhập thư mục flow Maestro, hoặc nhờ chat (hay Claude, Codex qua MCP) viết flow từ tài liệu hoặc từ màn hình thiết bị.</Muted>
        </Card>
      ) : (
        data.apps.map((a) => <FlowList key={a.app} data={{ app: a.app, flows: a.flows }} flowAction={flowAction ? (f) => flowAction(a.app, f) : undefined} />)
      )}
      <Card title={`Lượt chạy gần nhất · ${data.runs.length}`}>
        {data.runs.length === 0 ? (
          <Muted>Chưa có lượt chạy nào.</Muted>
        ) : (
          <ul>
            {data.runs.map((r) => (
              <li key={r.id} className="flex flex-col gap-[6px] border-t border-divider py-[7px] first:border-t-0">
                <div
                  className={onSelect ? 'flex cursor-pointer items-center gap-[10px]' : 'flex items-center gap-[10px]'}
                  role={onSelect ? 'button' : undefined}
                  aria-expanded={onSelect ? selected === r.id : undefined}
                  tabIndex={onSelect ? 0 : undefined}
                  onClick={onSelect ? () => onSelect(r.id) : undefined}
                  onKeyDown={
                    onSelect
                      ? (e) => {
                          if (e.key !== 'Enter' && e.key !== ' ') return;
                          e.preventDefault();
                          onSelect(r.id);
                        }
                      : undefined
                  }
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[12.5px]/[16px] font-semibold text-text">
                      {r.app}
                      {r.label ? ` · ${r.label}` : ''}
                    </p>
                    <p className="truncate text-[11.5px]/[15px] text-text-3">
                      {timeOf(r.startedAt)} · {r.devices} máy × {r.repeat} lần · đạt {r.passed}, lỗi {r.failed}
                    </p>
                  </div>
                  <RunOpenButtons runId={r.id} onOpenFolder={onOpenFolder} onOpenReport={onOpenReport} />
                  <StateBadge state={runState(r)} />
                </div>
                {selected === r.id && detail}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

export default function TestingPage() {
  const { show } = useToast();
  const [data, setData] = useState<TestingData>({ apps: [], runs: [] });
  const [openRun, setOpenRun] = useState('');
  const [profiles, setProfiles] = useState<BrowserProfile[]>([]);
  const canRun = useSession().can('cqs.run');
  const navigate = useNavigate();
  const openers = useRunOpeners(show);
  const load = useCallback(async () => {
    try {
      const [names, runs] = await Promise.all([testApi.apps(), testApi.runs(20)]);
      const apps = await Promise.all(names.map(async (app) => ({ app, flows: await testApi.flows(app) })));
      setData({ apps, runs });
    } catch (e) {
      show(errorText(e));
    }
  }, [show]);
  useEffect(() => {
    // Hồ sơ cho config của bản xuất .spec.ts; core cũ chưa có hồ sơ: xuất không kèm hồ sơ.
    towerApi.browserProfiles().then(setProfiles, () => undefined);
  }, []);
  useEffect(() => {
    void load();
    return onTestEvent((ev) => {
      if (ev.kind === 'run_end') void load();
    });
  }, [load]);
  return (
    <TestingView
      data={data}
      extra={
        <>
          <TestingLinks onOpen={(path) => navigate(path)} />
          {/* git-impact giữ ở đầu màn (nút "Git impact" trên thanh trạng thái mở thẳng tới đây) */}
          <GitImpactCard />
          <RunForm apps={data.apps} />
          <ExportHistoryCard />
        </>
      }
      selected={openRun}
      onSelect={(id) => setOpenRun((cur) => (cur === id ? '' : id))}
      detail={openRun ? <RunDetail runId={openRun} onClose={() => setOpenRun('')} /> : null}
      onOpenFolder={openers.openFolder}
      onOpenReport={openers.openReport}
      flowAction={
        canRun
          ? (app, f) => (isSpecFlow(f.name) ? <SpecExportButton profiles={profiles} onExport={(pid) => exportSpecWith(app, f.name, pid, show)} /> : null)
          : undefined
      }
    />
  );
}
