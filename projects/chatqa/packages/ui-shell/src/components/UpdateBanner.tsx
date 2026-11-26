import { useEffect, useReducer, useRef, useState } from 'react';
import { Download, RefreshCw, RotateCw, ShieldAlert } from 'lucide-react';
import { platform, isDesktop, type UpdateInfo } from '../platform';
import { errorText } from '../lib/session';
import { useSyncStatus } from './SyncBadge';
import { estimate, timeText } from '../lib/net-progress';

const CHECK_EVERY_MS = 30 * 60 * 1000;
const MANDATORY_COUNTDOWN = 60; // giây

/**
 * Desktop:
 *  - UI mới: "Cập nhật ngay" => thay giao diện, không khởi động lại.
 *  - Exe mới: tải nền (hiện %), xong => "Khởi động lại để cập nhật" hoặc "Để sau" (tự áp dụng lần mở sau).
 *  - Exe bắt buộc: hộp thoại đếm ngược rồi tự khởi động lại.
 */
export function UpdateBanner() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [later, setLater] = useState(false);
  // Áp bản mới chỉ gửi một lần: thành công thì Go tải lại / thoát nên cờ giữ nguyên; lỗi mới nhả để bấm lại.
  const applying = useRef(false);

  useEffect(() => {
    if (!isDesktop || !platform.checkUpdate) return;
    const check = () => platform.checkUpdate!().then(setInfo).catch(() => undefined);
    void platform.updateStatus?.().then(setInfo);
    void check();
    const id = setInterval(check, CHECK_EVERY_MS);
    const off = platform.onUpdateStatus?.(setInfo);
    return () => {
      clearInterval(id);
      off?.();
    };
  }, []);

  async function apply(kind: 'ui' | 'bin') {
    if (applying.current) return;
    applying.current = true;
    setBusy(true);
    setErr('');
    try {
      await platform.applyUpdate!(kind); // ui: Go reload cửa sổ; bin: Go đổi exe, mở lại, thoát
    } catch (e) {
      setErr(errorText(e));
      applying.current = false;
      setBusy(false);
    }
  }

  const bin = info?.bin;
  if (bin?.state === 'ready' && bin.mandatory) {
    return <MandatoryRestart version={bin.version} notes={bin.notes} busy={busy} err={err} onRestart={() => apply('bin')} />;
  }

  const bar = (children: React.ReactNode, tone = 'border-orange-200 bg-orange-50 text-orange-900') => (
    <div className={`flex items-center gap-3 border-b px-6 py-2 text-sm ${tone}`}>{children}</div>
  );
  const btn = 'inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium disabled:opacity-60';

  if (bin?.state === 'ready' && !later) {
    return bar(
      <>
        <RotateCw size={16} />
        <span className="flex-1">
          Bản <b>{bin.version}</b> đã tải xong{bin.notes && <span className="text-orange-700"> - {bin.notes}</span>}. Khởi
          động lại để cập nhật, dữ liệu đang làm không bị mất.
          {err && <span className="ml-2 text-red-700">{err}</span>}
        </span>
        <button onClick={() => setLater(true)} className={`${btn} text-orange-800 hover:bg-orange-100`}>
          Để sau
        </button>
        <button onClick={() => apply('bin')} disabled={busy} className={`${btn} bg-orange-600 text-white hover:bg-orange-700`}>
          <RefreshCw size={13} className={busy ? 'animate-spin' : ''} />
          {busy ? 'Đang khởi động lại...' : 'Khởi động lại ngay'}
        </button>
      </>,
    );
  }

  if (bin?.state === 'downloading') {
    return bar(<DownloadProgress version={bin.version} progress={bin.progress} />, 'border-sky-100 bg-sky-50 text-sky-900');
  }

  if (bin?.state === 'error') {
    return bar(
      <>
        <ShieldAlert size={16} />
        <span className="flex-1">Không tải được bản {bin.version}: {errorText({ code: bin.error.split(':')[0] })}</span>
        <button onClick={() => platform.checkUpdate?.().then(setInfo)} className={`${btn} text-red-800 hover:bg-red-100`}>
          Thử lại
        </button>
      </>,
      'border-red-200 bg-red-50 text-red-900',
    );
  }

  const ui = info?.ui;
  if (ui) {
    return bar(
      <>
        <Download size={16} />
        <span className="flex-1">
          Có giao diện mới <b>{ui.version}</b>
          {ui.notes && <span className="text-orange-700"> - {ui.notes}</span>}
          {err && <span className="ml-2 text-red-700">{err}</span>}
        </span>
        <button onClick={() => apply('ui')} disabled={busy} className={`${btn} bg-orange-600 text-white hover:bg-orange-700`}>
          <RefreshCw size={13} className={busy ? 'animate-spin' : ''} /> Cập nhật ngay
        </button>
      </>,
    );
  }
  return null;
}

