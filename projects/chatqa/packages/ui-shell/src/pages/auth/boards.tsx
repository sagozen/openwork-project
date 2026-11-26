// Bảng so ảnh (chỉ dev, /#/__ui/<tên>): dựng lại các khung "bảng trạng thái" của pen (Ko3Pm, npit1, g4aqy, h4Lox0) và khung K1soG
// bằng đúng thành phần của màn thật. Không vào bản build: Gallery chỉ được nạp khi import.meta.env.DEV.
import type { ReactNode } from 'react';
import { Lock, ShieldX } from 'lucide-react';
import { Button, Toast } from '../../components/ui';
import { Stepper } from '../../components/ui';
import { WindowsShell } from '../../components/shell';
import { AccountMenu } from '../../components/shell/AccountMenu';
import { AppDisabledDialog, LockedOutDialog, LogoutPendingDialog, ReconnectPanel, RevokedDialog, SessionExpiredDialog } from '../../components/overlays/dialogs';
import { WifiOff } from 'lucide-react';
import { activationView, loginView, passwordView } from '../../lib/auth-ui';
import { ApiError } from '../../platform/types';
import { ActivationCard, ForcePasswordCard, LoginCard } from './cards';
import { ActivationSuccessCard, ACTIVATE_STEPS } from './ActivatePage';
import { PasswordDialogView } from './ChangePasswordDialog';
import { cx } from '../../components/ui/cx';

const e = (code: string, params: Record<string, string | number> = {}) => new ApiError(code, 0, params);
const COMPANY = 'Công ty Anh Tùng';
const DOTS = '••••••••••';

// ---------- Khung bảng ----------

function Board({ eyebrow, title, sub, children }: { eyebrow: string; title: string; sub: string; children: ReactNode }) {
  return (
    <div className="stroke-in flex w-[2720px] flex-col gap-[28px] rounded-[16px] bg-board p-[56px] font-sans leading-[normal] text-text">
      <div className="flex flex-col gap-[8px]">
        <span className="text-[12px]/[normal] font-bold tracking-[2px] whitespace-nowrap text-accent">{eyebrow}</span>
        <h1 className="text-[36px]/[normal] font-bold tracking-[-0.8px] whitespace-nowrap">{title}</h1>
        <p className="text-[15px]/[normal] whitespace-nowrap text-text-2">{sub}</p>
      </div>
      {children}
    </div>
  );
}

const Row = ({ children }: { children: ReactNode }) => <div className="flex w-full items-start gap-[20px]">{children}</div>;

function State({ label, tone, children }: { label: string; tone: 'red' | 'amber'; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col items-center gap-[16px] rounded-[16px] bg-stage p-[28px]">
      <div className="flex w-full items-center gap-[8px]">
        <span className={cx('h-[8px] w-[8px] rounded-full', tone === 'red' ? 'bg-red' : 'bg-amber')} />
        <span className="text-[13px]/[normal] font-bold whitespace-nowrap">{label}</span>
      </div>
      {children}
    </div>
  );
}

// ---------- Ko3Pm: kích hoạt không thành công ----------

function ActivationState({ label, tone, error, machine = 'PC-KB-03 · Windows 11' }: { label: string; tone: 'red' | 'amber'; error: ApiError; machine?: string }) {
  const v = activationView(error);
  return (
    <State label={label} tone={tone}>
      <ActivationCard width={440} value="HSD-7K2Q-ANTU-9F4M" notice={v.notice} invalidKey={v.invalidKey} button={v.button} machine={machine} />
    </State>
  );
}

export function ActivationErrorsBoard() {
  return (
    <Board eyebrow="B1 · KÍCH HOẠT BẢN QUYỀN" title="Kích hoạt không thành công: nói rõ lý do và việc cần làm" sub="Mã bản quyền vẫn giữ trong ô để sửa lại. Mỗi lỗi chỉ ra người cần liên hệ: bên triển khai HS Desk hoặc admin công ty.">
      <Row>
        <ActivationState label="Sai mã bản quyền" tone="red" error={e('license_not_found')} />
        <ActivationState label="Đã dùng đủ số máy" tone="red" error={e('device_limit_reached', { maxDevices: 7 })} />
        <ActivationState label="Máy mất mạng" tone="amber" error={e('activation_needs_network')} />
        <ActivationState label="Máy chủ tài khoản gián đoạn" tone="amber" error={e('server_unavailable')} />
      </Row>
    </Board>
  );
}

// ---------- npit1: đăng nhập không được ----------

