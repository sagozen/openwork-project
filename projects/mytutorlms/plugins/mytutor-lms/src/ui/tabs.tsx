import { useId, useRef, type ReactNode } from "react";

/**
 * Tabs with arrow-key movement (WAI-ARIA tabs pattern, automatic activation).
 * The caller owns the selected value so it can live in the URL.
 */
export function Tabs<T extends string>({
  label,
  tabs,
  selected,
  onSelect,
  children,
}: {
  label: string;
  tabs: Array<{ value: T; label: ReactNode }>;
  selected: T;
  onSelect: (value: T) => void;
  children: ReactNode;
}) {
  const id = useId();
  const list = useRef<HTMLDivElement>(null);
  function move(offset: number) {
    const index = tabs.findIndex((tab) => tab.value === selected);
    const next = tabs[(index + offset + tabs.length) % tabs.length];
    if (!next) return;
    onSelect(next.value);
    list.current
      ?.querySelector<HTMLButtonElement>(`[data-value="${next.value}"]`)
      ?.focus();
  }
  return (
    <div className="mt-tabs">
      <div
        ref={list}
        role="tablist"
        aria-label={label}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight") move(1);
          else if (event.key === "ArrowLeft") move(-1);
          else return;
          event.preventDefault();
        }}
      >
        {tabs.map((tab) => (
          <button
            key={tab.value}
            type="button"
            role="tab"
            id={`${id}-${tab.value}`}
            data-value={tab.value}
            aria-selected={tab.value === selected}
            aria-controls={`${id}-panel`}
            tabIndex={tab.value === selected ? 0 : -1}
            onClick={() => onSelect(tab.value)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`${id}-panel`}
        aria-labelledby={`${id}-${selected}`}
        tabIndex={0}
      >
        {children}
      </div>
    </div>
  );
}
