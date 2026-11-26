import { type ReactNode, useMemo, useState } from "react";
import { useLocale } from "../i18n.js";
import { Icon, type IconName } from "../icons.js";
import { cx, useCopyToClipboard } from "../utils.js";

/* --------------------------------------------------------------- badge */

export type BadgeTone = "neutral" | "success" | "warning" | "danger" | "info" | "accent";

const statusTone: Record<string, BadgeTone> = {
  draft: "neutral",
  published: "success",
  archived: "neutral",
  queued: "info",
  running: "info",
  succeeded: "success",
  failed: "danger",
  expired: "warning",
  cancelled: "neutral",
  active: "success",
  revoked: "danger",
  mapped: "success",
  unmapped: "neutral",
  mismatch: "warning",
  new: "accent",
};

const statusIcon: Record<string, IconName> = {
  queued: "clock",
  running: "loader",
  succeeded: "check-circle",
  failed: "x-octagon",
  expired: "clock",
  cancelled: "close",
  active: "check",
  revoked: "lock",
  mapped: "check",
  unmapped: "info",
  mismatch: "alert-triangle",
};

export interface BadgeProps {
  tone?: BadgeTone;
  status?: string;
  icon?: IconName;
  children?: ReactNode;
}

export function Badge({ tone, status, icon, children }: BadgeProps) {
  const resolvedTone = tone ?? (status ? (statusTone[status] ?? "neutral") : "neutral");
  const resolvedIcon = icon ?? (status ? statusIcon[status] : undefined);
  return (
    <span className={cx("td-badge", `td-badge--${resolvedTone}`)}>
      {resolvedIcon ? (
        <Icon name={resolvedIcon} size={12} className={status === "running" ? "td-spin" : undefined} />
      ) : null}
      {children ?? status}
    </span>
  );
}

/* -------------------------------------------------------------- credit */

export interface CreditMeterProps {
  available: number;
  total?: number;
  lowThreshold?: number;
  guest?: { left: number; total: number };
  unavailable?: boolean;
  onTopUp?: () => void;
}

export function CreditMeter({ available, total, lowThreshold = 20, guest, unavailable, onTopUp }: CreditMeterProps) {
  const { t } = useLocale();
  const effectiveTotal = total ?? Math.max(available, 1);
  const state = unavailable ? "unavailable" : available <= 0 ? "empty" : available <= lowThreshold ? "low" : "normal";
  if (guest) {
    return (
      <div className="td-credit td-credit--guest">
        <div className="td-credit__dots" aria-hidden="true">
          {Array.from({ length: guest.total }, (_, index) => (
            <span key={index} className={cx("td-credit__dot", index < guest.left && "td-credit__dot--on")} />
          ))}
        </div>
        <p className="td-credit__guest-text">{t("credit.guest", { left: guest.left, total: guest.total })}</p>
      </div>
    );
  }
  return (
    <div className={cx("td-credit", `td-credit--${state}`)}>
      <div className="td-credit__top">
        <span className="td-credit__value">
          {unavailable ? t("credit.unavailable") : t("credit.available", { count: available })}
        </span>
        {state === "empty" && onTopUp ? (
          <button type="button" className="td-btn td-btn--primary td-btn--sm" onClick={onTopUp}>
            {t("credit.topUp")}
          </button>
        ) : null}
      </div>
      {!unavailable ? (
        <>
          <div
            className="td-credit__bar"
            role="meter"
            aria-label={t("credit.label")}
            aria-valuenow={available}
            aria-valuemin={0}
            aria-valuemax={effectiveTotal}
            aria-valuetext={t("credit.available", { count: available })}
          >
            <span style={{ width: `${Math.min(100, Math.max(0, (available / effectiveTotal) * 100))}%` }} />
          </div>
          <p className="td-credit__estimate">
            {t("credit.estimate", { count: available })} · {t("credit.noSubscription")}
          </p>
        </>
      ) : null}
    </div>
  );
}

export interface CostLineProps {
  pages: number;
  credits: number;
  left?: number;
  retention?: string;
  balance?: number;
  shortfall?: boolean;
}

export function CostLine({ pages, credits, left, retention, balance, shortfall }: CostLineProps) {
  const { t } = useLocale();
  return (
    <p className={cx("td-cost-line", shortfall && "td-cost-line--short")}>
      <Icon name={shortfall ? "alert-triangle" : "info"} size={14} />
      {typeof balance === "number"
        ? t("credit.costLinePaid", { pages, credits, balance })
        : t("credit.costLine", { pages, credits, left: left ?? 0, retention: retention ?? "" })}
    </p>
  );
}

