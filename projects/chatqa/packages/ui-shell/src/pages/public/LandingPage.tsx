// Trang chủ công khai: giới thiệu sản phẩm cho người chưa đăng nhập (Google OAuth yêu cầu trang chủ không nằm sau màn đăng nhập).
// Đăng nhập là trang riêng /dang-nhap. Nội dung riêng của từng sản phẩm nằm ở PRODUCT.landing (src/product.ts của app).
import { Link } from 'react-router';
import { ArrowRight, Bot, Check, Cloud, Database, Gift, LockKeyhole, ShieldCheck, Sparkles } from 'lucide-react';
import { ProductMark } from '@product/brand';
import { PRODUCT } from '@product/product';
import { PRODUCT_NAME } from '../../lib/auth-ui';
import { AgentSkill } from './AgentSkill';
import { DownloadBar } from './DownloadBar';
import { HeroVideo } from './HeroVideo';
import { LearnSection } from './LearnSection';
import { TrialForm } from './TrialForm';
import { PublicLayout } from './PublicLayout';
import { CONTACT_EMAIL } from './legal-copy';
import { LOGIN_PATH, POLICY_PATH, TERM_PATH } from './paths';
import type { LandingPlan } from './landing-types';

const TRUST_ICONS = { cloud: <Cloud size={17} />, lock: <LockKeyhole size={17} />, shield: <ShieldCheck size={17} /> } as const;

const BTN_PRIMARY =
  'inline-flex h-[42px] items-center gap-[8px] rounded-[9px] bg-accent px-[18px] text-[14px]/[18px] font-semibold text-white transition-[filter] hover:brightness-95';
const BTN_SECONDARY =
  'inline-flex h-[42px] items-center gap-[8px] rounded-[9px] bg-surface px-[16px] text-[13.5px]/[18px] font-semibold text-text shadow-[inset_0_0_0_1px_var(--color-border)] hover:bg-bg';

/** Nút cuối thẻ gói: đường nội bộ đi qua router, còn lại là liên kết thường. */
function PlanCta({ cta }: { cta: NonNullable<LandingPlan['cta']> }) {
  const cls =
    'mt-[16px] inline-flex h-[38px] items-center justify-center gap-[7px] rounded-[9px] bg-accent-soft px-[14px] text-[13px]/[17px] font-semibold text-accent-ink hover:brightness-95';
  if (cta.href.startsWith('/')) {
    return (
      <Link to={cta.href} className={cls}>
        {cta.label}
      </Link>
    );
  }
  const external = cta.href.startsWith('http');
  return (
    <a href={cta.href} className={cls} {...(external ? { target: '_blank', rel: 'noreferrer' } : {})}>
      {cta.label}
    </a>
  );
}

