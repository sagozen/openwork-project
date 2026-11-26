import { Link } from 'react-router';
import { Hourglass } from 'lucide-react';
import { isDesktop } from '../../platform';
import { useSession } from '../../lib/session';
import { Banner } from '../ui';

export const REVIEW_PATH = '/thao-tac-cho';

/** E-018: thao tác không được công nhận hoặc đang chờ admin xem hiện ngay trên máy người làm khi máy kết nối; liên kết tới danh sách cục bộ. */
export function ReviewBanner() {
  const { auth } = useSession();
  if (!isDesktop || auth.review <= 0) return null;
  return (
    <Banner tone="amber" icon={<Hourglass size={16} />} className="mb-[16px]">
      {auth.review} thao tác của bạn chưa được công nhận hoặc đang chờ admin xem.{' '}
      <Link to={REVIEW_PATH} className="font-semibold underline">
        Xem danh sách
      </Link>
    </Banner>
  );
}