function LoginState({ label, tone, error, lockLeft }: { label: string; tone: 'red' | 'amber'; error: ApiError; lockLeft?: number }) {
  const v = loginView(error, lockLeft);
  return (
    <State label={label} tone={tone}>
      <LoginCard width={440} subtitle={COMPANY} username="phamminh" password="" notice={v.notice} invalidFields={v.invalidFields} button={v.button} placeholderPassword="Nhập mật khẩu" />
    </State>
  );
}

export function LoginErrorsBoard() {
  return (
    <Board eyebrow="B2 · ĐĂNG NHẬP" title="Đăng nhập không được: báo đúng lý do, không gợi ý tự lấy lại mật khẩu" sub="Tên đăng nhập được giữ lại, ô mật khẩu được xoá. Dùng chung cho app Windows và web.">
      <Row>
        <LoginState label="Sai tên hoặc mật khẩu" tone="red" error={e('invalid_credentials')} />
        <LoginState label="Sai quá nhiều lần" tone="red" error={e('rate_limited', { minutes: 15 })} lockLeft={892} />
        <LoginState label="Tài khoản đã bị khoá" tone="red" error={e('account_locked')} />
      </Row>
      <Row>
        <LoginState label="Lần đầu trên máy, máy mất mạng" tone="amber" error={e('first_login_needs_network')} />
        <LoginState label="Sai nhiều lần khi máy mất mạng" tone="amber" error={e('offline_attempts_exceeded')} />
        <LoginState label="Mật khẩu tạm đã hết hạn" tone="amber" error={e('temp_password_expired')} />
        <LoginState label="Máy chủ tài khoản gián đoạn" tone="amber" error={e('server_unavailable')} />
      </Row>
    </Board>
  );
}

// ---------- g4aqy: đổi mật khẩu lỗi ----------

function ForceState({ label, error }: { label: string; error: ApiError }) {
  const v = passwordView(error);
  return (
    <State label={label} tone="red">
      <ForcePasswordCard width={440} name="Phạm Minh" current="" next={DOTS} confirm={DOTS} error={v.field} notice={v.banner} />
    </State>
  );
}

function DialogState({ label, tone, error, current = DOTS }: { label: string; tone: 'red' | 'amber'; error: ApiError; current?: string }) {
  const v = passwordView(error);
  return (
    <State label={label} tone={tone}>
      <PasswordDialogView overlay={false} width={440} subtitle="Hoàng Anh Tùng · anhtung" current={current} next={DOTS} confirm={DOTS} error={v.field} notice={v.banner} />
    </State>
  );
}

export function PasswordErrorsBoard() {
  return (
    <Board eyebrow="B3 · ĐỔI MẬT KHẨU" title="Lỗi hiện ngay dưới ô cần sửa, lỗi mạng hiện trên đầu" sub="Áp cho cả hai biến thể: (a) bắt buộc sau mật khẩu tạm và (b) tự đổi từ menu tài khoản.">
      <Row>
        <ForceState label="(a) Mật khẩu quá ngắn hoặc trùng mật khẩu tạm" error={e('weak_password')} />
        <ForceState label="(a) Nhập lại không khớp" error={e('password_mismatch')} />
        <DialogState label="(b) Sai mật khẩu hiện tại" tone="red" error={e('wrong_current_password')} />
        <DialogState label="(b) Máy mất mạng khi lưu" tone="amber" error={e('need_network')} />
      </Row>
    </Board>
  );
}

// ---------- Z2ACu: đặt mật khẩu mới bắt buộc (cả cửa sổ) ----------

/** Màn thật cần mật khẩu tạm trong bộ nhớ (chỉ có sau khi gõ ở màn đăng nhập) nên khung so ảnh dựng thẻ này với dữ liệu cố định. */
export function ForcePasswordWindowBoard() {
  return (
    <div className="h-[920px] w-[1440px]">
      <WindowsShell appName="HS Desk" workspace={COMPANY} bare>
        <ForcePasswordCard name="Phạm Minh" current="" next={DOTS} confirm={DOTS} />
        <p className="text-[12px]/[15px] text-text-3">Bắt buộc ở lần đăng nhập đầu sau khi admin đặt lại mật khẩu. Không có bước bỏ qua.</p>
      </WindowsShell>
    </div>
  );
}

// ---------- K1soG: kích hoạt thành công (cả cửa sổ) ----------

