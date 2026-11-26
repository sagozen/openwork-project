// Khung chung của các trang công khai (trang chủ, chính sách, điều khoản): đầu trang có link khoá học và icon GitHub (nếu sản phẩm có),
// liên kết tới hai văn bản pháp lý và nút Đăng nhập; chân trang ghi đơn vị vận hành + email liên hệ. Không gọi API, không cần phiên đăng nhập.
import { useEffect, type ReactNode } from 'react';
import { Link } from 'react-router';
import { GraduationCap } from 'lucide-react';
import { ProductMark } from '@product/brand';
import { PRODUCT } from '@product/product';
import { PRODUCT_NAME } from '../../lib/auth-ui';
import { CONTACT_EMAIL, OPERATOR } from './legal-copy';
import { EXTERNAL_LINK } from './LearnSection';
import { LANDING_PATH, LOGIN_PATH, POLICY_PATH, TERM_PATH } from './paths';

export interface PublicLayoutProps {
  /** Tiêu đề tab trình duyệt. */
  title: string;
  children: ReactNode;
}

/** Logo GitHub (lucide 1.x đã bỏ icon thương hiệu nên vẽ trực tiếp). */
function GithubMark() {
  return (
    <svg viewBox="0 0 16 16" width={18} height={18} fill="currentColor" aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

export function PublicLayout({ title, children }: PublicLayoutProps) {
  const { learn, repoUrl } = PRODUCT.landing;
  useEffect(() => {
    document.title = title;
  }, [title]);
  return (
    <div className="flex min-h-dvh flex-col bg-surface font-sans leading-[normal] text-text">
      <header className="sticky top-0 z-10 border-b border-border bg-surface/95 backdrop-blur">
        <div className="mx-auto flex h-[60px] w-full max-w-[1080px] items-center gap-[12px] px-[20px]">
          <Link to={LANDING_PATH} className="flex items-center gap-[9px]">
            <ProductMark className="h-[28px] w-[28px] rounded-[7px]" glyph={16} tone="light" />
            <span className="text-[15px]/[19px] font-bold whitespace-nowrap">{PRODUCT_NAME}</span>
          </Link>
          <span className="flex-1" />
          <nav className="flex shrink-0 items-center gap-[2px]">
            {/* Link khoá học hiện cả trên điện thoại, khác hai link pháp lý */}
            {learn ? (
              <a
                href={learn.url}
                {...EXTERNAL_LINK}
                className="inline-flex items-center gap-[6px] rounded-[8px] px-[10px] py-[7px] text-[13px]/[16px] font-medium whitespace-nowrap text-text-2 hover:bg-bg"
              >
                <GraduationCap size={15} className="text-accent" aria-hidden />
                {learn.navLabel}
              </a>
            ) : null}
            {repoUrl ? (
              <a
                href={repoUrl}
                {...EXTERNAL_LINK}
                aria-label="Mã nguồn trên GitHub"
                title="Mã nguồn trên GitHub"
                className="flex h-[30px] w-[34px] items-center justify-center rounded-[8px] text-text-2 hover:bg-bg hover:text-text"
              >
                <GithubMark />
              </a>
            ) : null}
            <Link to={POLICY_PATH} className="hidden rounded-[8px] px-[10px] py-[7px] text-[13px]/[16px] font-medium text-text-2 hover:bg-bg sm:block">
              Chính sách
            </Link>
            <Link to={TERM_PATH} className="hidden rounded-[8px] px-[10px] py-[7px] text-[13px]/[16px] font-medium text-text-2 hover:bg-bg sm:block">
              Điều khoản
            </Link>
            <Link
              to={LOGIN_PATH}
              className="rounded-[8px] bg-accent px-[14px] py-[8px] text-[13px]/[16px] font-semibold whitespace-nowrap text-white hover:brightness-95"
            >
              Đăng nhập
            </Link>
          </nav>
        </div>
      </header>
      <main className="flex-1">{children}</main>
      <footer className="border-t border-border bg-bg">
        <div className="mx-auto flex w-full max-w-[1080px] flex-col gap-[10px] px-[20px] py-[24px] text-[12px]/[18px] text-text-3 sm:flex-row sm:items-center">
          <p>
            © {new Date().getFullYear()} {OPERATOR} · <a className="hover:text-text-2" href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
          </p>
          <span className="hidden flex-1 sm:block" />
          <nav className="flex flex-wrap items-center gap-x-[16px] gap-y-[6px]">
            {learn ? (
              <a href={learn.url} {...EXTERNAL_LINK} className="hover:text-text-2">
                {learn.navLabel}
              </a>
            ) : null}
            <Link to={POLICY_PATH} className="hover:text-text-2">
              Chính sách quyền riêng tư
            </Link>
            <Link to={TERM_PATH} className="hover:text-text-2">
              Điều khoản sử dụng
            </Link>
            <Link to={LANDING_PATH} className="hover:text-text-2">
              Trang chủ
            </Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
