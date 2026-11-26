// Trang văn bản pháp lý (chính sách quyền riêng tư, điều khoản sử dụng): tiêu đề, ngày hiệu lực, tóm tắt và các mục.
// Nội dung nằm ở legal-copy.ts; ở đây chỉ trình bày để hai trang không lệch nhau.
import { Link } from 'react-router';
import { PublicLayout } from './PublicLayout';
import { CONTACT_EMAIL, OPERATOR, type LegalSection } from './legal-copy';
import { POLICY_PATH, TERM_PATH } from './paths';

export interface LegalPageProps {
  /** Tiêu đề tab và tiêu đề lớn. */
  title: string;
  /** Nhãn nhỏ phía trên tiêu đề ("Pháp lý"). */
  eyebrow: string;
  effectiveDate: string;
  intro: string;
  /** Khung tóm tắt ngay dưới tiêu đề; bỏ trống nếu không cần. */
  summary?: string;
  sections: LegalSection[];
}

export function LegalPage({ title, eyebrow, effectiveDate, intro, summary, sections }: LegalPageProps) {
  const other = title.toLowerCase().includes('chính sách') ? { to: TERM_PATH, label: 'Điều khoản sử dụng' } : { to: POLICY_PATH, label: 'Chính sách quyền riêng tư' };
  return (
    <PublicLayout title={`${title} · ${OPERATOR}`}>
      <article className="mx-auto w-full max-w-[820px] px-[20px] pt-[44px] pb-[56px]">
        <p className="text-[11px]/[14px] font-bold tracking-[1.4px] text-accent-ink uppercase">{eyebrow}</p>
        <h1 className="mt-[8px] text-[28px]/[36px] font-bold sm:text-[34px]/[42px]">{title}</h1>
        <p className="mt-[10px] text-[12.5px]/[18px] text-text-3">
          Áp dụng cho HS Desk và ChatQASoftware · Cập nhật lần cuối: {effectiveDate} · Đơn vị vận hành: {OPERATOR}
        </p>
        <p className="mt-[18px] text-[14px]/[23px] text-text-2">{intro}</p>
        {summary && (
          <p className="mt-[18px] rounded-[10px] bg-accent-soft px-[16px] py-[14px] text-[13.5px]/[21px] font-medium text-text">{summary}</p>
        )}

        {sections.map((s) => (
          <section key={s.title} className="mt-[30px]">
            <h2 className="text-[17px]/[24px] font-bold">{s.title}</h2>
            {s.paragraphs?.map((p) => (
              <p key={p} className="mt-[10px] text-[14px]/[23px] break-words text-text-2">
                {p}
              </p>
            ))}
            {s.bullets && (
              <ul className="mt-[10px] flex flex-col gap-[7px]">
                {s.bullets.map((b) => (
                  <li key={b.text} className="relative pl-[16px] text-[14px]/[23px] break-words text-text-2">
                    <span className="absolute top-[9px] left-[2px] h-[5px] w-[5px] rounded-full bg-accent" />
                    {b.term && <strong className="font-semibold text-text">{b.term} </strong>}
                    {b.text}
                  </li>
                ))}
              </ul>
            )}
            {s.note && <p className="mt-[12px] rounded-[8px] bg-amber-soft px-[14px] py-[11px] text-[13px]/[20px] text-text-2">{s.note}</p>}
          </section>
        ))}

        <div className="mt-[36px] border-t border-border pt-[20px] text-[13px]/[21px] text-text-2">
          <p>
            Xem thêm <Link to={other.to} className="font-semibold text-accent hover:underline">{other.label}</Link>. Mọi câu hỏi về văn bản này, gửi tới{' '}
            <a href={`mailto:${CONTACT_EMAIL}`} className="font-semibold text-accent hover:underline">{CONTACT_EMAIL}</a>.
          </p>
        </div>
      </article>
    </PublicLayout>
  );
}
