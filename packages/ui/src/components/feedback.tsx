import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useLocale } from "../i18n.js";
import { Icon, type IconName } from "../icons.js";
import { cx, formatDate, useCopyToClipboard } from "../utils.js";
import { Badge } from "./data.js";

/* ---------------------------------------------------------------- tabs */

export interface Tab {
  id: string;
  label: string;
  content?: ReactNode;
  disabled?: boolean;
}

export function Tabs({
  tabs,
  value,
  defaultValue,
  onChange,
  label,
}: {
  tabs: Tab[];
  value?: string;
  defaultValue?: string;
  onChange?: (id: string) => void;
  label: string;
}) {
  const base = useId();
  const [internal, setInternal] = useState(defaultValue ?? tabs[0]?.id);
  const current = value ?? internal;
  const activeIndex = tabs.findIndex((tab) => tab.id === current);
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const select = (id: string) => {
    if (value === undefined) setInternal(id);
    onChange?.(id);
  };

  return (
    <div className="td-tabs">
      <div className="td-tabs__list" role="tablist" aria-label={label}>
        {tabs.map((tab, index) => (
          <button
            key={tab.id}
            ref={(node) => {
              refs.current[index] = node;
            }}
            type="button"
            role="tab"
            id={`${base}-tab-${tab.id}`}
            aria-selected={tab.id === current}
            aria-controls={`${base}-panel-${tab.id}`}
            tabIndex={tab.id === current ? 0 : -1}
            disabled={tab.disabled}
            className={cx("td-tabs__tab", tab.id === current && "td-tabs__tab--on")}
            onClick={() => select(tab.id)}
            onKeyDown={(event) => {
              let next = activeIndex;
              if (event.key === "ArrowRight") next = (activeIndex + 1) % tabs.length;
              else if (event.key === "ArrowLeft") next = (activeIndex - 1 + tabs.length) % tabs.length;
              else if (event.key === "Home") next = 0;
              else if (event.key === "End") next = tabs.length - 1;
              else return;
              event.preventDefault();
              const target = tabs[next];
              if (target && !target.disabled) {
                select(target.id);
                refs.current[next]?.focus();
              }
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {tabs.map((tab) =>
        tab.id === current ? (
          <div
            key={tab.id}
            role="tabpanel"
            id={`${base}-panel-${tab.id}`}
            aria-labelledby={`${base}-tab-${tab.id}`}
            tabIndex={0}
            className="td-tabs__panel"
          >
            {tab.content}
          </div>
        ) : null,
      )}
    </div>
  );
}

/* --------------------------------------------------------------- toast */

type ToastTone = "info" | "success" | "warning" | "error";

interface ToastItem {
  id: number;
  tone: ToastTone;
  message: string;
  action?: { label: string; onClick: () => void };
}

const ToastContext = createContext<{ push: (toast: Omit<ToastItem, "id">) => void }>({ push: () => undefined });

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const counter = useRef(0);

  const dismiss = useCallback((id: number) => setToasts((items) => items.filter((item) => item.id !== id)), []);

  const push = useCallback(
    (toast: Omit<ToastItem, "id">) => {
      counter.current += 1;
      const id = counter.current;
      setToasts((items) => [...items.slice(-2), { ...toast, id }]);
      if (toast.tone !== "error" && !toast.action) {
        setTimeout(() => dismiss(id), 5000);
      }
    },
    [dismiss],
  );

  const value = useMemo(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="td-toasts" aria-live="polite" aria-atomic="false">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={cx("td-toast", `td-toast--${toast.tone}`)}
            role={toast.tone === "error" ? "alert" : "status"}
          >
            <Icon
              name={
                toast.tone === "success"
                  ? "check-circle"
                  : toast.tone === "error"
                    ? "x-octagon"
                    : toast.tone === "warning"
                      ? "alert-triangle"
                      : "info"
              }
              size={18}
            />
            <p>{toast.message}</p>
            {toast.action ? (
              <button type="button" className="td-btn td-btn--tertiary td-btn--sm" onClick={toast.action.onClick}>
                {toast.action.label}
              </button>
            ) : null}
            <button
              type="button"
              className="td-icon-btn td-icon-btn--sm"
              aria-label="Dismiss"
              onClick={() => dismiss(toast.id)}
            >
              <Icon name="close" size={16} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}

/* -------------------------------------------------------------- dialog */

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children?: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg" | "full";
  destructive?: boolean;
}

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
  destructive = false,
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const { t } = useLocale();

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (open && !node.open) node.showModal();
    if (!open && node.open) node.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={cx("td-dialog", `td-dialog--${size}`)}
      // React propagates `cancel`/`close` through the component tree, so a dialog nested inside
      // another (a confirm inside an account popup) must not close its parent.
      onCancel={(event) => {
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        onClose();
      }}
      onClose={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onMouseDown={(event) => {
        if (event.target === ref.current) onClose();
      }}
    >
      <div className="td-dialog__body">
        <div className="td-dialog__head">
          <h2 className="td-dialog__title">{title}</h2>
          <button type="button" className="td-icon-btn" aria-label={t("common.close")} onClick={onClose}>
            <Icon name="close" size={18} />
          </button>
        </div>
        {description ? <p className="td-dialog__description">{description}</p> : null}
        <div className="td-dialog__content">{children}</div>
        {footer ? (
          <div className={cx("td-dialog__footer", destructive && "td-dialog__footer--destructive")}>{footer}</div>
        ) : null}
      </div>
    </dialog>
  );
}

/* -------------------------------------------------------------- drawer */

export function Drawer({
  open,
  onClose,
  title,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const { t } = useLocale();
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (open && !node.open) node.showModal();
    if (!open && node.open) node.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="td-drawer"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={onClose}
    >
      <div className="td-drawer__body">
        <div className="td-dialog__head">
          <h2 className="td-dialog__title">{title}</h2>
          <button type="button" className="td-icon-btn" aria-label={t("common.close")} onClick={onClose}>
            <Icon name="close" size={18} />
          </button>
        </div>
        <div className="td-drawer__content">{children}</div>
        {footer ? <div className="td-dialog__footer">{footer}</div> : null}
      </div>
    </dialog>
  );
}

/* -------------------------------------------------------- inline notice */

export function InlineNotice({
  tone = "info",
  title,
  children,
  action,
}: {
  tone?: "info" | "success" | "warning" | "danger";
  title?: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  const icon: IconName =
    tone === "success"
      ? "check-circle"
      : tone === "warning"
        ? "alert-triangle"
        : tone === "danger"
          ? "x-octagon"
          : "info";
  return (
    <div className={cx("td-notice", `td-notice--${tone}`)} role={tone === "danger" ? "alert" : "status"}>
      <Icon name={icon} size={18} />
      <div className="td-notice__content">
        {title ? <p className="td-notice__title">{title}</p> : null}
        <div className="td-notice__body">{children}</div>
      </div>
      {action ? <div className="td-notice__action">{action}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------- consent banner */

export function ConsentBanner({
  onAccept,
  onReject,
  onSettings,
  inline = false,
}: {
  onAccept?: () => void;
  onReject?: () => void;
  onSettings?: () => void;
  inline?: boolean;
}) {
  const { t } = useLocale();
  const [visible, setVisible] = useState(true);
  if (!visible) return null;
  return (
    <div className={cx("td-consent", inline && "td-consent--inline")} role="region" aria-label={t("consent.title")}>
      <div className="td-consent__copy">
        <strong>{t("consent.title")}</strong>
        <p>{t("consent.body")}</p>
      </div>
      <div className="td-consent__actions">
        <button
          type="button"
          className="td-btn td-btn--secondary td-btn--md"
          onClick={() => {
            setVisible(false);
            onReject?.();
          }}
        >
          {t("consent.reject")}
        </button>
        <button
          type="button"
          className="td-btn td-btn--secondary td-btn--md"
          onClick={() => {
            setVisible(false);
            onAccept?.();
          }}
        >
          {t("consent.accept")}
        </button>
        <button type="button" className="td-btn td-btn--tertiary td-btn--md" onClick={onSettings}>
          {t("consent.settings")}
        </button>
      </div>
    </div>
  );
}

/* --------------------------------------------------------- API key dialogs */

export function ApiKeyDialog({
  open,
  onClose,
  apiKey,
  keyName,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  apiKey: string;
  keyName: string;
  onDone?: () => void;
}) {
  const { t } = useLocale();
  const { copy, state } = useCopyToClipboard();
  const [stored, setStored] = useState(false);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t("key.revealTitle")}
      description={t("key.revealOnce")}
      size="md"
      footer={
        <>
          <button type="button" className="td-btn td-btn--secondary td-btn--md" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="td-btn td-btn--primary td-btn--md"
            disabled={!stored}
            onClick={() => {
              onDone?.();
              onClose();
            }}
          >
            {t("common.continue")}
          </button>
        </>
      }
    >
      <p className="td-keydialog__name">{keyName}</p>
      <div className="td-keydialog__key">
        <code>{apiKey}</code>
        <button type="button" className="td-btn td-btn--secondary td-btn--sm" onClick={() => copy(apiKey)}>
          <Icon name={state === "copied" ? "check" : "copy"} size={14} />
          {state === "copied" ? t("common.copied") : t("key.copy")}
        </button>
      </div>
      <p className="td-field__hint">
        <Icon name="alert-triangle" size={14} /> {t("key.neverBrowser")}
      </p>
      <label className="td-choice" style={{ marginTop: "var(--td-space-4)" }}>
        <input
          type="checkbox"
          className="td-choice__input"
          checked={stored}
          onChange={(event) => setStored(event.target.checked)}
        />
        <span className="td-choice__label">
          <span className="td-choice__box" aria-hidden="true">
            <Icon name="check" size={12} />
          </span>
          {t("key.stored")}
        </span>
      </label>
      <span className="td-visually-hidden" aria-live="polite">
        {state === "copied" ? t("common.copied") : ""}
      </span>
    </Dialog>
  );
}

export function ApiKeyRevokeDialog({
  open,
  onClose,
  name,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  name: string;
  onConfirm: () => void;
}) {
  const { t } = useLocale();
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t("key.revokeTitle")}
      description={t("key.revokeBody", { name })}
      size="sm"
      destructive
      footer={
        <>
          <button type="button" className="td-btn td-btn--secondary td-btn--md" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="td-btn td-btn--danger td-btn--md"
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            {t("common.revoke")}
          </button>
        </>
      }
    />
  );
}

/* ------------------------------------------------------- share link card */

export interface ShareLinkCardProps {
  url: string;
  expiresAt: string;
  accessUntil: string;
  outputKeptUntil: string;
  inputDeletedAt: string;
  revoked?: boolean;
  expired?: boolean;
  expiryHours?: number;
  onExpiryChange?: (hours: number) => void;
  onRevoke?: () => void;
  maxExpiryHours?: number;
}

export function ShareLinkCard({
  url,
  expiresAt,
  accessUntil,
  outputKeptUntil,
  inputDeletedAt,
  revoked,
  expired,
  expiryHours = 168,
  onExpiryChange,
  onRevoke,
  maxExpiryHours = 720,
}: ShareLinkCardProps) {
  const { t, locale } = useLocale();
  const { copy, state } = useCopyToClipboard();
  const options = [
    { value: "1", label: t("share.expiry1h"), hours: 1 },
    { value: "24", label: t("share.expiry24h"), hours: 24 },
    { value: "168", label: t("share.expiry7d"), hours: 168 },
    { value: "720", label: t("share.expiry30d"), hours: 720 },
  ];
  return (
    <section className="td-sharecard">
      <div className="td-sharecard__head">
        <h3>{t("share.title")}</h3>
        <Badge tone={revoked ? "danger" : expired ? "warning" : "success"}>
          {revoked ? t("share.revoked") : expired ? t("share.expired") : t("badge.active")}
        </Badge>
      </div>
      {!revoked && !expired ? (
        <>
          <div className="td-sharecard__expiry">
            <span className="td-sharecard__expiry-label">
              {t("share.expires", { days: Math.round(expiryHours / 24), date: formatDate(expiresAt, locale) })}
            </span>
            <div className="td-segmented__track" role="radiogroup" aria-label={t("share.title")}>
              {options.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={expiryHours === option.hours}
                  disabled={option.hours > maxExpiryHours}
                  className={cx("td-segmented__item", expiryHours === option.hours && "td-segmented__item--on")}
                  onClick={() => onExpiryChange?.(option.hours)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
          <div className="td-sharecard__url">
            <input
              className="td-input"
              readOnly
              value={url}
              aria-label={t("share.link")}
              onFocus={(event) => event.currentTarget.select()}
            />
            <button type="button" className="td-btn td-btn--secondary td-btn--md" onClick={() => copy(url)}>
              <Icon name={state === "copied" ? "check" : "copy"} size={14} />
              {state === "copied" ? t("common.copied") : t("common.copy")}
            </button>
          </div>
          <p className="td-sharecard__notice">
            <Icon name="info" size={14} /> {t("share.notice", { date: formatDate(expiresAt, locale) })}
          </p>
          <dl className="td-sharecard__timeline">
            <div>
              <dt>{t("share.accessUntil")}</dt>
              <dd>{accessUntil}</dd>
            </div>
            <div>
              <dt>{t("share.outputKeptUntil")}</dt>
              <dd>{outputKeptUntil}</dd>
            </div>
            <div>
              <dt>{t("share.inputDeletedAt")}</dt>
              <dd>{inputDeletedAt}</dd>
            </div>
          </dl>
        </>
      ) : (
        <p className="td-sharecard__unavailable">
          <Icon name="lock" size={16} /> {t("share.unavailableTitle")} — {t("share.unavailableBody")}
        </p>
      )}
      {onRevoke && !revoked && !expired ? (
        <button type="button" className="td-btn td-btn--danger-outline td-btn--sm" onClick={onRevoke}>
          {t("share.revoke")}
        </button>
      ) : null}
    </section>
  );
}

/* -------------------------------------------------------------- ad slot */

export type AdSize = "leaderboard" | "mobile" | "sidebar" | "inline";

export function AdSlot({
  size = "leaderboard",
  enabled = true,
  house = true,
  href = "https://zerohostcms.com",
  children,
}: {
  size?: AdSize;
  enabled?: boolean;
  house?: boolean;
  href?: string;
  children?: ReactNode;
}) {
  const { t, locale } = useLocale();
  if (!enabled) return null;
  const label = locale === "vi" ? t("advertisementVi") : t("advertisement");
  return (
    <aside className={cx("td-ad", `td-ad--${size}`)} aria-label={label}>
      <span className="td-ad__label">{label}</span>
      <div className="td-ad__box">
        {children ?? (
          <a className="td-ad__house" href={href}>
            <span className="td-ad__house-title">ZeroHostCMS</span>
            <span className="td-ad__house-body">{house ? "Build your own tools site" : "Ad space"}</span>
          </a>
        )}
      </div>
    </aside>
  );
}
