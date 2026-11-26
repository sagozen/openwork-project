// Dải chân cửa sổ: phiên bản đang chạy và ngày giờ cập nhật gần nhất, để biết máy đã lên bản mới chưa.
import { useMemo } from 'react';
import { isDesktop } from '../../platform';
import { useSession } from '../../lib/session';
import { formatStamp, versionStamp } from '../../lib/version-stamp';
import { PRODUCT_NAME } from '../../lib/auth-ui';

/** Giờ đóng gói bản web, vite.config.ts nhúng sẵn; thiếu (test, dev) thì không hiện dòng ở bản web. */
declare const __PACKED_AT__: string | undefined;

export function VersionFooter() {
  const { state } = useSession();
  const v = state?.version;
  const key = v ? `${v.bin}|${v.ui}` : '';
  const text = useMemo(() => {
    if (!isDesktop) {
      const at = typeof __PACKED_AT__ === 'string' ? Date.parse(__PACKED_AT__) : NaN;
      return Number.isFinite(at) ? `${PRODUCT_NAME} web · cập nhật ${formatStamp(at)}` : '';
    }
    if (!v) return '';
    const ota = v.uiSource === 'ota' ? ` · giao diện v${v.ui}` : '';
    return `${PRODUCT_NAME} v${v.bin}${ota} · cập nhật ${formatStamp(versionStamp(key))}`;
  }, [key, v]);
  if (!text) return null;
  return (
    <footer data-testid="version-footer" className="flex h-[24px] shrink-0 items-center justify-end border-t border-border bg-surface px-[16px] text-[11px]/[14px] text-text-3">
      {text}
    </footer>
  );
}
