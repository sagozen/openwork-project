// Chính sách quyền riêng tư công khai: Google OAuth yêu cầu đường dẫn này mở được mà không cần đăng nhập và có đủ nội dung
// về dữ liệu thu thập, mục đích, lưu trữ, chia sẻ và quyền của người dùng.
import { LegalPage } from './LegalPage';
import { EFFECTIVE_DATE, PRIVACY, PRIVACY_INTRO, PRIVACY_SUMMARY } from './legal-copy';

export function PolicyPage() {
  return (
    <LegalPage
      title="Chính sách quyền riêng tư"
      eyebrow="Pháp lý"
      effectiveDate={EFFECTIVE_DATE}
      intro={PRIVACY_INTRO}
      summary={PRIVACY_SUMMARY}
      sections={PRIVACY}
    />
  );
}
