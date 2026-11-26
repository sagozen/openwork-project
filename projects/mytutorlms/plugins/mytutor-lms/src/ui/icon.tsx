import { ICONS, type IconName } from "../design/icons.js";

export type { IconName };

/**
 * A Lucide icon in the current text colour. Icons sit beside visible text, so
 * they are hidden from assistive technology; IconButton supplies the name.
 */
export function Icon({
  name,
  size = 20,
  className,
}: {
  name: IconName;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      className={className ? `mt-icon ${className}` : "mt-icon"}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      // Fixed markup from the generated Lucide subset, never user input.
      dangerouslySetInnerHTML={{ __html: ICONS[name] }}
    />
  );
}
