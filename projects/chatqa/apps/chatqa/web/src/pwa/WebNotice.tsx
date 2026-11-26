// Bản web/điện thoại của ChatQASoftware: kết quả kiểm thử chỉ nằm trên máy chạy app (không gửi lên Drive hay máy chủ),
// nên web chỉ còn lời nhắc và lối vào Quản trị cho Admin.
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { ArrowRight, FolderOpen, MonitorSmartphone, Send } from 'lucide-react';
import { ADMIN_PATH } from '@shell/components/shell/web-chrome';
import { PRODUCT } from '../product';

export const WEB_NOTICE = `Kết quả kiểm thử xem trong app ${PRODUCT.name} trên máy tính; báo cáo nằm trong thư mục lượt chạy.`;

/** Một bước ngắn trong thẻ hướng dẫn (icon + câu), để màn web không chỉ là một câu thông báo trống. */
function Step({ icon, title, text }: { icon: ReactNode; title: string; text: string }) {
  return (
    <li className="flex items-start gap-[10px] text-left">
      <span className="mt-[1px] flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[8px] bg-muted-box text-text-2">{icon}</span>
      <span className="min-w-0">
        <span className="block text-[12.5px]/[17px] font-semibold text-text">{title}</span>
        <span className="block text-[11.5px]/[16px] text-text-3">{text}</span>
      </span>
    </li>
  );
}

/** Lời nhắc (thuần, test độc lập). admin: thêm nút mở Quản trị. */
export function WebNotice({ admin }: { admin: boolean }) {
  return (
    <div className="flex flex-1 items-center justify-center px-[16px] py-[24px]" data-testid="web-notice">
      <section aria-labelledby="web-notice-title" className="stroke-in w-full max-w-[420px] rounded-[14px] bg-surface p-[20px] text-center">
        <span className="mx-auto flex h-[48px] w-[48px] items-center justify-center rounded-[12px] bg-accent-soft text-accent">
          <MonitorSmartphone size={24} />
        </span>
        <h2 id="web-notice-title" className="mt-[12px] text-[15px]/[20px] font-semibold text-text">
          {PRODUCT.name} chạy trên máy tính
        </h2>
        <p className="mt-[4px] text-[12.5px]/[18px] text-text-2">{WEB_NOTICE}</p>
        <ul className="mt-[16px] flex flex-col gap-[12px]">
          <Step icon={<FolderOpen size={15} />} title="Mở bằng chứng" text="Trong app, bấm “Mở thư mục” hoặc “Mở báo cáo” ở thẻ kết quả." />
          <Step icon={<Send size={15} />} title="Gửi cho người khác" text="Xuất gói báo cáo rồi chia sẻ file như mọi tệp khác." />
        </ul>
        {admin && (
          <Link
            to={ADMIN_PATH}
            className="mt-[18px] inline-flex h-[44px] w-full items-center justify-center gap-[8px] rounded-[10px] bg-accent px-[16px] text-[13.5px]/[18px] font-semibold text-white hover:brightness-95"
          >
            Mở Quản trị
            <ArrowRight size={15} />
          </Link>
        )}
      </section>
    </div>
  );
}
