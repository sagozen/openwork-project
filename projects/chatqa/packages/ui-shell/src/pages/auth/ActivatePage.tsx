import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, BadgeCheck, Check } from 'lucide-react';
import { platform } from '../../platform';
import { errorText, useSession } from '../../lib/session';
import { activationView, formatLicenseKey, type Notice } from '../../lib/auth-ui';
import { appIcon } from '../../components/shell/AppMenu';
import { Button, Stepper } from '../../components/ui';
import { useAction } from '../../lib/use-action';
import { appNo, moduleByCode } from '@product/modules/registry';
import type { AppCode, LicenseInfo } from '../../platform';
import { ActivationCard, AuthCard } from './cards';
import { AuthScreen } from './AuthScreen';

export const ACTIVATE_STEPS = ['Kích hoạt máy', 'Đăng nhập'];
const AUTO_CONTINUE_MS = 3000;
const BELOW = 'Cần kết nối mạng khi kích hoạt. Sau đó vẫn làm việc được khi mất mạng.';

/** Bản quyền đã có nhưng hết hạn: báo ngay trong thẻ để người dùng biết vì sao phải kích hoạt lại. */
function initialNotice(status: string | undefined): Notice | null {
  return status === 'expired' ? { tone: 'red', icon: 'circle-x', text: errorText({ code: 'license_expired' }), code: 'license_expired' } : null;
}

export interface ActivationSuccessProps {
  company?: string;
  device: string;
  seats?: { used: number; max: number };
  apps: AppCode[];
  onContinue: () => void;
  width?: number;
}

/** Kích hoạt xong (K1soG): tên công ty, số máy đã dùng, các app đã mua. Tự chuyển sang đăng nhập sau 3 giây. */
export function ActivationSuccessCard({ company, device, seats, apps, onContinue, width = 420 }: ActivationSuccessProps) {
  const listed = apps.map((c) => moduleByCode(c)).sort((a, b) => a.no - b.no);
  return (
    <AuthCard width={width}>
      <div className="flex flex-col gap-[10px]">
        <span className="flex h-[44px] w-[44px] items-center justify-center rounded-full bg-green-soft text-green">
          <BadgeCheck size={22} />
        </span>
        <h1 className="w-full text-[20px]/[25px] font-bold tracking-[-0.3px] text-text">{company ? `Đã kích hoạt cho ${company}` : 'Đã kích hoạt máy này'}</h1>
        <p className="w-full text-[13px]/[20px] text-text-2">
          Máy {device} đã được ghi nhận.{seats ? ` Công ty đang dùng ${seats.used}/${seats.max} máy.` : ''}
        </p>
      </div>
      <div className="stroke-in flex flex-col rounded-[10px]">
        <div className="rounded-t-[10px] bg-table-head px-[14px] py-[8px] text-[9px]/[11px] font-bold tracking-[0.6px] text-text-3 shadow-[inset_0_-1px_0_var(--color-border)]">APP CÔNG TY ĐÃ MUA</div>
        {listed.map((m, i) => {
          const Icon = appIcon(m.code);
          return (
            <div key={m.code} className={`flex items-center gap-[10px] px-[14px] py-[9px] ${i < listed.length - 1 ? 'shadow-[inset_0_-1px_0_var(--color-divider)]' : ''}`}>
              <Icon size={15} className="shrink-0 text-text-2" />
              <span className="min-w-0 flex-1 text-[12px]/[14px] text-text">
                {appNo(m)} · {m.name}
              </span>
              <Check size={14} className="shrink-0 text-green" />
            </div>
          );
        })}
      </div>
      <Button size="auth" block onClick={onContinue} type="button" className="gap-[8px]">
        Tiếp tục đăng nhập
        <ArrowRight size={15} />
      </Button>
    </AuthCard>
  );
}

export function ActivatePage() {
  const { state, refresh } = useSession();
  const [key, setKey] = useState('');
  const [err, setErr] = useState<unknown>(() => null);
  const [done, setDone] = useState<LicenseInfo | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const view = activationView(err);
  const notice = view.notice ?? initialNotice(state?.license?.status);

  // Kích hoạt xong chỉ chuyển sang đăng nhập khi người dùng bấm hoặc sau 3 giây: tới lúc đó giữ nguyên màn thành công.
  useEffect(() => {
    if (!done) return;
    timer.current = setTimeout(() => void refresh(), AUTO_CONTINUE_MS);
    return () => clearTimeout(timer.current);
  }, [done, refresh]);

  const [activate, busy] = useAction(async () => {
    setErr(null);
    try {
      setDone(await platform.activateLicense!(key));
    } catch (e) {
      setErr(e); // mã đã gõ vẫn giữ trong ô để sửa lại
    }
  });
  function submit(e: FormEvent) {
    e.preventDefault();
    void activate();
  }

  if (done) {
    return (
      <AuthScreen workspace={done.company} stepper={<Stepper steps={ACTIVATE_STEPS} current={1} done={1} />} below="Tự chuyển sang màn Đăng nhập sau 3 giây.">
        <ActivationSuccessCard company={done.company} device={done.deviceName} seats={done.seats} apps={done.apps} onContinue={() => void refresh()} />
      </AuthScreen>
    );
  }
  return (
    <AuthScreen workspace="Máy chưa kích hoạt" stepper={<Stepper steps={ACTIVATE_STEPS} current={0} />} below={BELOW}>
      <ActivationCard
        value={key}
        onChange={(v) => setKey(formatLicenseKey(v))}
        notice={notice}
        invalidKey={view.invalidKey}
        button={view.button}
        busy={busy}
        machine={state?.license?.deviceName}
        onSubmit={submit}
      />
    </AuthScreen>
  );
}
