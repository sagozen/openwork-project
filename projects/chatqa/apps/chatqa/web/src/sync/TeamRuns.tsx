// Tab "Lượt của nhóm" của trang Đồng bộ: các lượt chạy đồng đội (và máy này) đã chia sẻ evidence lên kho nhóm trong 30 ngày.
// "Mở evidence" tải gói về máy (lần đầu) rồi mở evidence.html bằng trình duyệt mặc định (test.Service.OpenTeamRun).
import { useCallback, useEffect, useState } from 'react';
import { FileText, RefreshCw } from 'lucide-react';
import { Button } from '@shell/components/ui';
import { Card, Muted } from '../chat/components/shared';
import { testApi } from '../testing/bridge';
import { fmtBytes, fmtWhen, syncErrorText, type TeamRun } from './sync-api';

/** Khoá một lượt nhóm (mã lượt chỉ duy nhất trong một máy). */
export const teamRunKey = (r: Pick<TeamRun, 'deviceId' | 'runId'>) => `${r.deviceId}/${r.runId}`;

/** Mở evidence của một lượt nhóm; trả đường dẫn đã mở ("" khi lỗi, câu lỗi qua show). */
export async function openTeamRunWith(r: Pick<TeamRun, 'deviceId' | 'runId'>, show: (msg: string) => void): Promise<string> {
  try {
    const path = await testApi.openTeamRun(r.deviceId, r.runId);
    void testApi.track('open_team_run', { result: 'ok' });
    return path;
  } catch (e) {
    void testApi.track('open_team_run', { result: 'error' });
    show(syncErrorText(e));
    return '';
  }
}

export function TeamRunsView({ runs, opening, onOpen }: { runs: TeamRun[]; opening?: string; onOpen?: (r: TeamRun) => void }) {
  if (runs.length === 0) return <Muted>Chưa có lượt nào được chia sẻ trong 30 ngày. Mở một lượt chạy ở trang Kiểm thử và bấm “Chia sẻ lên nhóm”.</Muted>;
  return (
    <ul data-testid="team-runs">
      {runs.map((r) => (
        <li key={teamRunKey(r)} className="flex items-center gap-[10px] border-t border-divider py-[7px] first:border-t-0">
          <div className="min-w-0 flex-1">
            <p className="truncate text-[12.5px]/[16px] font-semibold text-text">
              {r.app}
              {r.label ? ` · ${r.label}` : ''}
              {r.mine && <span className="ml-[6px] rounded-[5px] bg-accent-soft px-[6px] py-px text-[10.5px]/[14px] font-semibold text-accent-ink">của tôi</span>}
            </p>
            <p className="truncate text-[11.5px]/[15px] text-text-3">
              {r.author || 'Không rõ'} · máy <span className="font-mono">{r.deviceId}</span> · {fmtWhen(r.startedAt)}
            </p>
            <p className="truncate text-[11.5px]/[15px] text-text-2">
              {r.flows} lượt flow · đạt {r.passed}, lỗi {r.failed} · {fmtBytes(r.sizeBytes)}
            </p>
          </div>
          {onOpen && (
            <Button size="xs" variant="secondary" disabled={opening === teamRunKey(r)} icon={<FileText size={13} />} onClick={() => onOpen(r)}>
              {opening === teamRunKey(r) ? 'Đang tải…' : 'Mở evidence'}
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}

export function TeamRuns({ show }: { show: (msg: string) => void }) {
  const [runs, setRuns] = useState<TeamRun[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState('');
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRuns(await testApi.teamRuns(30));
      setError('');
    } catch (e) {
      setError(syncErrorText(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const open = async (r: TeamRun) => {
    setOpening(teamRunKey(r));
    const path = await openTeamRunWith(r, show);
    if (path) show(`Đã mở ${path}`);
    setOpening('');
  };
  return (
    <Card
      title={`Lượt của nhóm · ${runs.length}`}
      aside={
        <Button size="xs" variant="secondary" disabled={loading} icon={<RefreshCw size={13} />} onClick={() => void load()}>
          Tải lại
        </Button>
      }
    >
      {error && <p className="text-[12px]/[16px] text-red">{error}</p>}
      {loading && runs.length === 0 ? <Muted>Đang tải…</Muted> : <TeamRunsView runs={runs} opening={opening} onOpen={(r) => void open(r)} />}
    </Card>
  );
}
