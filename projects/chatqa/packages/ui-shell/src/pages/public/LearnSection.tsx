// Khối giới thiệu khoá học dùng sản phẩm (PRODUCT.landing.learn) ngay dưới đầu trang chủ.
// Khoá học nằm ở trang ngoài nên mọi link mở tab mới và không để lộ trang gốc cho trang đích.
import { ArrowUpRight, Check, GraduationCap } from 'lucide-react';
import type { LandingLearn } from './landing-types';

/** Thuộc tính chung cho link sang khoá học (trang ngoài): tab mới, không opener, không referrer. */
export const EXTERNAL_LINK = { target: '_blank', rel: 'noopener noreferrer' } as const;

export function LearnSection({ learn }: { learn: LandingLearn }) {
  return (
    <section id="hoc" className="scroll-mt-[70px] border-b border-border bg-bg">
      <div className="mx-auto w-full max-w-[1080px] px-[20px] py-[44px]">
        <div className="grid items-center gap-[24px] rounded-[14px] bg-surface p-[20px] ring-1 ring-border sm:p-[24px] lg:grid-cols-[1.1fr_0.9fr]">
          <div>
            <p className="inline-flex items-center gap-[7px] text-[11px]/[14px] font-bold tracking-[1.4px] text-accent-ink uppercase">
              <GraduationCap size={15} className="text-accent" />
              {learn.kicker}
            </p>
            <h2 className="mt-[6px] text-[22px]/[30px] font-bold sm:text-[26px]/[34px]">{learn.title}</h2>
            <p className="mt-[8px] max-w-[620px] text-[13.5px]/[22px] text-text-2">{learn.intro}</p>
            <a
              href={learn.url}
              {...EXTERNAL_LINK}
              className="mt-[18px] inline-flex h-[42px] items-center gap-[8px] rounded-[9px] bg-accent px-[18px] text-[14px]/[18px] font-semibold text-white transition-[filter] hover:brightness-95"
            >
              {learn.cta}
              <ArrowUpRight size={16} />
            </a>
          </div>
          <ul className="flex flex-col gap-[8px]">
            {learn.points.map((pt) => (
              <li key={pt} className="flex items-start gap-[9px] rounded-[9px] bg-bg px-[12px] py-[11px] text-[13px]/[20px] text-text-2">
                <span className="mt-[2px] flex h-[16px] w-[16px] shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
                  <Check size={11} strokeWidth={3} />
                </span>
                {pt}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
