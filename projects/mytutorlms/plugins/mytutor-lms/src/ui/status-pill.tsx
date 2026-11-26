import type { ReactNode } from "react";
import { Icon, type IconName } from "./icon.js";
import type { Tone } from "./inline-alert.js";

const ICON: Record<Tone | "neutral", IconName> = {
  neutral: "clock",
  info: "info",
  success: "check",
  warning: "triangle-alert",
  danger: "circle-alert",
};

/** Status always carries text and an icon, never colour alone. */
export function StatusPill({
  tone = "neutral",
  icon,
  children,
}: {
  tone?: Tone | "neutral";
  icon?: IconName;
  children: ReactNode;
}) {
  return (
    <span className={`mt-pill mt-pill-${tone}`}>
      <Icon name={icon ?? ICON[tone]} size={14} />
      {children}
    </span>
  );
}
