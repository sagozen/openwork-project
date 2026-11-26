import { useId } from "react";
import { Icon } from "../../ui/index.js";

/** Search box plus one status filter, labelled for screen readers. */
export function FilterBar<Value extends string>({
  search,
  onSearch,
  searchLabel,
  filter,
  onFilter,
  filterLabel,
  options,
}: {
  search?: string;
  onSearch?: (value: string) => void;
  searchLabel?: string;
  filter?: Value;
  onFilter?: (value: Value) => void;
  filterLabel?: string;
  options?: Array<{ value: Value; label: string }>;
}) {
  const id = useId();
  return (
    <div className="mt-filter-bar" role="search">
      {onSearch && (
        <label className="mt-filter-search" htmlFor={`${id}-search`}>
          <Icon name="search" size={18} />
          <span className="mt-visually-hidden">{searchLabel}</span>
          <input
            id={`${id}-search`}
            type="search"
            value={search ?? ""}
            placeholder={searchLabel}
            onChange={(event) => onSearch(event.target.value)}
          />
        </label>
      )}
      {onFilter && options && (
        <label className="mt-filter-select" htmlFor={`${id}-filter`}>
          <Icon name="funnel" size={18} />
          <span>{filterLabel}</span>
          <select
            id={`${id}-filter`}
            value={filter}
            onChange={(event) => onFilter(event.target.value as Value)}
          >
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}
