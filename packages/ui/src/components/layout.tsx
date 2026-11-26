import { type ReactNode, useState } from "react";
import { type Locale, useLocale } from "../i18n.js";
import { Icon, type IconName } from "../icons.js";
import { cx } from "../utils.js";
import { LinkButton } from "./actions.js";
import { CreditMeter } from "./data.js";
import { LanguageSwitcher, type ThemeChoice, ThemeSwitcher } from "./forms.js";

/* -------------------------------------------------------------- header */

export interface HeaderProps {
  locale: Locale;
  onLocaleChange?: (locale: Locale) => void;
  getLocaleHref?: (locale: Locale) => string;
  currentPath?: string;
  signedIn?: boolean;
  credits?: number;
  onThemeChange?: (theme: ThemeChoice) => void;
  /** Serializable locale URLs for Astro islands (functions cannot cross the client boundary). */
  localeHrefs?: { en: string; vi: string };
}

const publicLinks: Array<{ key: Parameters<ReturnType<typeof useLocale>["t"]>[0]; href: string }> = [
  { key: "nav.templates", href: "/templates/" },
  { key: "library.certificates", href: "/templates/certificates/" },
  { key: "nav.api", href: "/docs/api/" },
  { key: "nav.pricing", href: "/pricing/" },
];

export function Header({
  locale,
  onLocaleChange,
  getLocaleHref,
  localeHrefs,
  currentPath = "/",
  signedIn,
  credits,
}: HeaderProps) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  return (
    <header className="td-header">
      <div className="td-header__inner">
        <a
          className="td-logo"
          href={getLocaleHref ? getLocaleHref(locale) : (localeHrefs?.[locale === "pseudo" ? "en" : locale] ?? "/")}
        >
          <span className="td-logo__seal" aria-hidden="true">
            TD
          </span>
          <span className="td-logo__word">TemplateDesign</span>
          <span className="td-visually-hidden">home</span>
        </a>
        <nav className="td-header__nav" aria-label={t("nav.primary")}>
          {publicLinks.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className={cx("td-header__link", currentPath.startsWith(link.href) && "is-current")}
            >
              {t(link.key)}
            </a>
          ))}
        </nav>
        <div className="td-header__actions">
          <ThemeSwitcher />
          <LanguageSwitcher
            current={locale}
            onChange={onLocaleChange}
            getHref={
              getLocaleHref ?? (localeHrefs ? (value) => localeHrefs[value === "pseudo" ? "en" : value] : undefined)
            }
          />
          {typeof credits === "number" ? (
            <a className="td-header__credit" href="/app/credits">
              <Icon name="credit-card" size={16} /> {t("credit.available", { count: credits })}
            </a>
          ) : null}
          {signedIn ? (
            <LinkButton href="/app" variant="secondary" size="sm">
              {t("nav.dashboard")}
            </LinkButton>
          ) : (
            <>
              <LinkButton href="/auth/sign-in" variant="tertiary" size="sm">
                {t("nav.signIn")}
              </LinkButton>
              <LinkButton href="/templates/certificates/" variant="primary" size="sm">
                {t("proto.home.primary")}
              </LinkButton>
            </>
          )}
          <button
            type="button"
            className="td-icon-btn td-header__menu"
            aria-label={open ? t("nav.closeMenu") : t("nav.openMenu")}
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            <Icon name={open ? "close" : "menu"} size={20} />
          </button>
        </div>
      </div>
      {open ? (
        <nav className="td-header__mobile" aria-label={t("nav.primary")}>
          {publicLinks.map((link) => (
            <a key={link.href} href={link.href} className="td-header__mobile-link" onClick={() => setOpen(false)}>
              {t(link.key)}
            </a>
          ))}
          <a href="/auth/sign-in" className="td-header__mobile-link" onClick={() => setOpen(false)}>
            {t("nav.signIn")}
          </a>
        </nav>
      ) : null}
    </header>
  );
}

/* -------------------------------------------------------------- footer */

const footerColumns: Array<{
  title: Parameters<ReturnType<typeof useLocale>["t"]>[0];
  links: Array<{ key: Parameters<ReturnType<typeof useLocale>["t"]>[0]; href: string }>;
}> = [
  {
    title: "footer.product",
    links: [
      { key: "nav.templates", href: "/templates/" },
      { key: "nav.pricing", href: "/pricing/" },
      { key: "footer.limits", href: "/docs/limits/" },
    ],
  },
  {
    title: "footer.developers",
    links: [
      { key: "nav.docs", href: "/docs/" },
      { key: "nav.api", href: "/docs/api/" },
    ],
  },
  {
    title: "footer.legal",
    links: [
      { key: "footer.privacy", href: "/legal/privacy/" },
      { key: "footer.terms", href: "/legal/terms/" },
    ],
  },
];

