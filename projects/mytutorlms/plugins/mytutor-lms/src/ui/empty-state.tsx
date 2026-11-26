import type { ReactNode } from "react";
import { Icon, type IconName } from "./icon.js";

export function EmptyState({
  icon = "layout-grid",
  title,
  children,
  action,
  headingLevel = 2,
}: {
  icon?: IconName;
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  headingLevel?: 2 | 3;
}) {
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <div className="mt-empty-state">
      <Icon name={icon} size={28} />
      <Heading>{title}</Heading>
      {children}
      {action && <div className="mt-empty-action">{action}</div>}
    </div>
  );
}