/* ----------------------------------------------------------- code block */

export interface CodeTab {
  id: string;
  label: string;
  code: string;
  language?: string;
}

export function CodeBlock({ code, tabs, label }: { code?: string; tabs?: CodeTab[]; label?: string }) {
  const { t } = useLocale();
  const { copy, state } = useCopyToClipboard();
  const [active, setActive] = useState(tabs?.[0]?.id);
  const current = tabs?.find((tab) => tab.id === active) ?? tabs?.[0];
  const value = current?.code ?? code ?? "";
  return (
    <div className="td-code">
      <div className="td-code__bar">
        {tabs && tabs.length > 1 ? (
          <div className="td-code__tabs" role="tablist">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={tab.id === current?.id}
                className={cx("td-code__tab", tab.id === current?.id && "td-code__tab--on")}
                onClick={() => setActive(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>
        ) : (
          <span className="td-code__lang">{label ?? current?.label ?? current?.language ?? "code"}</span>
        )}
        <button type="button" className="td-code__copy" onClick={() => copy(value)}>
          <Icon name={state === "copied" ? "check" : "copy"} size={14} />
          {state === "copied" ? t("common.copied") : t("common.copy")}
        </button>
      </div>
      <pre className="td-code__pre" tabIndex={0} role="region" aria-label={label}>
        <code>{value}</code>
      </pre>
      <span className="td-visually-hidden" aria-live="polite">
        {state === "copied" ? t("common.copied") : state === "failed" ? t("common.copyFailed") : ""}
      </span>
    </div>
  );
}

/* ---------------------------------------------------------- job status */

export interface JobStatusProps {
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "expired";
  pages?: number;
  retention?: string;
  elapsedSeconds?: number;
  errorMessage?: string;
  children?: ReactNode;
}

const order = ["queued", "running", "succeeded"] as const;

export function JobStatus({ status, pages, retention, elapsedSeconds, errorMessage, children }: JobStatusProps) {
  const { t } = useLocale();
  const current = status === "expired" ? 2 : order.indexOf(status as (typeof order)[number]);
  return (
    <section className="td-jobstatus" aria-live="polite">
      <div className="td-jobstatus__head">
        <Badge status={status} />
        {typeof pages === "number" ? (
          <span className="td-jobstatus__pages">{t("job.pages", { count: pages })}</span>
        ) : null}
        {typeof elapsedSeconds === "number" ? (
          <span className="td-jobstatus__elapsed">{t("job.elapsed", { seconds: elapsedSeconds })}</span>
        ) : null}
      </div>
      <p className="td-jobstatus__title">{t(`job.${status}` as Parameters<typeof t>[0])}</p>
      {status === "queued" ? <p className="td-jobstatus__note">{t("job.position")}</p> : null}
      {status === "running" ? (
        <div className="td-progress td-progress--indeterminate" role="progressbar" aria-label={t("job.running")}>
          <span />
        </div>
      ) : null}
      {status === "failed" && errorMessage ? (
        <p className="td-jobstatus__error">
          <Icon name="x-octagon" size={16} /> {errorMessage}
        </p>
      ) : null}
      {status === "failed" ? <p className="td-jobstatus__note">{t("job.noCreditsCharged")}</p> : null}
      {status === "expired" ? <p className="td-jobstatus__note">{t("job.expired")}</p> : null}
      <ol className="td-ministepper" aria-label={t("common.status")}>
        {order.map((step, index) => (
          <li key={step} className={cx(index < current && "is-done", index === current && "is-current")}>
            {t(`badge.${step}` as Parameters<typeof t>[0])}
          </li>
        ))}
      </ol>
      {retention ? <p className="td-jobstatus__retention">{t("job.fileKept", { date: retention })}</p> : null}
      {children ? <div className="td-jobstatus__actions">{children}</div> : null}
    </section>
  );
}

/* -------------------------------------------------------------- stepper */

export interface Step {
  label: string;
  state?: "complete" | "current" | "upcoming" | "error";
}

export function Stepper({
  steps,
  current = 0,
  vertical = false,
}: {
  steps: Step[];
  current?: number;
  vertical?: boolean;
}) {
  const { t } = useLocale();
  return (
    <ol
      className={cx("td-stepper", vertical && "td-stepper--vertical")}
      aria-label={t("stepper.step", { current: current + 1, total: steps.length })}
    >
      {steps.map((step, index) => {
        const state = step.state ?? (index < current ? "complete" : index === current ? "current" : "upcoming");
        return (
          <li
            key={step.label}
            className={cx("td-stepper__item", `td-stepper__item--${state}`)}
            aria-current={state === "current" ? "step" : undefined}
          >
            <span className="td-stepper__marker" aria-hidden="true">
              {state === "complete" ? <Icon name="check" size={12} /> : index + 1}
            </span>
            <span className="td-stepper__label">{step.label}</span>
            <span className="td-visually-hidden">
              {state === "complete"
                ? t("stepper.complete")
                : state === "current"
                  ? t("stepper.current")
                  : t("stepper.upcoming")}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/* ------------------------------------------------------------- skeleton */

export function Skeleton({
  lines = 1,
  width,
  height = 16,
  circle = false,
}: {
  lines?: number;
  width?: string;
  height?: number;
  circle?: boolean;
}) {
  return (
    <div className="td-skeleton" aria-hidden="true">
      {Array.from({ length: lines }, (_, index) => (
        <span
          key={index}
          className={cx("td-skeleton__line", circle && "td-skeleton__line--circle")}
          style={{ width: circle ? height : (width ?? (index === lines - 1 ? "65%" : "100%")), height }}
        />
      ))}
    </div>
  );
}

/* ---------------------------------------------------------- empty state */

export interface EmptyStateProps {
  title: string;
  body: string;
  action?: ReactNode;
  icon?: IconName;
}

export function EmptyState({ title, body, action, icon = "template" }: EmptyStateProps) {
  return (
    <div className="td-empty">
      <span className="td-empty__icon" aria-hidden="true">
        <Icon name={icon} size={24} />
      </span>
      <h3 className="td-empty__title">{title}</h3>
      <p className="td-empty__body">{body}</p>
      {action ? <div className="td-empty__action">{action}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------ pagination */

export interface PaginationProps {
  page: number;
  pageCount: number;
  total?: number;
  pageSize?: number;
  onChange: (page: number) => void;
}

export function Pagination({ page, pageCount, total, pageSize = 20, onChange }: PaginationProps) {
  const { t } = useLocale();
  const pages = useMemo(() => {
    if (pageCount <= 7) return Array.from({ length: pageCount }, (_, index) => index + 1);
    const set = new Set([1, pageCount, page - 1, page, page + 1]);
    return [...set].filter((value) => value >= 1 && value <= pageCount).sort((a, b) => a - b);
  }, [page, pageCount]);
  if (pageCount <= 1) return null;
  return (
    <nav className="td-pagination" aria-label={t("pagination.label")}>
      <button
        type="button"
        className="td-pagination__btn"
        disabled={page <= 1}
        onClick={() => onChange(page - 1)}
        aria-label={t("pagination.previous")}
      >
        <Icon name="chevron-left" size={16} />
      </button>
      {pages.map((value, index) => {
        const previous = pages[index - 1];
        return (
          <span key={value} className="td-pagination__slot">
            {previous && value - previous > 1 ? <span className="td-pagination__ellipsis">…</span> : null}
            <button
              type="button"
              className={cx("td-pagination__btn", value === page && "td-pagination__btn--current")}
              aria-current={value === page ? "page" : undefined}
              onClick={() => onChange(value)}
            >
              {value}
            </button>
          </span>
        );
      })}
      <button
        type="button"
        className="td-pagination__btn"
        disabled={page >= pageCount}
        onClick={() => onChange(page + 1)}
        aria-label={t("pagination.next")}
      >
        <Icon name="chevron-right" size={16} />
      </button>
      {typeof total === "number" ? (
        <span className="td-pagination__summary">
          {t("common.showing", {
            from: (page - 1) * pageSize + 1,
            to: Math.min(page * pageSize, total),
            total,
          })}
        </span>
      ) : null}
    </nav>
  );
}

/* ----------------------------------------------------------- data table */

export interface Column<T> {
  key: string;
  header: string;
  render?: (row: T) => ReactNode;
  numeric?: boolean;
  sortable?: boolean;
}

export interface DataTableProps<T> {
  caption: string;
  columns: Array<Column<T>>;
  rows: T[];
  rowKey: (row: T) => string;
  loading?: boolean;
  empty?: ReactNode;
  dense?: boolean;
  selected?: Set<string>;
  onSelect?: (keys: Set<string>) => void;
  sort?: { key: string; direction: "asc" | "desc" };
  onSort?: (sort: { key: string; direction: "asc" | "desc" }) => void;
}

export function DataTable<T>({
  caption,
  columns,
  rows,
  rowKey,
  loading = false,
  empty,
  dense = false,
  selected,
  onSelect,
  sort,
  onSort,
}: DataTableProps<T>) {
  const { t } = useLocale();
  const allSelected = selected ? rows.length > 0 && rows.every((row) => selected.has(rowKey(row))) : false;
  return (
    <div className="td-table-wrap" role="region" aria-label={caption} tabIndex={0}>
      <table className={cx("td-table", dense && "td-table--dense")}>
        <caption className="td-visually-hidden">{caption}</caption>
        <thead>
          <tr>
            {onSelect ? (
              <th scope="col" className="td-table__check">
                <input
                  type="checkbox"
                  checked={allSelected}
                  aria-label={t("table.selectAll")}
                  onChange={() => {
                    const next = new Set(selected ?? []);
                    if (allSelected) rows.forEach((row) => next.delete(rowKey(row)));
                    else rows.forEach((row) => next.add(rowKey(row)));
                    onSelect(next);
                  }}
                />
              </th>
            ) : null}
            {columns.map((column) => {
              const active = sort?.key === column.key;
              const ariaSort = active
                ? sort?.direction === "asc"
                  ? "ascending"
                  : "descending"
                : column.sortable
                  ? "none"
                  : undefined;
              return (
                <th
                  key={column.key}
                  scope="col"
                  aria-sort={ariaSort}
                  className={cx(column.numeric && "td-table__numeric")}
                >
                  {column.sortable && onSort ? (
                    <button
                      type="button"
                      className="td-table__sort"
                      onClick={() =>
                        onSort({
                          key: column.key,
                          direction: active && sort?.direction === "asc" ? "desc" : "asc",
                        })
                      }
                    >
                      {column.header}
                      <Icon
                        name="chevron-down"
                        size={12}
                        className={active ? (sort?.direction === "asc" ? "rotate-180" : "") : "is-muted"}
                      />
                    </button>
                  ) : (
                    column.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {loading ? (
            Array.from({ length: 3 }, (_, index) => (
              <tr key={`skeleton-${index}`}>
                {onSelect ? <td /> : null}
                {columns.map((column) => (
                  <td key={column.key}>
                    <Skeleton height={12} />
                  </td>
                ))}
              </tr>
            ))
          ) : rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length + (onSelect ? 1 : 0)} className="td-table__empty">
                {empty ?? (
                  <>
                    <strong>{t("table.emptyTitle")}</strong>
                    <span>{t("table.emptyBody")}</span>
                  </>
                )}
              </td>
            </tr>
          ) : (
            rows.map((row) => {
              const key = rowKey(row);
              return (
                <tr key={key} className={selected?.has(key) ? "is-selected" : undefined}>
                  {onSelect ? (
                    <td className="td-table__check">
                      <input
                        type="checkbox"
                        checked={selected?.has(key) ?? false}
                        aria-label={t("table.selectRow")}
                        onChange={() => {
                          const next = new Set(selected ?? []);
                          if (next.has(key)) next.delete(key);
                          else next.add(key);
                          onSelect(next);
                        }}
                      />
                    </td>
                  ) : null}
                  {columns.map((column) => (
                    <td key={column.key} className={cx(column.numeric && "td-table__numeric")}>
                      {column.render ? column.render(row) : String((row as Record<string, unknown>)[column.key] ?? "")}
                    </td>
                  ))}
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------ CSV mapper */

export interface CsvMappingRow {
  csvColumn: string;
  sample: string;
  field: string;
  fieldLabel: string;
  required: boolean;
  status: "mapped" | "unmapped" | "mismatch";
}

export function CsvMapperTable({
  rows,
  fields,
  onChange,
}: {
  rows: CsvMappingRow[];
  fields: Array<{ value: string; label: string }>;
  onChange?: (csvColumn: string, field: string) => void;
}) {
  const { t } = useLocale();
  return (
    <div className="td-table-wrap" role="region" aria-label="CSV mapping" tabIndex={0}>
      <table className="td-table td-table--dense">
        <caption className="td-visually-hidden">CSV mapping</caption>
        <thead>
          <tr>
            <th scope="col">CSV column</th>
            <th scope="col">Sample value</th>
            <th scope="col">Maps to template field</th>
            <th scope="col">{t("common.status")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.csvColumn}>
              <th scope="row">{row.csvColumn}</th>
              <td className="td-table__sample">{row.sample}</td>
              <td>
                <div className="td-field td-field--compact">
                  <label className="td-visually-hidden" htmlFor={`map-${row.csvColumn}`}>
                    {row.csvColumn} maps to
                  </label>
                  <select
                    id={`map-${row.csvColumn}`}
                    className="td-select"
                    value={row.field}
                    onChange={(event) => onChange?.(row.csvColumn, event.target.value)}
                  >
                    <option value="">— {t("badge.unmapped")} —</option>
                    {fields.map((field) => (
                      <option key={field.value} value={field.value}>
                        {field.label}
                        {row.required && field.value === row.field ? ` (${t("common.required")})` : ""}
                      </option>
                    ))}
                  </select>
                </div>
              </td>
              <td>
                <Badge status={row.status} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------------------------------------------------------------- chart */

export interface ChartSeries {
  label: string;
  values: number[];
}

export function Chart({
  title,
  labels,
  series,
  type = "bar",
  summary,
  valuePrefix = "",
}: {
  title: string;
  labels: string[];
  series: ChartSeries[];
  type?: "bar" | "line";
  summary: string;
  valuePrefix?: string;
}) {
  const { t } = useLocale();
  const [showTable, setShowTable] = useState(false);
  const width = 640;
  const height = 260;
  const padding = { top: 20, right: 16, bottom: 36, left: 48 };
  const max = Math.max(1, ...series.flatMap((item) => item.values));
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const step = plotWidth / Math.max(1, labels.length);
  const barWidth = Math.max(6, (step * 0.6) / Math.max(1, series.length));
  const y = (value: number) => padding.top + plotHeight - (value / max) * plotHeight;

  return (
    <figure className="td-chart">
      <figcaption className="td-chart__title">{title}</figcaption>
      <div className="td-chart__canvas">
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={summary}>
          {[0, 0.25, 0.5, 0.75, 1].map((tick) => (
            <line
              key={tick}
              x1={padding.left}
              x2={width - padding.right}
              y1={padding.top + plotHeight * tick}
              y2={padding.top + plotHeight * tick}
              className="td-chart__grid"
            />
          ))}
          {labels.map((label, index) => (
            <text
              key={label}
              x={padding.left + step * index + step / 2}
              y={height - 12}
              textAnchor="middle"
              className="td-chart__label"
            >
              {label}
            </text>
          ))}
          {type === "bar"
            ? series.map((item, seriesIndex) =>
                item.values.map((value, index) => (
                  <rect
                    key={`${item.label}-${index}`}
                    x={padding.left + step * index + step * 0.2 + seriesIndex * barWidth}
                    y={y(value)}
                    width={barWidth - 2}
                    height={Math.max(0, padding.top + plotHeight - y(value))}
                    className={`td-chart__bar td-chart__series-${(seriesIndex % 5) + 1}`}
                  />
                )),
              )
            : series.map((item, seriesIndex) => (
                <polyline
                  key={item.label}
                  points={item.values
                    .map((value, index) => `${padding.left + step * index + step / 2},${y(value)}`)
                    .join(" ")}
                  className={`td-chart__line td-chart__series-${(seriesIndex % 5) + 1}`}
                />
              ))}
        </svg>
      </div>
      <div className="td-chart__legend">
        {series.map((item, index) => (
          <span key={item.label} className="td-chart__legend-item">
            <span className={`td-chart__swatch td-chart__series-${(index % 5) + 1}`} aria-hidden="true" />
            {item.label}
          </span>
        ))}
        <button
          type="button"
          className="td-btn td-btn--tertiary td-btn--sm"
          onClick={() => setShowTable((value) => !value)}
        >
          {showTable ? t("common.hideTable") : t("common.viewAsTable")}
        </button>
      </div>
      {showTable ? (
        <div className="td-table-wrap">
          <table className="td-table td-table--dense">
            <caption className="td-visually-hidden">{title}</caption>
            <thead>
              <tr>
                <th scope="col">{t("common.page")}</th>
                {series.map((item) => (
                  <th key={item.label} scope="col" className="td-table__numeric">
                    {item.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {labels.map((label, index) => (
                <tr key={label}>
                  <th scope="row">{label}</th>
                  {series.map((item) => (
                    <td key={item.label} className="td-table__numeric">
                      {valuePrefix}
                      {item.values[index]}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </figure>
  );
}