export function ActivationSuccessBoard() {
  return (
    <div className="h-[920px] w-[1440px]">
      <WindowsShell appName="HS Desk" workspace={COMPANY} bare>
        <Stepper steps={ACTIVATE_STEPS} current={1} done={1} />
        <ActivationSuccessCard company={COMPANY} device="PC-KB-03" seats={{ used: 6, max: 7 }} apps={['quote', 'lot', 'check', 'teach']} onContinue={() => undefined} />
        <p className="text-[12px]/[15px] text-text-3">Tự chuyển sang màn Đăng nhập sau 3 giây.</p>
      </WindowsShell>
    </div>
  );
}

// ---------- h4Lox0: hộp và banner dùng chung ----------

function Case({ title, when, children }: { title: string; when: string; children: ReactNode }) {
  return (
    <div className="stroke-in flex h-[440px] min-w-0 flex-1 flex-col gap-[6px] rounded-[16px] bg-surface p-[24px]">
      <h2 className="text-[16px]/[20px] font-bold">{title}</h2>
      <p className="w-full text-[12.5px]/[16px] text-text-3">{when}</p>
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center rounded-[12px] bg-stage p-[20px]">{children}</div>
    </div>
  );
}

/** Khoá offline thu nhỏ trong bảng (nền #0E1014, bo 10). Bản thật là OfflineLockScreen che toàn màn. */
function OfflineLockMini() {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-[12px] rounded-[10px] bg-chrome p-[24px]">
      <span className="flex h-[52px] w-[52px] items-center justify-center rounded-full bg-sidebar-hover text-avatar-admin-text">
        <WifiOff size={24} />
      </span>
      <p className="w-[420px] text-center text-[14px] leading-[1.5] font-semibold text-white">Máy đã 8 ngày chưa kết nối. Kết nối mạng để tiếp tục làm việc. Dữ liệu trên máy vẫn được giữ.</p>
      <Button size="md" className="text-[12.5px]/[16px]">
        Thử kết nối lại
      </Button>
    </div>
  );
}

const noop = () => undefined;

