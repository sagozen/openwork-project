import type { ReactNode } from "react";
import { Icon } from "./icon.js";

/** Show-more content on the native <details>, so it works without script. */
export function Disclosure({
  summary,
  children,
  defaultOpen = false,
}: {
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <details className="mt-disclosure" open={defaultOpen}>
      <summary>
        <span>{summary}</span>
        <Icon name="chevron-down" size={18} />
      </summary>
      <div>{children}</div>
    </details>
  );
}