/**
 * Tải exe nền: % do Go báo, kèm thời gian đã chờ và còn lại ngoại suy từ tốc độ thật. Mốc tính từ lúc thanh hiện ra
 * (mở app giữa chừng thì phần đã tải trước đó không tính vào tốc độ).
 */
function DownloadProgress({ version, progress }: { version: string; progress: number }) {
  const start = useRef({ at: Date.now(), p: progress });
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);
  const pct = Math.round(progress * 100);
  const base = start.current;
  const time = timeText(estimate({ elapsedMs: Date.now() - base.at, done: Math.round((progress - base.p) * 1000), total: Math.round((1 - base.p) * 1000), typicalMs: null }));
  return (
    <>
      <Download size={16} />
      <span>
        Đang tải bản {version} ở chế độ nền... {pct}%{time && <span className="text-sky-700"> · {time}</span>}
      </span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-sky-100">
        <div className="h-full bg-sky-500 transition-all" style={{ width: `${pct}%` }} />
      </div>
    </>
  );
}

/** Bản bắt buộc: đếm ngược rồi tự khởi động lại. Chờ đồng bộ xong (tối đa thêm 60 giây) nếu đang có mạng. */
function MandatoryRestart(p: { version: string; notes: string; busy: boolean; err: string; onRestart: () => void }) {
  const sync = useSyncStatus();
  const [left, setLeft] = useState(MANDATORY_COUNTDOWN);
  const fired = useRef(false);
  const waitingSync = !!sync && sync.online && (sync.syncing || sync.pending > 0) && left > -MANDATORY_COUNTDOWN;

  useEffect(() => {
    const id = setInterval(() => setLeft((s) => s - 1), 1000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    if (left <= 0 && !waitingSync && !fired.current && !p.err) {
      fired.current = true;
      p.onRestart();
    }
  }, [left, waitingSync, p]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
      <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
        <div className="flex items-center gap-2 text-orange-700">
          <ShieldAlert size={20} />
          <h2 className="font-semibold">Cập nhật bắt buộc · bản {p.version}</h2>
        </div>
        {p.notes && <p className="mt-2 text-sm text-slate-600">{p.notes}</p>}
        <p className="mt-3 text-sm text-slate-600">
          Bản mới đã tải xong. App sẽ tự khởi động lại
          {left > 0 ? (
            <> sau <b>{left}</b> giây</>
          ) : waitingSync ? (
            <> khi đồng bộ xong ({sync?.pending} mục)</>
          ) : (
            <> ngay</>
          )}
          . Dữ liệu đang làm đã được lưu trên máy.
        </p>
        {p.err && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{p.err}</p>}
        <button
          onClick={() => {
            fired.current = true;
            p.onRestart();
          }}
          disabled={p.busy}
          className="mt-5 inline-flex h-9 w-full items-center justify-center gap-2 rounded-lg bg-slate-900 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-60"
        >
          <RefreshCw size={15} className={p.busy ? 'animate-spin' : ''} />
          {p.busy ? 'Đang khởi động lại...' : 'Khởi động lại ngay'}
        </button>
      </div>
    </div>
  );
}
