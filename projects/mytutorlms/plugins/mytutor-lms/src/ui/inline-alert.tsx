import type { ReactNode } from "react";
import { Icon, type IconName } from "./icon.js";

export type Tone = "info" | "success" | "warning" | "danger";
const ICON: Record<Tone, IconName> = {
  info: "info",
  success: "circle-check",
  warning: "triangle-alert",
  danger: "circle-alert",
};

/**
 * A message in the flow of the page. Errors interrupt assistive technology
 * (role="alert"); everything else is announced politely.
 */
export function InlineAlert({
  tone = "info",
  title,
  children,
  action,
}: {
  tone?: Tone;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div
      className={`mt-alert mt-alert-${tone}`}
      role={tone === "danger" ? "alert" : "status"}
    >
      <Icon name={ICON[tone]} className="mt-alert-icon" />
      <div className="mt-alert-body">
        {title && <p className="mt-alert-title">{title}</p>}
        {children}
        {action && <div className="mt-alert-action">{action}</div>}
      </div>
    </div>
  );
}