export function SharedDialogsBoard() {
  return (
    <div className="stroke-in flex w-[2720px] flex-col gap-[28px] rounded-[16px] bg-board p-[56px] font-sans leading-[normal] text-text">
      <div className="flex flex-col gap-[8px]">
        <span className="text-[12px]/[normal] font-bold tracking-[2px] whitespace-nowrap text-accent">C · DÙNG CHUNG TRÊN APP WINDOWS</span>
        <h1 className="text-[36px]/[normal] font-bold tracking-[-0.8px] whitespace-nowrap">Phiên, khoá tài khoản, bản quyền và đồng bộ: hiện tại chỗ, không mất việc đang làm</h1>
        <p className="text-[15px]/[normal] whitespace-nowrap text-text-2">Hộp hiện đè lên màn đang dùng, không chuyển trang. Dữ liệu trên máy luôn được giữ.</p>
      </div>
      <Row>
        <Case title="Phiên đăng nhập hết hạn" when="Hộp đè lên màn đang làm, không chuyển trang. Đăng nhập lại xong quay về đúng chỗ.">
          <SessionExpiredDialog overlay={false} width={420} username="anhtung" password="" onPassword={noop} text="Phiên đăng nhập đã hết hạn. Đăng nhập lại để tiếp tục, việc đang làm vẫn được giữ." onRelogin={noop} onLogout={noop} />
        </Case>
        <Case title="Khoá vì quá hạn offline" when="Máy chưa kết nối quá số ngày cho phép (7 ngày). Che toàn màn, dữ liệu vẫn nằm trên máy.">
          <OfflineLockMini />
        </Case>
        <Case title="Bị khoá khi đang dùng" when="Máy đang có mạng nhận trong tối đa 15 phút, máy mất mạng nhận ở lần kết nối tới. Thay đổi chờ được đẩy lên một lần: làm trước giờ khoá được công nhận, phần sau vào Chờ công nhận.">
          <LockedOutDialog overlay={false} text="Tài khoản của bạn đã bị khoá lúc 11/11 14:05. Liên hệ admin." onLogout={noop} />
        </Case>
      </Row>
      <Row>
        <Case title="Máy bị thu hồi bản quyền" when="Hiện ở lần máy kết nối tới, sau khi đẩy thay đổi chờ lên Drive một lần. Máy đang mất mạng vẫn làm việc tới lúc đó, tối đa 7 ngày.">
          <RevokedDialog overlay={false} text="Máy này đã bị thu hồi bản quyền. Liên hệ admin." onClose={noop} />
        </Case>
        <Case title="App bị tắt khỏi bản quyền" when="Bên triển khai tắt một app khỏi bản quyền. Khoá ở lần kết nối tới, dữ liệu trên máy và Drive giữ nguyên. Các app khác vẫn dùng bình thường.">
          <AppDisabledDialog overlay={false} name="Sổ dạy AI" text="App Sổ dạy AI đã bị tắt khỏi bản quyền. Dữ liệu vẫn được giữ. Liên hệ bên triển khai HS Desk." onBack={noop} />
        </Case>
        <Case title="Không đủ quyền" when="Nút ngoài quyền ẩn hoặc vô hiệu tuỳ màn. Nếu thao tác vẫn được gọi thì app từ chối và không lưu gì, kể cả khi mất mạng.">
          <span className="stroke-in flex h-[34px] items-center gap-[7px] rounded-[8px] bg-surface px-[14px] text-[12.5px]/[16px] font-semibold text-text-3">
            <Lock size={13} />
            Mở lại lô
          </span>
          <span className="h-[16px] w-px" />
          <Toast icon={<ShieldX size={15} />}>Bạn không có quyền mở lại lô đã xuất. Liên hệ admin.</Toast>
        </Case>
      </Row>
      <Row>
        <Case title="Thông báo khi máy kết nối lại" when="Ngoài quyền tại lúc làm thì không được công nhận. Thao tác offline của người bị khoá, hạ quyền khi máy mất mạng thì chờ admin xem. Báo cả người làm và admin.">
          <ReconnectPanel
            className="w-full"
            title="Đã kết nối lại · đồng bộ xong 42 thay đổi"
            items={[
              { key: 'a', kind: 'rejected', text: 'Thao tác Mở lại lô đã xuất của Trần Lan lúc 11/11 09:27 không được công nhận vì không đủ quyền.' },
              { key: 'b', kind: 'review', text: 'Thao tác Gộp 12 dòng vào lô của Lê Hà lúc 03/11 15:22 đang chờ admin xem vì tài khoản bị đổi quyền khi máy mất mạng.' },
            ]}
          />
        </Case>
        <Case title="Đăng xuất khi còn việc chờ đồng bộ" when="Bấm Đăng xuất trong menu tài khoản khi còn thay đổi chưa lên Drive.">
          <LogoutPendingDialog overlay={false} n={7} onStay={noop} onLogout={noop} />
        </Case>
        <div className="stroke-in flex h-[440px] min-w-0 flex-1 flex-col gap-[6px] rounded-[16px] bg-surface p-[24px]">
          <h2 className="text-[16px]/[20px] font-bold">Menu tài khoản (góc trên)</h2>
          <p className="w-full text-[12.5px]/[16px] text-text-3">Bấm vào ảnh đại diện ở thanh tiêu đề.</p>
          <div className="flex min-h-0 flex-1 flex-col items-end rounded-[12px] bg-stage p-[20px]">
            <div className="flex h-[40px] w-full items-center justify-end rounded-[8px] bg-chrome px-[10px]">
              <span className="flex h-[30px] items-center gap-[6px] rounded-full bg-chrome-btn pr-[8px] pl-[3px]">
                <span className="flex h-[24px] w-[24px] items-center justify-center rounded-full bg-avatar-admin text-[9px]/[11px] font-bold text-avatar-admin-text">AT</span>
                <span className="text-[11px]/[14px] font-semibold text-chrome-text">Admin</span>
                <span className="w-[12px]" />
              </span>
            </div>
            <AccountMenu name="Hoàng Anh Tùng" role="admin" highlight onChangePassword={noop} onLogout={noop} />
          </div>
        </div>
      </Row>
    </div>
  );
}

export const AUTH_BOARDS: Record<string, { title: string; el: () => ReactNode }> = {
  'auth-kich-hoat-loi': { title: 'Kích hoạt: lỗi (Ko3Pm)', el: () => <ActivationErrorsBoard /> },
  'auth-dang-nhap-loi': { title: 'Đăng nhập: lỗi (npit1)', el: () => <LoginErrorsBoard /> },
  'auth-doi-mat-khau-loi': { title: 'Đổi mật khẩu: lỗi (g4aqy)', el: () => <PasswordErrorsBoard /> },
  'auth-bat-buoc': { title: 'Đặt mật khẩu mới bắt buộc (Z2ACu)', el: () => <ForcePasswordWindowBoard /> },
  'auth-kich-hoat-xong': { title: 'Kích hoạt thành công (K1soG)', el: () => <ActivationSuccessBoard /> },
  'auth-hop-dung-chung': { title: 'Hộp và banner dùng chung (h4Lox0)', el: () => <SharedDialogsBoard /> },
};
