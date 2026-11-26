import type { ReactNode } from "react";
import { useLocale } from "../i18n.js";
import { Icon } from "../icons.js";
import { cx } from "../utils.js";
import { Button } from "./actions.js";

/* ---------------------------------------------------------------- hero */

export function Hero({
  eyebrow,
  title,
  subtitle,
  primary,
  secondary,
  tertiary,
  note,
  preview,
  headingLevel = 1,
}: {
  eyebrow: string;
  title: string;
  subtitle: string;
  primary: ReactNode;
  secondary?: ReactNode;
  tertiary?: ReactNode;
  note?: string;
  preview?: ReactNode;
  headingLevel?: 1 | 2;
}) {
  const Heading = headingLevel === 2 ? "h2" : "h1";
  return (
    <section className="td-hero">
      <div className="td-hero__copy">
        <p className="td-eyebrow">{eyebrow}</p>
        <Heading className="td-hero__title">{title}</Heading>
        <p className="td-hero__subtitle">{subtitle}</p>
        <div className="td-hero__actions">
          {primary}
          {secondary}
          {tertiary}
        </div>
        {note ? (
          <p className="td-hero__note">
            <Icon name="check" size={14} /> {note}
          </p>
        ) : null}
      </div>
      {preview ? <div className="td-hero__preview">{preview}</div> : null}
    </section>
  );
}

/* --------------------------------------------------------- how it works */

export function HowItWorks({ steps }: { steps: Array<{ title: string; body: string }> }) {
  return (
    <section className="td-how">
      <ol>
        {steps.map((step, index) => (
          <li key={step.title}>
            <span className="td-how__number" aria-hidden="true">
              {index + 1}
            </span>
            <div>
              <h3>{step.title}</h3>
              <p>{step.body}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

/* --------------------------------------------------------- template card */

export interface TemplateCardProps {
  title: string;
  description: string;
  kind: "certificate" | "cfo" | "logistics" | "kdp";
  pageLabel: string;
  languages: string[];
  pages: number;
  imageSrc: string;
  imageSrcSet?: string;
  /** Intrinsic preview size, so the media box reserves the real page aspect before load. */
  imageWidth?: number;
  imageHeight?: number;
  href: string;
  onUse?: () => void;
  featured?: boolean;
}

export function TemplateCard({
  title,
  description,
  kind,
  pageLabel,
  languages,
  pages,
  imageSrc,
  imageSrcSet,
  imageWidth = 400,
  imageHeight = 300,
  href,
  onUse,
  featured = false,
}: TemplateCardProps) {
  const { t } = useLocale();
  return (
    <article className={cx("td-card", featured && "td-card--featured")}>
      <div className="td-card__media">
        <img
          src={imageSrc}
          srcSet={imageSrcSet}
          sizes="(max-width: 720px) 90vw, 320px"
          alt={`${title} preview`}
          width={imageWidth}
          height={imageHeight}
          loading="lazy"
          decoding="async"
        />
        <span className="td-card__sample">{t("badge.sample")}</span>
      </div>
      <div className="td-card__body">
        <p className="td-card__kicker">
          {kind === "certificate"
            ? "Certificate"
            : kind === "logistics"
              ? "Logistics"
              : kind === "kdp"
                ? "KDP book"
                : "CFO report"}
        </p>
        <h3 className="td-card__title">
          <a href={href}>{title}</a>
        </h3>
        <p className="td-card__description">{description}</p>
        <ul className="td-card__meta" aria-label="Template details">
          <li>{pageLabel}</li>
          <li>{languages.join(" · ")}</li>
          <li>{t("job.pages", { count: pages })}</li>
        </ul>
        <div className="td-card__actions">
          <a className="td-btn td-btn--primary td-btn--sm" href={href} onClick={onUse}>
            {t("proto.detail.use")}
          </a>
          <a className="td-btn td-btn--tertiary td-btn--sm" href={href}>
            {t("common.open")} <Icon name="arrow-right" size={14} />
          </a>
        </div>
      </div>
    </article>
  );
}

/* ------------------------------------------------------------ price pack */

export interface PricingPackProps {
  name: string;
  credits: number;
  price: string;
  perPage: string;
  featured?: boolean;
  onSelect?: () => void;
  /** This pack's checkout is being created. */
  loading?: boolean;
  /** Another pack's checkout is being created. */
  disabled?: boolean;
}

export function PricingPack({
  name,
  credits,
  price,
  perPage,
  featured = false,
  onSelect,
  loading = false,
  disabled = false,
}: PricingPackProps) {
  const { t } = useLocale();
  return (
    <article className={cx("td-pack", featured && "td-pack--featured")}>
      {featured ? <span className="td-pack__ribbon">{t("badge.new")}</span> : null}
      <h3 className="td-pack__name">{name}</h3>
      <p className="td-pack__price">
        <strong>{price}</strong> <span>USD</span>
      </p>
      <p className="td-pack__credits">{t("billing.creditsCount", { count: credits })}</p>
      <p className="td-pack__per">{perPage}</p>
      <Button
        variant={featured ? "primary" : "secondary"}
        fullWidth
        loading={loading}
        disabled={disabled}
        onClick={onSelect}
      >
        {t("billing.buy")}
      </Button>
      <p className="td-pack__note">{t("billing.oneTime")}</p>
    </article>
  );
}

/* --------------------------------------------------------- feature card */

export function FeatureCard({
  icon,
  title,
  body,
}: {
  icon: Parameters<typeof Icon>[0]["name"];
  title: string;
  body: string;
}) {
  return (
    <article className="td-feature">
      <span className="td-feature__icon" aria-hidden="true">
        <Icon name={icon} size={20} />
      </span>
      <h3>{title}</h3>
      <p>{body}</p>
    </article>
  );
}

/* ------------------------------------------------------------ empty art */

export function DocumentDesk({
  src,
  alt,
  width = 400,
  height = 300,
}: {
  src: string;
  alt: string;
  width?: number;
  height?: number;
}) {
  return (
    <div className="td-desk">
      <img src={src} alt={alt} width={width} height={height} />
    </div>
  );
}