export function Footer({ locale, onLocaleChange }: { locale: Locale; onLocaleChange?: (locale: Locale) => void }) {
  const { t } = useLocale();
  return (
    <footer className="td-footer">
      <div className="td-footer__inner">
        <div className="td-footer__brand">
          <a className="td-logo" href="/">
            <span className="td-logo__seal" aria-hidden="true">
              TD
            </span>
            <span className="td-logo__word">TemplateDesign</span>
          </a>
          <p>{t("footer.zhcms")}</p>
          <a className="td-footer__zhcms" href="https://zerohostcms.com">
            ZeroHostCMS <Icon name="arrow-right" size={14} />
          </a>
        </div>
        {footerColumns.map((column) => (
          <nav key={column.title} className="td-footer__col" aria-label={t(column.title)}>
            <h2>{t(column.title)}</h2>
            {column.links.map((link) => (
              <a key={link.href} href={link.href}>
                {t(link.key)}
              </a>
            ))}
          </nav>
        ))}
        <div className="td-footer__col">
          <h2>{t("common.language")}</h2>
          <LanguageSwitcher current={locale} onChange={onLocaleChange} />
          <ThemeSwitcher />
        </div>
      </div>
      <div className="td-footer__base">
        <span>{t("footer.copyright", { year: new Date().getFullYear() })}</span>
        <span>{t("credit.noSubscription")}</span>
      </div>
    </footer>
  );
}

/* ---------------------------------------------------------- breadcrumbs */

export function Breadcrumbs({ items }: { items: Array<{ label: string; href?: string }> }) {
  return (
    <nav className="td-breadcrumbs" aria-label="Breadcrumb">
      <ol>
        {items.map((item, index) => (
          <li key={`${item.label}-${index}`}>
            {item.href ? <a href={item.href}>{item.label}</a> : <span aria-current="page">{item.label}</span>}
            {index < items.length - 1 ? <Icon name="chevron-right" size={12} /> : null}
          </li>
        ))}
      </ol>
    </nav>
  );
}

/* ------------------------------------------------------------ page header */

export function PageHeader({
  title,
  description,
  actions,
  badge,
  headingLevel = 1,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  badge?: ReactNode;
  headingLevel?: 1 | 2;
}) {
  const Heading = headingLevel === 2 ? "h2" : "h1";
  return (
    <div className="td-pageheader">
      <div>
        <div className="td-pageheader__title-row">
          <Heading>{title}</Heading>
          {badge}
        </div>
        {description ? <p>{description}</p> : null}
      </div>
      {actions ? <div className="td-pageheader__actions">{actions}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------- app shell */

export interface AppNavItem {
  key: string;
  label: string;
  href: string;
  icon: IconName;
}

export function AppShell({
  children,
  nav,
  currentPath,
  credits,
  locale,
  onLocaleChange,
  accountName = "Lan",
  admin = false,
  brandName = "TemplateDesign",
  brandMark = "TD",
  homeHref = "/app",
}: {
  children: ReactNode;
  nav: AppNavItem[];
  currentPath: string;
  credits: number;
  locale: Locale;
  onLocaleChange?: (locale: Locale) => void;
  accountName?: string;
  admin?: boolean;
  /** Product wordmark. Defaults keep templatedesign's header unchanged. */
  brandName?: string;
  brandMark?: string;
  homeHref?: string;
}) {
  const { t } = useLocale();
  return (
    <div className={cx("td-app", admin && "td-app--admin")}>
      <aside className="td-app__nav" aria-label={t("nav.primary")}>
        <a className="td-logo" href={homeHref}>
          <span className="td-logo__seal" aria-hidden="true">
            {brandMark}
          </span>
          <span className="td-logo__word">{admin ? t("nav.admin") : brandName}</span>
        </a>
        <nav>
          {nav.map((item) => (
            <a
              key={item.href}
              href={item.href}
              className={cx("td-app__link", currentPath === item.href && "is-current")}
              aria-current={currentPath === item.href ? "page" : undefined}
            >
              <Icon name={item.icon} size={18} />
              {item.label}
            </a>
          ))}
        </nav>
        <div className="td-app__navfooter">
          <ThemeSwitcher />
          <LanguageSwitcher current={locale} onChange={onLocaleChange} />
        </div>
      </aside>
      <div className="td-app__main">
        <header className="td-app__topbar">
          <div className="td-app__account">
            <span className="td-avatar" aria-hidden="true">
              {accountName.slice(0, 1)}
            </span>
            <span>{accountName}</span>
          </div>
          <div className="td-app__topbar-actions">
            <CreditMeter available={credits} />
            <LinkButton href="/app/credits" variant="secondary" size="sm">
              {t("credit.topUp")}
            </LinkButton>
          </div>
        </header>
        <main id="app-main" className="td-app__content">
          {children}
        </main>
      </div>
    </div>
  );
}
