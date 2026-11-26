import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Icon, type IconName } from "@mytutor/plugin-mytutor-lms/ui";

export type ButtonVariant = "primary" | "secondary" | "danger";

/** The theme's button; `busyLabel` replaces the label while `busy`. */
export default function Button({
  variant = "primary",
  small = false,
  icon,
  iconEnd,
  busy = false,
  busyLabel,
  children,
  className,
  disabled,
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  small?: boolean;
  icon?: IconName;
  iconEnd?: IconName;
  busy?: boolean;
  busyLabel?: ReactNode;
}) {
  const classes = [
    "button",
    variant !== "primary" && variant,
    small && "small",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button
      {...rest}
      type={type}
      className={classes}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
    >
      {icon && <Icon name={icon} size={18} />}
      {busy && busyLabel ? busyLabel : children}
      {iconEnd && <Icon name={iconEnd} size={18} />}
    </button>
  );
}
