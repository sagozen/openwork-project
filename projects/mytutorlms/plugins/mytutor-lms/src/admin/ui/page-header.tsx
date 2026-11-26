import type { ReactNode } from "react";
import { Icon } from "../../ui/index.js";

/** Title row for a workspace screen: back link, eyebrow, heading, actions. */
export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  backHref,
  backLabel = "Back to workspace",
  headingId,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  backHref?: string;
  backLabel?: string;
  headingId?: string;
}) {
  return (
    <div className="mt-page-header">
      {backHref && (
        <a className="mt-back-link" href={backHref}>
          <Icon name="arrow-left" size={16} />
          {backLabel}
        </a>
      )}
      <div className="mt-section-heading">
        <div>
          {eyebrow && <p className="mt-eyebrow">{eyebrow}</p>}
          <h2 id={headingId} tabIndex={-1}>
            {title}
          </h2>
          {description && <p className="mt-muted">{description}</p>}
        </div>
        {actions && <div className="mt-actions">{actions}</div>}
      </div>
    </div>
  );
}
