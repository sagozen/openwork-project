import { Icon } from "../../ui/index.js";

/** Previous/next paging for cursor-based lists. */
export function Pagination({
  label,
  page,
  hasPrevious,
  hasNext,
  onPrevious,
  onNext,
  disabled = false,
}: {
  label: string;
  page: number;
  hasPrevious: boolean;
  hasNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
  disabled?: boolean;
}) {
  if (!hasPrevious && !hasNext) return null;
  return (
    <nav className="mt-pagination" aria-label={label}>
      <button
        type="button"
        disabled={disabled || !hasPrevious}
        onClick={onPrevious}
      >
        <Icon name="chevron-left" size={18} />
        Previous
      </button>
      <span aria-current="page">Page {page}</span>
      <button type="button" disabled={disabled || !hasNext} onClick={onNext}>
        Next
        <Icon name="chevron-right" size={18} />
      </button>
    </nav>
  );
}
