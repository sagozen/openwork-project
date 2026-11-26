import { Eye, Info } from 'lucide-react';
import { WebScreen } from '../../components/shell';
import { useIsPhone } from '../../lib/use-phone';

const month = () => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', month: 'numeric' }).format(new Date()));

/**
 * Chỗ gắn nội dung Báo cáo. Số liệu (yêu cầu báo giá, AI đúng mã HS, theo người làm) thuộc tính năng ai-accuracy-report:
 * thay phần này bằng module của tính năng đó. Chưa có thì hiện trạng thái trống, không có số liệu giả.
 */
function ReportBody({ phone }: { phone: boolean }) {
  return (
    <div className="stroke-in flex min-h-[200px] w-full flex-1 flex-col items-center justify-center gap-[6px] rounded-[12px] bg-surface p-[32px] text-center leading-[normal]" data-testid="report-empty">
      <p className={phone ? 'text-[14px]/[20px] font-semibold' : 'text-[15px]/[20px] font-semibold'}>Chưa có số liệu báo cáo</p>
    </div>
  );
}

/** Báo cáo (chỉ xem): E8wEy trên web, suizx trên điện thoại. Chỉ vai có report.view (Admin, Manager, Leader) vào được (BR-016). */
export default function ReportPage() {
  const phone = useIsPhone();
  const m = month();
  const chip = (
    <span className="flex items-center gap-[4px] rounded-[5px] bg-chip-neutral px-[6px] py-px text-[10px]/[13px] font-semibold text-text-2">
      <Eye size={10} />
      Chỉ xem
    </span>
  );
  if (phone) {
    return (
      <WebScreen phone={{ title: 'Báo cáo', menu: true, padded: false, bodyClass: 'gap-[16px] p-[16px]' }}>
        <div className="flex items-center justify-between">
          <h2 className="text-[20px]/[25px] font-bold tracking-[-0.3px]">Tháng {m}</h2>
          <span className="flex items-center gap-[5px] rounded-[7px] bg-chip-neutral px-[9px] py-[4px] text-[11.5px]/[15px] font-semibold text-text-2">
            <Eye size={12} />
            Chỉ xem
          </span>
        </div>
        <ReportBody phone />
      </WebScreen>
    );
  }
  return (
    <WebScreen>
      <div className="flex min-h-full w-full flex-col gap-[14px]">
        <div className="flex flex-col gap-[4px]">
          <div className="flex items-center gap-[8px] text-[12px]/[15px] text-text-3">
            Báo cáo
            {chip}
          </div>
          <h1 className="text-[24px]/[30px] font-bold tracking-[-0.4px]">Tổng quan tháng {m}</h1>
        </div>
        <ReportBody phone={false} />
        <p className="flex items-center gap-[8px] text-[12px]/[15px] text-text-3">
          <Info size={13} />
          Báo cáo trên web chỉ để xem. Duyệt và Yêu cầu sửa làm trên app Windows. Manager không thấy mục Quản trị.
        </p>
      </div>
    </WebScreen>
  );
}