export function LandingPage() {
  const landing = PRODUCT.landing;
  return (
    <PublicLayout title={`${PRODUCT_NAME} · ${landing.tagline}`}>
      {/* Tải app */}
      <DownloadBar />

      {/* Giới thiệu */}
      <section className="border-b border-border bg-gradient-to-b from-accent-soft/70 via-surface to-surface">
        <div
          className={`mx-auto grid w-full max-w-[1080px] items-center gap-[36px] px-[20px] pt-[48px] pb-[44px] lg:pt-[68px] lg:pb-[60px] ${landing.heroVideo ? '' : 'lg:grid-cols-[1.08fr_0.92fr]'}`}
        >
          <div>
            <p className="inline-flex items-center gap-[7px] rounded-full bg-surface px-[11px] py-[5px] text-[11.5px]/[15px] font-bold tracking-[0.6px] text-accent-ink uppercase shadow-[inset_0_0_0_1px_var(--color-border)]">
              <ProductMark className="h-[17px] w-[17px] rounded-[5px]" glyph={10} tone="light" />
              {landing.tagline}
            </p>
            <h1 className="mt-[14px] text-[30px]/[38px] font-bold tracking-[-0.3px] sm:text-[38px]/[47px]">{landing.headline}</h1>
            <p className="mt-[14px] max-w-[560px] text-[14.5px]/[24px] text-text-2">{landing.intro}</p>
            <div className="mt-[22px] flex flex-wrap items-center gap-[10px]">
              {landing.trial ? (
                <a href="#dung-thu" className={BTN_PRIMARY}>
                  <Gift size={16} />
                  Nhận license 1 năm miễn phí
                </a>
              ) : (
                <Link to={LOGIN_PATH} className={BTN_PRIMARY}>
                  Đăng nhập
                  <ArrowRight size={16} />
                </Link>
              )}
              {landing.agentSkill ? (
                <a href="#skill" className={BTN_SECONDARY}>
                  <Bot size={16} />
                  Cài skill cho AI agent
                </a>
              ) : null}
              {/* Sản phẩm có kho mã nguồn thì icon GitHub nằm ở thanh trên, không lặp lại ở đây */}
              {landing.repoUrl ? null : (
                <Link to={POLICY_PATH} className={BTN_SECONDARY}>
                  Chính sách quyền riêng tư
                </Link>
              )}
            </div>
            <p className="mt-[12px] text-[12px]/[18px] text-text-3">
              {landing.accountNote ?? (
                <>
                  Tài khoản do quản trị viên của công ty cấp. Chưa có tài khoản, liên hệ{' '}
                  <a href={`mailto:${CONTACT_EMAIL}`} className="font-semibold text-text-2 hover:text-text">
                    {CONTACT_EMAIL}
                  </a>
                  .
                </>
              )}
            </p>
          </div>

          {/* Video giới thiệu, hoặc thẻ minh hoạ các tính năng chính và nơi lưu dữ liệu */}
          {landing.heroVideo ? (
            <HeroVideo video={landing.heroVideo} />
          ) : (
            <div className="relative mx-auto w-full max-w-[420px]">
              <div className="rounded-[14px] bg-surface p-[18px] shadow-[0_18px_44px_rgba(14,16,20,0.10)] ring-1 ring-border">
                <div className="flex items-center gap-[9px]">
                  <ProductMark className="h-[26px] w-[26px] rounded-[7px]" glyph={14} tone="light" />
                  <span className="text-[13px]/[17px] font-bold">{PRODUCT_NAME}</span>
                  <span className="flex-1" />
                  {landing.cardBadge ? (
                    <span className="rounded-[5px] bg-green-soft px-[7px] py-[2px] text-[10px]/[13px] font-bold text-green">{landing.cardBadge}</span>
                  ) : null}
                </div>
                <div className="mt-[14px] flex flex-col gap-[8px]">
                  {landing.features.slice(0, 3).map((f) => (
                    <div key={f.title} className="flex items-start gap-[9px] rounded-[9px] bg-bg px-[11px] py-[10px]">
                      <span className="mt-[1px] flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
                        <Check size={12} strokeWidth={3} />
                      </span>
                      <div className="min-w-0">
                        <p className="text-[12.5px]/[16px] font-semibold">{f.title}</p>
                        <p className="mt-[1px] line-clamp-2 text-[11.5px]/[16px] text-text-3">{f.text}</p>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="mt-[14px] flex items-center gap-[7px] rounded-[9px] bg-accent-soft px-[11px] py-[9px] text-[11.5px]/[15px] font-medium text-text-2">
                  <Database size={14} className="shrink-0 text-accent" />
                  {landing.storeLabel}
                  <span className="flex-1" />
                  <LockKeyhole size={13} className="shrink-0 text-text-3" />
                </div>
              </div>
              {landing.heroNote ? (
                <p className="mt-[12px] flex items-center justify-center gap-[6px] text-[11px]/[15px] font-semibold text-text-3">
                  <Sparkles size={13} className="text-accent" />
                  {landing.heroNote}
                </p>
              ) : null}
            </div>
          )}
        </div>
      </section>

      {/* Khoá học dùng sản phẩm: ngay dưới đầu trang để người mới thấy chỗ học từ đầu */}
      {landing.learn ? <LearnSection learn={landing.learn} /> : null}

      {/* Skill cho AI agent: đặt ngay dưới đầu trang để người dùng thấy và cài trước */}
      {landing.agentSkill ? <AgentSkill skill={landing.agentSkill} /> : null}

      {/* Tính năng theo sản phẩm */}
      <section className="mx-auto w-full max-w-[1080px] px-[20px] py-[44px]">
        <p className="text-[11px]/[14px] font-bold tracking-[1.4px] text-accent-ink uppercase">Tính năng</p>
        <h2 className="mt-[6px] text-[22px]/[30px] font-bold sm:text-[26px]/[34px]">{landing.featuresTitle}</h2>
        <div className={`mt-[20px] grid gap-[12px] sm:grid-cols-2 ${landing.features.length % 3 === 0 ? 'lg:grid-cols-3' : ''}`}>
          {landing.features.map((f, i) => (
            <div key={f.title} className="rounded-[12px] bg-surface p-[18px] ring-1 ring-border">
              <span className="text-[11px]/[14px] font-bold tracking-[1.2px] text-text-3">{String(i + 1).padStart(2, '0')}</span>
              <h3 className="mt-[6px] text-[15px]/[20px] font-bold">{f.title}</h3>
              <p className="mt-[6px] text-[13.5px]/[21px] text-text-2">{f.text}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Bảng giá */}
      {landing.pricing ? (
        <section id="bang-gia" className="scroll-mt-[70px] border-t border-border">
          <div className="mx-auto w-full max-w-[1080px] px-[20px] py-[44px]">
            <p className="text-[11px]/[14px] font-bold tracking-[1.4px] text-accent-ink uppercase">Bảng giá</p>
            <h2 className="mt-[6px] text-[22px]/[30px] font-bold sm:text-[26px]/[34px]">{landing.pricing.title}</h2>
            <p className="mt-[8px] max-w-[720px] text-[13.5px]/[22px] text-text-2">{landing.pricing.intro}</p>
            <div className="mt-[20px] grid gap-[12px] md:grid-cols-3">
              {landing.pricing.plans.map((plan) => (
                <div key={plan.name} className="flex flex-col rounded-[12px] bg-surface p-[18px] ring-1 ring-border">
                  <h3 className="text-[14px]/[19px] font-bold">{plan.name}</h3>
                  <p className="mt-[10px] text-[22px]/[28px] font-bold tracking-[-0.2px]">{plan.price}</p>
                  <p className="mt-[2px] text-[12px]/[17px] font-medium text-accent-ink">{plan.priceNote}</p>
                  <p className="mt-[10px] text-[13px]/[20px] text-text-2">{plan.text}</p>
                  <ul className="mt-[12px] flex flex-1 flex-col gap-[7px]">
                    {plan.points.map((pt) => (
                      <li key={pt} className="flex items-start gap-[8px] text-[12.5px]/[19px] text-text-2">
                        <Check size={14} strokeWidth={2.6} className="mt-[2px] shrink-0 text-accent" />
                        {pt}
                      </li>
                    ))}
                  </ul>
                  {plan.cta ? <PlanCta cta={plan.cta} /> : null}
                </div>
              ))}
            </div>
          </div>
        </section>
      ) : null}

      {/* Mục giới thiệu riêng của sản phẩm (vd MCP, đội agent) */}
      {landing.sections.map((sec) => (
        <section key={sec.title} className="border-t border-border bg-bg">
          <div className="mx-auto w-full max-w-[1080px] px-[20px] py-[44px]">
            <p className="text-[11px]/[14px] font-bold tracking-[1.4px] text-accent-ink uppercase">{sec.kicker}</p>
            <h2 className="mt-[6px] text-[22px]/[30px] font-bold sm:text-[26px]/[34px]">{sec.title}</h2>
            <p className="mt-[8px] max-w-[720px] text-[13.5px]/[22px] text-text-2">{sec.intro}</p>
            <div className={`mt-[18px] grid gap-[12px] sm:grid-cols-2 ${sec.items.length % 3 === 0 ? 'lg:grid-cols-3' : ''}`}>
              {sec.items.map((it) => (
                <div key={it.title} className="rounded-[12px] bg-surface p-[16px] ring-1 ring-border">
                  <h3 className="text-[14px]/[19px] font-bold">{it.title}</h3>
                  <p className="mt-[5px] text-[12.5px]/[20px] text-text-2">{it.text}</p>
                </div>
              ))}
            </div>
            {sec.note ? <p className="mt-[14px] max-w-[720px] text-[12.5px]/[19px] text-text-3">{sec.note}</p> : null}
          </div>
        </section>
      ))}

      {/* License dùng thử */}
      {landing.trial ? (
        <section id="dung-thu" className="scroll-mt-[70px] border-y border-border bg-gradient-to-b from-accent-soft/60 to-surface">
          <div className="mx-auto grid w-full max-w-[1080px] gap-[28px] px-[20px] py-[44px] lg:grid-cols-[0.9fr_1.1fr]">
            <div>
              <p className="text-[11px]/[14px] font-bold tracking-[1.4px] text-accent-ink uppercase">Dùng thử</p>
              <h2 className="mt-[6px] text-[22px]/[30px] font-bold sm:text-[26px]/[34px]">{landing.trial.title}</h2>
              <p className="mt-[8px] text-[13.5px]/[22px] text-text-2">{landing.trial.intro}</p>
              <ul className="mt-[14px] flex flex-col gap-[8px]">
                {landing.trial.perks.map((p) => (
                  <li key={p} className="flex items-start gap-[9px] text-[13px]/[20px] text-text-2">
                    <span className="mt-[2px] flex h-[16px] w-[16px] shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
                      <Check size={11} strokeWidth={3} />
                    </span>
                    {p}
                  </li>
                ))}
              </ul>
            </div>
            <div className="rounded-[14px] bg-surface p-[20px] shadow-[0_18px_44px_rgba(14,16,20,0.08)] ring-1 ring-border">
              <TrialForm contact={CONTACT_EMAIL} />
              <p className="mt-[12px] text-[11.5px]/[17px] text-text-3">
                Thông tin chỉ dùng để cấp license và hỗ trợ, xem{' '}
                <Link to={POLICY_PATH} className="font-semibold text-text-2 hover:text-text">
                  chính sách quyền riêng tư
                </Link>
                .
              </p>
            </div>
          </div>
        </section>
      ) : null}

      {/* Dữ liệu và quyền riêng tư */}
      <section className="border-y border-border bg-bg">
        <div className="mx-auto w-full max-w-[1080px] px-[20px] py-[44px]">
          <p className="text-[11px]/[14px] font-bold tracking-[1.4px] text-accent-ink uppercase">Dữ liệu & quyền riêng tư</p>
          <h2 className="mt-[6px] text-[22px]/[30px] font-bold sm:text-[26px]/[34px]">Dữ liệu của bạn vẫn là của bạn</h2>
          <p className="mt-[8px] max-w-[680px] text-[13.5px]/[22px] text-text-2">
            Chúng tôi chỉ giữ những gì cần để vận hành tài khoản, bản quyền và bảo mật. Chi tiết từng loại dữ liệu, mục đích và thời gian lưu được ghi đầy đủ trong chính sách.
          </p>
          <div className="mt-[18px] grid gap-[12px] md:grid-cols-3">
            {landing.trust.map((t) => (
              <div key={t.title} className="rounded-[12px] bg-surface p-[16px] ring-1 ring-border">
                <span className="flex h-[30px] w-[30px] items-center justify-center rounded-[8px] bg-accent-soft text-accent">{TRUST_ICONS[t.icon]}</span>
                <h3 className="mt-[10px] text-[13.5px]/[18px] font-bold">{t.title}</h3>
                <p className="mt-[5px] text-[12.5px]/[19px] text-text-2">{t.text}</p>
              </div>
            ))}
          </div>
          <p className="mt-[14px] text-[12.5px]/[19px] text-text-2">
            Đọc{' '}
            <Link to={POLICY_PATH} className="font-semibold text-accent hover:underline">
              Chính sách quyền riêng tư
            </Link>{' '}
            và{' '}
            <Link to={TERM_PATH} className="font-semibold text-accent hover:underline">
              Điều khoản sử dụng
            </Link>
            .
          </p>
        </div>
      </section>

      {/* Đăng nhập */}
      {landing.loginNote ? (
        <section className="mx-auto w-full max-w-[1080px] px-[20px] py-[44px]">
          <div className="flex flex-col items-start justify-between gap-[16px] rounded-[14px] bg-chrome px-[22px] py-[22px] sm:flex-row sm:items-center">
            <div>
              <h2 className="text-[18px]/[24px] font-bold text-white">Đã có tài khoản {PRODUCT_NAME}?</h2>
              <p className="mt-[4px] text-[13px]/[20px] text-chrome-text">
                {landing.loginNote}
              </p>
            </div>
            <Link
              to={LOGIN_PATH}
              className="inline-flex h-[40px] shrink-0 items-center gap-[8px] rounded-[9px] bg-accent px-[18px] text-[13.5px]/[18px] font-semibold text-white hover:brightness-95"
            >
              Đăng nhập
              <ArrowRight size={15} />
            </Link>
          </div>
        </section>
      ) : null}
    </PublicLayout>
  );
}
