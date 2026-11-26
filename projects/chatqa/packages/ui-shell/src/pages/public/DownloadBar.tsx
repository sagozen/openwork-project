// Thanh tải app ở đầu trang chủ: Windows nổi bật (bấm là tải ngay), macOS đi kèm. Bản mới nhất lấy từ máy chủ;
// nền tảng chưa phát hành hiện "Sắp có" thay vì liên kết hỏng.
import { useEffect, useState } from 'react';
import { Apple, Download, History, Monitor } from 'lucide-react';
import { PRODUCT } from '@product/product';

interface DownloadItem {
  version: string;
  size: number;
  url: string;
  notes: string;
  publishedAt: number;
}
interface HistoryItem {
  kind: 'ui' | 'bin';
  version: string;
  platforms: string[];
  notes: string;
  mandatory: boolean;
  publishedAt: number;
}
interface Downloads {
  windows: DownloadItem | null;
  macos: DownloadItem | null;
  history: HistoryItem[];
}

const day = (ms: number) => new Date(ms).toLocaleDateString('vi-VN');

export function DownloadBar() {
  // undefined = đang hỏi máy chủ; null = hỏi lỗi (coi như chưa có bản để tải).
  const [data, setData] = useState<Downloads | null | undefined>(undefined);
  useEffect(() => {
    const ctl = new AbortController();
    fetch(`/api/v1/updates/downloads?product=${PRODUCT.code}`, {
      signal: ctl.signal,
    })
      .then((r) => (r.ok ? (r.json() as Promise<Downloads>) : null))
      .then(setData)
      .catch(() => {
        if (!ctl.signal.aborted) setData(null);
      });
    return () => ctl.abort();
  }, []);

  const win = data?.windows ?? null;
  const mac = data?.macos ?? null;
  const loading = data === undefined;
  const history = data?.history ?? [];
  const newest = win ?? mac;

  return (
    <section className="border-b border-border bg-chrome">
      <div className="mx-auto w-full max-w-[1080px] px-[20px] py-[16px]">
        <div className="flex flex-col gap-[14px] sm:flex-row sm:items-center">
          <div className="min-w-0 flex-1">
            {newest ? (
              <p className="text-[14px]/[19px] font-bold text-white">
                Phiên bản v{newest.version}
                <span className="ml-[8px] font-medium text-chrome-text">{day(newest.publishedAt)}</span>
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-[10px]">
            {win ? (
              <a
                href={win.url}
                download
                className="inline-flex h-[46px] items-center gap-[9px] rounded-[10px] bg-accent px-[22px] text-[14.5px]/[18px] font-bold text-white shadow-[0_6px_18px_rgba(0,0,0,0.25)] transition-[filter] hover:brightness-95"
              >
                <Download size={18} />
                Tải cho Windows
              </a>
            ) : (
              <span aria-disabled="true" className="inline-flex h-[46px] items-center gap-[9px] rounded-[10px] bg-white/10 px-[22px] text-[14px]/[18px] font-semibold text-chrome-text">
                <Monitor size={18} />
                {loading ? 'Đang kiểm tra bản Windows…' : 'Windows · Sắp có'}
              </span>
            )}
            {mac ? (
              <a href={mac.url} download className="inline-flex h-[46px] items-center gap-[8px] rounded-[10px] bg-white/10 px-[18px] text-[13.5px]/[18px] font-semibold text-white hover:bg-white/15">
                <Apple size={17} />
                Tải cho macOS
              </a>
            ) : (
              <span aria-disabled="true" className="inline-flex h-[46px] items-center gap-[8px] rounded-[10px] bg-white/5 px-[18px] text-[13px]/[18px] font-medium text-chrome-text/70">
                <Apple size={17} />
                macOS · Sắp có
              </span>
            )}
          </div>
        </div>
        {history.length > 0 ? (
          <details className="mt-[10px] group">
            <summary className="inline-flex cursor-pointer list-none items-center gap-[6px] text-[12.5px]/[18px] font-semibold text-white/90 hover:text-white">
              <History size={14} />
              Lịch sử phiên bản ({history.length})
            </summary>
            <ol className="mt-[10px] flex max-h-[280px] flex-col gap-[8px] overflow-y-auto pr-[4px]">
              {history.map((h) => (
                <li key={`${h.kind}-${h.version}`} className="rounded-[9px] bg-white/5 px-[12px] py-[9px]">
                  <p className="flex flex-wrap items-center gap-x-[8px] gap-y-[2px] text-[12.5px]/[17px] font-bold text-white">
                    v{h.version}
                    <span className="text-[11.5px]/[16px] font-medium text-chrome-text">{day(h.publishedAt)}</span>
                    <span className="rounded-[5px] bg-white/10 px-[6px] py-[1px] text-[10.5px]/[14px] font-semibold text-chrome-text">
                      {h.kind === 'ui' ? 'Giao diện' : h.platforms.join(' · ') || 'Ứng dụng'}
                    </span>
                    {h.mandatory ? <span className="rounded-[5px] bg-accent px-[6px] py-[1px] text-[10.5px]/[14px] font-semibold text-white">Bắt buộc cập nhật</span> : null}
                  </p>
                  <p className="mt-[3px] text-[12.5px]/[19px] text-chrome-text">{h.notes || 'Không có ghi chú.'}</p>
                </li>
              ))}
            </ol>
          </details>
        ) : null}
      </div>
    </section>
  );
}
