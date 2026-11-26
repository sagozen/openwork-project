import { Info, ScanSearch } from 'lucide-react';
import { Button, Input } from '..';

/** Thẻ đăng nhập của khung wcyQW (400×425): thử Input h42, nút h44, thẻ bo 16 + bóng auth. */
export function LoginBoard() {
  return (
    <div className="flex w-[400px] flex-col gap-[18px] stroke-in rounded-[16px] bg-surface p-[32px] leading-[normal] shadow-auth">
      <div className="flex flex-col gap-[10px]">
        <span className="flex h-[40px] w-[40px] items-center justify-center rounded-[11px] bg-accent text-white">
          <ScanSearch size={20} />
        </span>
        <h1 className="text-[22px]/[28px] font-bold tracking-[-0.3px] text-text">Đăng nhập HS Desk</h1>
        <p className="text-[13px]/[16px] text-text-2">Công ty Anh Tùng</p>
      </div>
      <Input size="login" label="Tên đăng nhập" defaultValue="phamminh" readOnly />
      <Input size="login" label="Mật khẩu" password defaultValue="mat-khau-12" readOnly />
      <Button size="auth" block>
        Đăng nhập
      </Button>
      <p className="flex items-center justify-center gap-[6px] text-[12px]/[15px] text-text-3">
        <Info size={13} />
        Quên mật khẩu? Nhờ admin đặt lại.
      </p>
    </div>
  );
}
