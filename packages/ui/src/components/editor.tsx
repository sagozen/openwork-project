import { useLocale } from "../i18n.js";
import { Icon } from "../icons.js";
import { cx } from "../utils.js";

export function PreviewBudget({
  left,
  total,
  protectedCount = 3,
}: {
  left: number;
  total: number;
  protectedCount?: number;
}) {
  const { t } = useLocale();
  const low = left <= protectedCount;
  return (
    <div className={cx("td-previewbudget", low && "td-previewbudget--low")}>
      <div className="td-previewbudget__row">
        <Icon name="eye" size={16} />
        <span>{t("preview.budget", { left, total })}</span>
      </div>
      <div className="td-previewbudget__bar" aria-hidden="true">
        <span style={{ width: `${Math.min(100, (left / total) * 100)}%` }} />
      </div>
      {low ? <p className="td-previewbudget__note">{t("preview.lastThree")}</p> : null}
    </div>
  );
}

export function PreviewNotice({ pages }: { pages?: number }) {
  const { t } = useLocale();
  return (
    <div className="td-previewnotice">
      <Icon name="info" size={16} />
      <div>
        <p>{t("preview.watermark")}</p>
        {typeof pages === "number" ? <p className="td-previewnotice__stale">{t("preview.stale")}</p> : null}
      </div>
    </div>
  );
}

export function DesignerFallback({
  onUseForm,
  onContinueDesktop,
}: {
  onUseForm?: () => void;
  onContinueDesktop?: () => void;
}) {
  const { t } = useLocale();
  return (
    <div className="td-designerfallback">
      <span className="td-designerfallback__icon" aria-hidden="true">
        <Icon name="layout" size={24} />
      </span>
      <div>
        <p className="td-designerfallback__title">{t("designer.desktopOnly")}</p>
        <div className="td-designerfallback__actions">
          <button type="button" className="td-btn td-btn--primary td-btn--sm" onClick={onUseForm}>
            {t("designer.useForm")}
          </button>
          <button type="button" className="td-btn td-btn--secondary td-btn--sm" onClick={onContinueDesktop}>
            {t("designer.continueDesktop")}
          </button>
        </div>
      </div>
    </div>
  );
}

export interface Issue {
  id: string;
  severity: "error" | "warning" | "info";
  message: string;
  field?: string;
}

export function IssueList({ issues, onSelect }: { issues: Issue[]; onSelect?: (issue: Issue) => void }) {
  if (issues.length === 0) return null;
  return (
    <ul className="td-issues">
      {issues.map((issue) => (
        <li key={issue.id} className={cx("td-issues__item", `td-issues__item--${issue.severity}`)}>
          <Icon
            name={issue.severity === "error" ? "x-octagon" : issue.severity === "warning" ? "alert-triangle" : "info"}
            size={16}
          />
          <button type="button" onClick={() => onSelect?.(issue)}>
            {issue.message}
            {issue.field ? <span className="td-issues__field">{issue.field}</span> : null}
          </button>
        </li>
      ))}
    </ul>
  );
}
