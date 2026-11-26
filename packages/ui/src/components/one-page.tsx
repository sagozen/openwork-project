import { type ReactNode, useEffect, useRef, useState } from "react";
import { type Locale, useLocale } from "../i18n.js";
import { Icon } from "../icons.js";
import { Dialog, InlineNotice } from "./feedback.js";
import { LanguageSwitcher } from "./forms.js";
import { PricingPack } from "./marketing.js";

export type AccountItem = "wallet" | "api" | "settings";

/** An app-specific account menu entry shown above the shared ones. */
export interface AccountMenuEntry<K extends string = string> {
  key: K;
  label: string;
}

export interface SiteBarProps<K extends string = AccountItem> {
  locale: Locale;
  /** Brand mark: letters inside the seal and the word next to it. */
  brand: { seal: string; name: string };
  /** `GET` endpoint that sets the locale cookie and returns to the current page. */
  localeHref: (locale: Locale) => string;
  signedIn: boolean;
  /** Rendered between the nav and the account control, usually a `QuotaBadge`. */
  quota?: ReactNode;
  email?: string;
  onSignIn?: () => void;
  onAccount?: (item: K | AccountItem) => void;
  /** Entries listed before wallet, API and settings. */
  accountItems?: AccountMenuEntry<K>[];
  docsHref?: string;
}

export function SiteBar<K extends string = AccountItem>({
  locale,
  brand,
  localeHref,
  signedIn,
  quota,
  email,
  onSignIn,
  onAccount,
  accountItems,
  docsHref = "/docs",
}: SiteBarProps<K>) {
  const { t } = useLocale();
  return (
    <header className="td-header">
      <div className="td-header__inner">
        <a className="td-logo" href="/">
          <span className="td-logo__seal" aria-hidden="true">
            {brand.seal}
          </span>
          <span className="td-logo__word">{brand.name}</span>
          <span className="td-visually-hidden">home</span>
        </a>
        <nav className="td-header__nav" aria-label={t("nav.primary")}>
          <a className="td-header__link" href={docsHref}>
            {t("nav.docs")}
          </a>
        </nav>
        <div className="td-header__actions">
          <LanguageSwitcher current={locale} getHref={localeHref} />
          {quota}
          {signedIn ? (
            <AccountMenu email={email} extraItems={accountItems} onSelect={(item) => onAccount?.(item)} />
          ) : (
            <button type="button" className="td-btn td-btn--primary td-btn--sm" onClick={onSignIn}>
              {t("nav.signIn")}
            </button>
          )}
        </div>
      </div>
    </header>
  );
}

export function AccountMenu<K extends string = AccountItem>({
  email,
  extraItems = [],
  onSelect,
}: {
  email?: string;
  extraItems?: AccountMenuEntry<K>[];
  onSelect: (item: K | AccountItem) => void;
}) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  const items: AccountMenuEntry<K | AccountItem>[] = [
    ...extraItems,
    { key: "wallet", label: t("onepage.wallet") },
    { key: "api", label: t("onepage.apiWebhooks") },
    { key: "settings", label: t("onepage.settings") },
  ];

  return (
    <div className="td-lang td-account" ref={root} onKeyDown={(event) => event.key === "Escape" && setOpen(false)}>
      <button
        type="button"
        className="td-lang__trigger"
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={t("onepage.account")}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="td-account__avatar" aria-hidden="true">
          {(email ?? "?").slice(0, 1).toUpperCase()}
        </span>
        <Icon name="chevron-down" size={14} />
      </button>
      {open ? (
        <ul className="td-menu" role="menu" aria-label={t("onepage.account")}>
          {email ? (
            <li role="none" className="td-menu__label">
              {email}
            </li>
          ) : null}
          {items.map((item) => (
            <li key={item.key} role="none">
              <button
                type="button"
                role="menuitem"
                className="td-menu__item"
                onClick={() => {
                  setOpen(false);
                  onSelect(item.key);
                }}
              >
                {item.label}
              </button>
            </li>
          ))}
          <li role="none">
            <button
              type="button"
              role="menuitem"
              className="td-menu__item"
              onClick={async () => {
                await fetch("/api/auth/sign-out", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: "{}",
                }).catch(() => undefined);
                window.location.assign("/");
              }}
            >
              {t("onepage.signOut")}
            </button>
          </li>
        </ul>
      ) : null}
    </div>
  );
}

