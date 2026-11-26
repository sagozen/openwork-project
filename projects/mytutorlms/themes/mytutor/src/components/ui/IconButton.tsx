import type { ButtonHTMLAttributes } from "react";
import { Icon, type IconName } from "@mytutor/plugin-mytutor-lms/ui";

/** An icon-only button; the label is required because nothing else names it. */
export default function IconButton({
  icon,
  label,
  className,
  type = "button",
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label"> & {
  icon: IconName;
  label: string;
}) {
  return (
    <button
      {...rest}
      type={type}
      aria-label={label}
      title={label}
      className={className ? `mt-icon-button ${className}` : "mt-icon-button"}
    >
      <Icon name={icon} />
    </button>
  );
}
