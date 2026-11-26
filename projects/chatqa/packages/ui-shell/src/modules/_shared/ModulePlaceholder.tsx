import { useCurrent } from './ModuleRoute';
import { appNo } from '@product/modules/registry';
import { Badge, Card, PageHeader } from '../../components/ui';

/** Trang chưa làm giao diện - thay bằng trang thật theo lộ trình (xem hsapp.pen). */
export default function ModulePlaceholder() {
  const { module: m, page } = useCurrent();
  return (
    <>
      <PageHeader eyebrow={`${appNo(m)} · ${m.name}`} title={page.label} desc={m.summary} />
      <Card>
        <div className="flex flex-col items-center gap-2 py-16 text-center text-sm text-slate-400">
          {page.phase === 2 && <Badge tone="slate">Phase 2 · tính năng {page.quoteRef}</Badge>}
          <p>{page.phase === 2 ? 'Tính năng Phase 2 theo báo giá - triển khai sau Phase 1.' : 'Màn hình đang được xây dựng theo lộ trình.'}</p>
        </div>
      </Card>
    </>
  );
}
