import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { isDesktop, platform } from '../../platform';
import { useSession } from '../../lib/session';
import { loginView, lockSecondsOf, PRODUCT_NAME } from '../../lib/auth-ui';
import { demoFlag } from '../../lib/demo';
import { useIsPhone } from '../../lib/use-phone';
import { useAction } from '../../lib/use-action';
import { LoginCard } from './cards';
import { AuthScreen } from './AuthScreen';
import { PhoneLoginForm } from '../web/phone-forms';
import { LANDING_PATH, POLICY_PATH, TERM_PATH } from '../public/paths';

export function LoginPage() {
  const { refresh, state, company, username: remembered, rememberLogin } = useSession();
  const [username, setUsername] = useState(remembered);
  const [password, setPassword] = useState('');
  // Bộ so ảnh (chỉ bản dev): ?demo=wrong-password mở sẵn trạng thái E-001.
  const [err, setErr] = useState<unknown>(() => (import.meta.env.DEV && demoFlag('wrong-password') ? { code: 'invalid_credentials' } : null));
  const phone = useIsPhone();
  // Khoá tạm (E-002): đếm ngược theo mốc giờ, mỗi giây tính lại số giây còn lại cho chữ "Thử lại sau 14:52" và số phút trong câu.
  const [lockUntil, setLockUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const lockLeft = lockUntil ? Math.max(0, Math.ceil((lockUntil - now) / 1000)) : 0;
  useEffect(() => {
    if (!lockUntil) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [lockUntil]);
  // Hết khoá tạm thì bỏ câu E-002 và mở lại nút Đăng nhập.
  useEffect(() => {
    if (lockUntil && lockLeft === 0) {
      setErr(null);
      setLockUntil(0);
    }
  }, [lockUntil, lockLeft]);

  const view = loginView(err, lockLeft);

  // E-026 ("Chờ kết nối mạng"): có mạng lại thì mở nút để đăng nhập.
  const waitingNetwork = view.notice?.code === 'offline_attempts_exceeded';
  useEffect(() => {
    if (!waitingNetwork) return;
    const on = () => setErr(null);
    window.addEventListener('online', on);
    return () => window.removeEventListener('online', on);
  }, [waitingNetwork]);

  const [send, busy] = useAction(async () => {
    setErr(null);
    setLockUntil(0);
    try {
      await platform.login(username.trim(), password);
      rememberLogin(username, password); // mật khẩu chỉ nằm trong bộ nhớ, dùng làm "mật khẩu hiện tại" nếu đây là mật khẩu tạm
      await refresh();
    } catch (e) {
      setErr(e);
      const secs = lockSecondsOf(e);
      if (secs > 0) {
        setNow(Date.now());
        setLockUntil(Date.now() + secs * 1000);
      }
      if (loginView(e, secs).clearPassword) setPassword(''); // tên đăng nhập luôn giữ; lỗi mạng giữ mật khẩu để Thử lại
    }
  });
  // Enter và nút Đăng nhập cùng đi qua form: đang gửi thì lần gửi tiếp bị bỏ qua (cờ trong useAction).
  function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || view.button.disabled || !username.trim() || !password) return;
    void send();
  }

  const device = state?.license?.deviceName;
  // Trên web chưa biết công ty trước khi đăng nhập: dòng phụ ghi tên sản phẩm (khác khung pen, xem frames.json CT91Y).
  const form = {
    username,
    password,
    onUsername: setUsername,
    onPassword: setPassword,
    notice: view.notice,
    invalidFields: view.invalidFields,
    button: view.button,
    busy,
    placeholderPassword: view.notice ? 'Nhập mật khẩu' : '',
    onSubmit: submit,
    autoFocus: true,
  };
  if (!isDesktop) {
    // Trang đăng nhập tách khỏi trang chủ công khai: luôn có đường về trang chủ và hai văn bản pháp lý.
    const below = (
      <>
        Trên web: Báo cáo (Admin, Manager, Leader) và Quản trị (Admin).{' '}
        <Link to={LANDING_PATH} className="font-semibold text-accent hover:underline">
          Trang chủ
        </Link>{' '}
        ·{' '}
        <Link to={POLICY_PATH} className="font-semibold text-accent hover:underline">
          Chính sách
        </Link>{' '}
        ·{' '}
        <Link to={TERM_PATH} className="font-semibold text-accent hover:underline">
          Điều khoản
        </Link>
      </>
    );
    return <AuthScreen below={below}>{phone ? <PhoneLoginForm subtitle={`${PRODUCT_NAME} bản web`} {...form} /> : <LoginCard subtitle={`Bản web  ·  ${PRODUCT_NAME}`} {...form} />}</AuthScreen>;
  }
  return (
    <AuthScreen workspace={company} below={device ? `Máy ${device}${state?.license?.company ? ` · bản quyền ${state.license.company}` : ''}` : undefined}>
      <LoginCard subtitle={company} {...form} />
    </AuthScreen>
  );
}
