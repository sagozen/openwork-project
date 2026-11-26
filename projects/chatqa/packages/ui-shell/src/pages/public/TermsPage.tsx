// Điều khoản sử dụng công khai (đường dẫn /term mà Google OAuth trỏ tới cùng trang chủ và chính sách).
import { LegalPage } from './LegalPage';
import { EFFECTIVE_DATE, TERMS, TERMS_INTRO } from './legal-copy';

export function TermsPage() {
  return <LegalPage title="Điều khoản sử dụng" eyebrow="Pháp lý" effectiveDate={EFFECTIVE_DATE} intro={TERMS_INTRO} sections={TERMS} />;
}
