import {
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { type Locale, useLocale } from "../i18n.js";
import { Icon, type IconName } from "../icons.js";
import { cx, useControllableState } from "../utils.js";

/* --------------------------------------------------------------- field */

export interface FieldRenderProps {
  id: string;
  describedBy: string | undefined;
  invalid: boolean;
  required: boolean;
}

export interface FieldProps {
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  optionalLabel?: string;
  children: (props: FieldRenderProps) => ReactNode;
  className?: string;
  id?: string;
}

export function Field({ label, hint, error, required = false, optionalLabel, children, className, id }: FieldProps) {
  const { t } = useLocale();
  const generated = useId();
  const fieldId = id ?? `td-field-${generated.replaceAll(":", "")}`;
  const hintId = hint ? `${fieldId}-hint` : undefined;
  const errorId = error ? `${fieldId}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <div className={cx("td-field", error && "td-field--invalid", className)}>
      <label className="td-field__label" htmlFor={fieldId}>
        {label}
        {required ? (
          <span className="td-field__required"> ({t("common.required")})</span>
        ) : optionalLabel ? (
          <span className="td-field__optional"> ({optionalLabel})</span>
        ) : null}
      </label>
      {children({ id: fieldId, describedBy, invalid: Boolean(error), required })}
      {hint && !error ? (
        <p className="td-field__hint" id={hintId}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p className="td-field__error" id={errorId}>
          <Icon name="alert-triangle" size={14} />
          {error}
        </p>
      ) : null}
    </div>
  );
}

/* --------------------------------------------------------------- inputs */

export interface TextInputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
  iconLeft?: IconName;
  suffix?: ReactNode;
  inputSize?: "sm" | "md";
}

export function TextInput({
  invalid,
  iconLeft,
  suffix,
  inputSize = "md",
  describedBy,
  className,
  ...props
}: TextInputProps & { describedBy?: string }) {
  return (
    <div className={cx("td-input-wrap", invalid && "td-input-wrap--invalid", className)}>
      {iconLeft ? <Icon name={iconLeft} size={16} className="td-input-wrap__icon" /> : null}
      <input
        className={cx("td-input", iconLeft && "td-input--with-icon", `td-input--${inputSize}`)}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        {...props}
      />
      {suffix ? <span className="td-input-wrap__suffix">{suffix}</span> : null}
    </div>
  );
}

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
}

export function Textarea({
  invalid,
  describedBy,
  className,
  rows = 4,
  ...props
}: TextareaProps & { describedBy?: string }) {
  return (
    <textarea
      className={cx("td-textarea", invalid && "td-textarea--invalid", className)}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      rows={rows}
      {...props}
    />
  );
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  invalid?: boolean;
  options?: Array<{ value: string; label: string; disabled?: boolean }>;
}

export function Select({
  invalid,
  options,
  describedBy,
  children,
  className,
  ...props
}: SelectProps & { describedBy?: string }) {
  return (
    <div className={cx("td-select-wrap", invalid && "td-select-wrap--invalid", className)}>
      <select className="td-select" aria-invalid={invalid || undefined} aria-describedby={describedBy} {...props}>
        {options?.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
        {children}
      </select>
      <Icon name="chevron-down" size={16} className="td-select-wrap__chevron" />
    </div>
  );
}

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label: ReactNode;
  description?: string;
  indeterminate?: boolean;
}

export function Checkbox({ label, description, indeterminate = false, className, id, ...props }: CheckboxProps) {
  const generated = useId();
  const inputId = id ?? `td-check-${generated.replaceAll(":", "")}`;
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <div className={cx("td-choice", className)}>
      <input ref={ref} type="checkbox" id={inputId} className="td-choice__input" {...props} />
      <label htmlFor={inputId} className="td-choice__label">
        <span className="td-choice__box" aria-hidden="true">
          <Icon name="check" size={12} />
        </span>
        <span>
          {label}
          {description ? <span className="td-choice__description">{description}</span> : null}
        </span>
      </label>
    </div>
  );
}

export interface RadioOption {
  value: string;
  label: string;
  description?: string;
}

export interface RadioGroupProps {
  legend: string;
  name: string;
  options: RadioOption[];
  value?: string;
  onChange?: (value: string) => void;
  hint?: string;
}

export function RadioGroup({ legend, name, options, value, onChange, hint }: RadioGroupProps) {
  const [current, setCurrent] = useControllableState(value, options[0]?.value ?? "", onChange);
  const hintId = hint ? `${name}-hint` : undefined;
  return (
    <fieldset className="td-fieldset" aria-describedby={hintId}>
      <legend className="td-field__label">{legend}</legend>
      <div className="td-radio-group">
        {options.map((option) => (
          <div className="td-choice" key={option.value}>
            <input
              type="radio"
              id={`${name}-${option.value}`}
              name={name}
              value={option.value}
              className="td-choice__input td-choice__input--radio"
              checked={current === option.value}
              onChange={() => setCurrent(option.value)}
            />
            <label htmlFor={`${name}-${option.value}`} className="td-choice__label">
              <span className="td-choice__box td-choice__box--radio" aria-hidden="true" />
              <span>
                {option.label}
                {option.description ? <span className="td-choice__description">{option.description}</span> : null}
              </span>
            </label>
          </div>
        ))}
      </div>
      {hint ? (
        <p className="td-field__hint" id={hintId}>
          {hint}
        </p>
      ) : null}
    </fieldset>
  );
}

export interface ToggleProps {
  label: string;
  description?: string;
  checked?: boolean;
  defaultChecked?: boolean;
  onChange?: (checked: boolean) => void;
  disabled?: boolean;
}

export function Toggle({ label, description, checked, defaultChecked = false, onChange, disabled }: ToggleProps) {
  const [value, setValue] = useControllableState(checked, defaultChecked, onChange);
  const id = `td-toggle-${useId().replaceAll(":", "")}`;
  return (
    <div className="td-toggle-row">
      <div>
        <label htmlFor={id} className="td-toggle-row__label">
          {label}
        </label>
        {description ? <p className="td-toggle-row__description">{description}</p> : null}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={value}
        disabled={disabled}
        className={cx("td-toggle", value && "td-toggle--on")}
        onClick={() => setValue(!value)}
      >
        <span className="td-toggle__thumb" />
      </button>
    </div>
  );
}

export interface SegmentedOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SegmentedControlProps {
  label: string;
  options: SegmentedOption[];
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  hideLabel?: boolean;
}

export function SegmentedControl({
  label,
  options,
  value,
  defaultValue,
  onChange,
  hideLabel = false,
}: SegmentedControlProps) {
  const [current, setCurrent] = useControllableState(value, defaultValue ?? options[0]?.value ?? "", onChange);
  return (
    <div className="td-segmented" role="radiogroup" aria-label={hideLabel ? label : undefined}>
      {!hideLabel ? <span className="td-segmented__label">{label}</span> : null}
      <div className="td-segmented__track">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={current === option.value}
            disabled={option.disabled}
            className={cx("td-segmented__item", current === option.value && "td-segmented__item--on")}
            onClick={() => setCurrent(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------- file drop */

export interface FileDropZoneProps {
  accept?: string;
  maxBytes?: number;
  maxRows?: number;
  onFile?: (file: File) => void;
  file?: File | null;
  error?: string;
  uploadingPercent?: number;
}

export function FileDropZone({
  accept = ".csv,text/csv",
  maxBytes = 256 * 1024,
  maxRows = 100,
  onFile,
  file,
  error,
  uploadingPercent,
}: FileDropZoneProps) {
  const { t, locale } = useLocale();
  const [dragOver, setDragOver] = useState(false);
  const [localError, setLocalError] = useState<string>();
  const input = useRef<HTMLInputElement>(null);

  const acceptFile = (candidate: File | undefined) => {
    if (!candidate) return;
    setLocalError(undefined);
    if (candidate.size > maxBytes) {
      setLocalError(t("drop.tooLarge", { size: `${Math.round(maxBytes / 1024)} KiB` }));
      return;
    }
    const types = accept.split(",").map((value) => value.trim().toLowerCase());
    const name = candidate.name.toLowerCase();
    if (!types.some((type) => (type.startsWith(".") ? name.endsWith(type) : candidate.type === type))) {
      setLocalError(t("drop.wrongType"));
      return;
    }
    onFile?.(candidate);
  };

  const shownError = error ?? localError;

  return (
    <div
      className={cx(
        "td-drop",
        dragOver && "td-drop--over",
        shownError && "td-drop--invalid",
        file && "td-drop--filled",
      )}
      onDragOver={(event) => {
        event.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragOver(false);
        acceptFile(event.dataTransfer.files[0]);
      }}
    >
      <input
        ref={input}
        type="file"
        accept={accept}
        aria-label={t("common.browse")}
        className="td-visually-hidden"
        onChange={(event) => acceptFile(event.target.files?.[0])}
        tabIndex={-1}
      />
      {file ? (
        <div className="td-drop__file">
          <Icon name="file" size={20} />
          <div>
            <p className="td-drop__name">{file.name}</p>
            <p className="td-drop__meta">
              {(file.size / 1024).toFixed(1)} KiB · {accept.replaceAll(",", " · ")}
            </p>
          </div>
          <button type="button" className="td-btn td-btn--secondary td-btn--sm" onClick={() => input.current?.click()}>
            {t("drop.replace")}
          </button>
        </div>
      ) : (
        <>
          <Icon name="upload" size={24} className="td-drop__icon" />
          <p className="td-drop__title">{dragOver ? t("drop.dragOver") : t("drop.title")}</p>
          <p className="td-drop__hint">
            {t("drop.hint", { rows: maxRows, size: `${Math.round(maxBytes / 1024)} KiB` })}
          </p>
          <button type="button" className="td-btn td-btn--secondary td-btn--md" onClick={() => input.current?.click()}>
            {t("common.browse")}
          </button>
          <p className="td-drop__accepted">{t("drop.accepted", { types: accept.replaceAll(",", " · ") })}</p>
        </>
      )}
      {typeof uploadingPercent === "number" && uploadingPercent < 100 ? (
        <div
          className="td-drop__progress"
          role="progressbar"
          aria-label={t("drop.uploading", { percent: uploadingPercent })}
          aria-valuenow={uploadingPercent}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <span style={{ width: `${uploadingPercent}%` }} />
          <span className="td-visually-hidden">{t("drop.uploading", { percent: uploadingPercent })}</span>
        </div>
      ) : null}
      {shownError ? (
        <p className="td-field__error" role="alert">
          <Icon name="alert-triangle" size={14} />
          {shownError}
        </p>
      ) : null}
      <span className="td-visually-hidden" lang={locale}>
        {t("drop.title")}
      </span>
    </div>
  );
}

/* ---------------------------------------------------------- language */

export interface LanguageSwitcherProps {
  current: Locale;
  onChange?: (locale: Locale) => void;
  getHref?: (locale: Locale) => string;
  /** Development-only pseudo-locale entry for the component gallery. */
  showPseudo?: boolean;
}

export function LanguageSwitcher({ current, onChange, getHref, showPseudo = false }: LanguageSwitcherProps) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const items: Array<{ locale: Locale; label: string; short: string }> = [
    { locale: "en", label: t("common.english"), short: "EN" },
    { locale: "vi", label: t("common.vietnamese"), short: "VI" },
    ...(showPseudo ? [{ locale: "pseudo" as const, label: "Pseudo (test)", short: "PS" }] : []),
  ];
  const active = items.find((item) => item.locale === current) ?? items[0];

  return (
    <div className="td-lang" onKeyDown={(event) => event.key === "Escape" && setOpen(false)}>
      <button
        type="button"
        className="td-lang__trigger"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="globe" size={16} />
        <span>{active.short}</span>
        <Icon name="chevron-down" size={14} />
      </button>
      {open ? (
        <ul className="td-menu" role="menu" aria-label={t("common.language")}>
          {items.map((item) =>
            getHref ? (
              <li key={item.locale} role="none">
                <a
                  role="menuitem"
                  href={getHref(item.locale)}
                  hrefLang={item.locale}
                  lang={item.locale}
                  aria-current={item.locale === current ? "true" : undefined}
                  className="td-menu__item"
                  onClick={() => setOpen(false)}
                >
                  {item.label}
                </a>
              </li>
            ) : (
              <li key={item.locale} role="none">
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={item.locale === current}
                  lang={item.locale}
                  className="td-menu__item"
                  onClick={() => {
                    onChange?.(item.locale);
                    setOpen(false);
                  }}
                >
                  {item.label}
                </button>
              </li>
            ),
          )}
        </ul>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------- theme */

export type ThemeChoice = "system" | "light" | "dark";

export function applyTheme(choice: ThemeChoice) {
  if (typeof document === "undefined") return;
  if (choice === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", choice);
  try {
    localStorage.setItem("td-theme", choice);
  } catch {
    /* storage can be blocked; the choice still applies for this page */
  }
}

export function ThemeSwitcher({
  value = "system",
  onChange,
}: {
  value?: ThemeChoice;
  onChange?: (value: ThemeChoice) => void;
}) {
  const { t } = useLocale();
  const [choice, setChoice] = useState<ThemeChoice>(value);
  const choose = (next: ThemeChoice) => {
    setChoice(next);
    applyTheme(next);
    onChange?.(next);
  };
  return (
    <SegmentedControl
      label={t("common.theme")}
      hideLabel
      value={choice}
      onChange={(next) => choose(next as ThemeChoice)}
      options={[
        { value: "system", label: t("common.themeSystem") },
        { value: "light", label: t("common.themeLight") },
        { value: "dark", label: t("common.themeDark") },
      ]}
    />
  );
}

/* ------------------------------------------------------- error summary */

export interface FormError {
  fieldId: string;
  label: string;
  message: string;
}

export function FormErrorSummary({ errors, title }: { errors: FormError[]; title?: string }) {
  const { t } = useLocale();
  if (errors.length === 0) return null;
  return (
    <div className="td-error-summary" role="alert" tabIndex={-1}>
      <h2 className="td-error-summary__title">
        <Icon name="alert-triangle" size={18} />
        {title ?? t("form.errorSummary")}
      </h2>
      <p className="td-error-summary__count">{t("form.errorCount", { count: errors.length })}</p>
      <ul>
        {errors.map((error) => (
          <li key={error.fieldId}>
            <a href={`#${error.fieldId}`}>
              {error.label}: {error.message}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
