/* Khối trình bày dùng chung cho khu Hỗ trợ người dùng (phong cách help center). */
import type { ReactNode } from "react";
import { Link, type LinkProps } from "@tanstack/react-router";
import { Button, Input } from "@fluentui/react-components";
import { Search20Regular, Call20Regular, BugRegular } from "@fluentui/react-icons";
import { BUG_CR_LOG_URL, type SupTone } from "@/lib/support/support-data";

export function SupportShell({ children }: { children: ReactNode }) {
  return (
    <div className="dlp-sup">
      <div className="dlp-sup__wrap">{children}</div>
    </div>
  );
}

export function SupportHero({
  title,
  subtitle,
  value,
  onChange,
  placeholder = "Tìm câu hỏi, tài liệu hoặc mã yêu cầu…",
  chips = [],
  onChipClick,
}: {
  title: string;
  subtitle: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  chips?: string[];
  onChipClick?: (chip: string) => void;
}) {
  return (
    <section className="dlp-sup__hero">
      <div className="dlp-sup__hero-heading">
        <h1 className="dlp-sup__hero-title">{title}</h1>
      </div>
      <p className="dlp-sup__hero-sub">{subtitle}</p>
      <div className="dlp-sup__searchwrap">
        <Input
          value={value}
          onChange={(_, d) => onChange(d.value)}
          placeholder={placeholder}
          contentBefore={<Search20Regular />}
          appearance="filled-lighter"
          style={{ width: "100%" }}
          aria-label="Tìm trong trung tâm hỗ trợ"
        />
      </div>
      <div className="dlp-sup__hero-contact">
        <a href={BUG_CR_LOG_URL} className="dlp-sup__hero-bug-cr" target="_blank" rel="noreferrer">
          <BugRegular fontSize={20} />
          <span>
            <strong>Log BUG/CR</strong>
            <small>Ghi nhận lỗi hoặc yêu cầu thay đổi</small>
          </span>
        </a>
        <span className="dlp-sup__hero-contact-dev">
          Developer DLP LIMS: <strong>Ban Nguyen (pandev00)</strong>
        </span>
        <a
          href="tel:+84862652435"
          className="dlp-sup__hero-contact-hot"
          aria-label="Gọi hotline hỗ trợ 24/7"
        >
          <span className="dlp-sup__hero-hot-icon" aria-hidden="true">
            <Call20Regular />
          </span>
          <span className="dlp-sup__hero-hot-label">Nóng gấp</span>
          <span className="dlp-sup__hero-hot-number">086.265.2435</span>
          <span className="dlp-sup__hero-hot-badge">24/7</span>
        </a>
      </div>
      {chips.length > 0 ? (
        <div className="dlp-sup__hero-chips">
          {chips.map((c) => (
            <button
              key={c}
              type="button"
              className="dlp-sup__hero-chip"
              onClick={() => onChipClick?.(c)}
            >
              {c}
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
}

export function SupportCard({
  icon,
  title,
  desc,
  count,
  to,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  desc: string;
  count?: string;
  to?: LinkProps["to"];
  onClick?: () => void;
}) {
  const inner = (
    <>
      <span className="dlp-sup__card-icon">{icon}</span>
      <span className="dlp-sup__card-title">{title}</span>
      <span className="dlp-sup__card-desc">{desc}</span>
      {count ? <span className="dlp-sup__card-count">{count}</span> : null}
    </>
  );

  if (to) {
    return (
      <Link to={to} className="dlp-sup__card">
        {inner}
      </Link>
    );
  }
  return (
    <button type="button" className="dlp-sup__card" onClick={onClick}>
      {inner}
    </button>
  );
}

export function SupportPanel({
  title,
  action,
  padded,
  children,
}: {
  title: string;
  action?: ReactNode;
  padded?: boolean;
  children: ReactNode;
}) {
  return (
    <section className="dlp-sup__panel">
      <div className="dlp-sup__panel-head">
        <span className="dlp-sup__panel-title">{title}</span>
        {action}
      </div>
      <div
        className={padded ? "dlp-sup__panel-body dlp-sup__panel-body--pad" : "dlp-sup__panel-body"}
      >
        {children}
      </div>
    </section>
  );
}

export function ArticleRow({
  title,
  desc,
  meta,
  onClick,
}: {
  title: string;
  desc?: string;
  meta?: ReactNode;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      className={onClick ? "dlp-sup__row" : "dlp-sup__row dlp-sup__row--static"}
      onClick={onClick}
      disabled={!onClick}
    >
      <span className="dlp-sup__row-main">
        <span className="dlp-sup__row-title">{title}</span>
        {desc ? <span className="dlp-sup__row-desc">{desc}</span> : null}
      </span>
      {meta ? <span className="dlp-sup__row-meta">{meta}</span> : null}
    </button>
  );
}

export function StatusPill({ tone, label }: { tone: SupTone; label: string }) {
  return <span className={`dlp-sup__pill dlp-sup__pill--${tone}`}>{label}</span>;
}

export function SupportCta({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="dlp-sup__cta">
      <div>
        <div className="dlp-sup__cta-title">Không tìm thấy câu trả lời?</div>
        <div className="dlp-sup__cta-sub">
          Gửi yêu cầu cho đội hỗ trợ - phản hồi trong 4 giờ làm việc.
        </div>
      </div>
      <Button appearance="primary" onClick={onCreate}>
        Gửi yêu cầu hỗ trợ
      </Button>
    </div>
  );
}
