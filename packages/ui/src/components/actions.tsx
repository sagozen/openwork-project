import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from "react";
import { Icon, type IconName } from "../icons.js";
import { cx } from "../utils.js";

type Variant = "primary" | "secondary" | "tertiary" | "danger" | "danger-outline";
type Size = "sm" | "md" | "lg";

const buttonClass = (variant: Variant, size: Size, fullWidth: boolean, extra?: string) =>
  cx("td-btn", `td-btn--${variant}`, `td-btn--${size}`, fullWidth && "td-btn--full", extra);

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  iconLeft?: IconName;
  iconRight?: IconName;
  fullWidth?: boolean;
  children?: ReactNode;
}

export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  iconLeft,
  iconRight,
  fullWidth = false,
  className,
  disabled,
  children,
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={buttonClass(variant, size, fullWidth, className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? (
        <Icon name="loader" size={16} className="td-spin" />
      ) : iconLeft ? (
        <Icon name={iconLeft} size={16} />
      ) : null}
      <span className={loading ? "td-visually-hidden" : undefined}>{children}</span>
      {loading ? <span aria-hidden="true">{children}</span> : null}
      {iconRight && !loading ? <Icon name={iconRight} size={16} /> : null}
    </button>
  );
}

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label"> {
  label: string;
  icon: IconName;
  variant?: "ghost" | "secondary" | "danger";
  size?: "sm" | "md";
}

export function IconButton({ label, icon, variant = "ghost", size = "md", className, ...props }: IconButtonProps) {
  return (
    <button
      type="button"
      className={cx("td-icon-btn", `td-icon-btn--${variant}`, `td-icon-btn--${size}`, className)}
      aria-label={label}
      title={label}
      {...props}
    >
      <Icon name={icon} size={size === "sm" ? 16 : 20} />
    </button>
  );
}

export interface LinkButtonProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  variant?: Variant;
  size?: Size;
  iconLeft?: IconName;
  iconRight?: IconName;
  fullWidth?: boolean;
  external?: boolean;
}

export function LinkButton({
  variant = "tertiary",
  size = "md",
  iconLeft,
  iconRight,
  fullWidth = false,
  external = false,
  className,
  children,
  ...props
}: LinkButtonProps) {
  return (
    <a className={buttonClass(variant, size, fullWidth, cx("td-btn--link", className))} {...props}>
      {iconLeft ? <Icon name={iconLeft} size={16} /> : null}
      {children}
      {(iconRight ?? (external ? "external-link" : undefined)) ? (
        <Icon name={iconRight ?? "external-link"} size={16} />
      ) : null}
    </a>
  );
}