export interface QuotaBadgeProps {
  /** Spendable credits right now. */
  credits: number;
  /** Product hint beside the number, e.g. "≈ 12 pages" or "≈ 40 min". */
  hint?: string;
  onTopUp: () => void;
}

/** Presentational only: the page fetches the balance and passes it in. */
export function QuotaBadge({ credits, hint, onTopUp }: QuotaBadgeProps) {
  const { t, locale } = useLocale();
  const count = new Intl.NumberFormat(locale === "vi" ? "vi-VN" : "en-US").format(credits);
  return (
    <div className="td-quota" role="status">
      <span className="td-quota__count">{t("billing.creditsCount", { count })}</span>
      {hint ? <span className="td-quota__hint">{hint}</span> : null}
      <button type="button" className="td-btn td-btn--secondary td-btn--sm" onClick={onTopUp}>
        {t("credit.topUp")}
      </button>
    </div>
  );
}

export interface TopupPack {
  id: string;
  name: string;
  credits: number;
  price: string;
  perUnit: string;
  featured?: boolean;
}

export interface TopupDialogProps {
  open: boolean;
  onClose: () => void;
  packs: TopupPack[];
  csrfToken: string;
  signedIn: boolean;
  onSignIn?: () => void;
  /** Show the "checkout cancelled" notice after a return from the provider. */
  cancelled?: boolean;
  termsHref?: string;
  refundsHref?: string;
}

/** Packs popup. Posts to the checkout endpoint with one idempotency key per open. */
export function TopupDialog({
  open,
  onClose,
  packs,
  csrfToken,
  signedIn,
  onSignIn,
  cancelled = false,
  termsHref = "/legal#terms",
  refundsHref = "/legal#refunds",
}: TopupDialogProps) {
  const { t } = useLocale();
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const key = useRef<string>(crypto.randomUUID());

  async function buy(packId: string) {
    if (!signedIn) {
      onClose();
      onSignIn?.();
      return;
    }
    if (busy) return;
    setBusy(packId);
    setFailed(false);
    try {
      const response = await fetch("/api/v1/checkout-sessions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": csrfToken,
          "idempotency-key": `${key.current}:${packId}`,
        },
        body: JSON.stringify({ pack_id: packId }),
      });
      if (response.status === 201) {
        const body = (await response.json()) as { url?: string };
        if (body.url) {
          window.location.assign(body.url);
          return;
        }
      }
      setFailed(true);
    } catch {
      setFailed(true);
    }
    setBusy(null);
  }

  return (
    <Dialog open={open} onClose={onClose} title={t("onepage.topupTitle")} size="lg">
      {cancelled ? <InlineNotice tone="info">{t("onepage.cancelled")}</InlineNotice> : null}
      {failed ? <InlineNotice tone="danger">{t("onepage.payError")}</InlineNotice> : null}
      <div className="td-topup" aria-busy={busy !== null}>
        {packs.map((pack) => (
          <PricingPack
            key={pack.id}
            name={pack.name}
            credits={pack.credits}
            price={pack.price}
            perPage={pack.perUnit}
            featured={pack.featured}
            loading={busy === pack.id}
            disabled={busy !== null && busy !== pack.id}
            onSelect={() => void buy(pack.id)}
          />
        ))}
      </div>
      <p className="td-topup__legal">
        {t("onepage.agreePrefix")}
        <a href={termsHref}>{t("onepage.terms")}</a>
        {t("onepage.agreeAnd")}
        <a href={refundsHref}>{t("onepage.refunds")}</a>
        {t("onepage.agreeSuffix")}
      </p>
    </Dialog>
  );
}

export interface SiteFooterProps {
  contactEmail: string;
  /** One line under the links, e.g. "a SAGOZEN Labs product". */
  byline?: string;
}

export function SiteFooter({ contactEmail, byline }: SiteFooterProps) {
  const { t } = useLocale();
  return (
    <footer className="td-footer td-onepage-footer">
      <nav aria-label="Footer">
        <a href="/docs">{t("nav.docs")}</a>
        <a href="/legal">{t("onepage.legal")}</a>
        <a href={`mailto:${contactEmail}`}>{t("onepage.contact")}</a>
      </nav>
      {byline ? <p>{byline}</p> : null}
    </footer>
  );
}
