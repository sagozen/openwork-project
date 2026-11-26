import type { ReactNode } from "react";

/** A labelled progress bar; the visible label carries the numbers. */
export function ProgressMeter({
  value,
  max,
  label,
  detail,
}: {
  value: number;
  max: number;
  label: ReactNode;
  detail?: ReactNode;
}) {
  const percent = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="mt-progress">
      <p className="mt-progress-label">{label}</p>
      <div className="mt-progress-track" aria-hidden="true">
        <span style={{ inlineSize: `${percent}%` }} />
      </div>
      <progress className="mt-visually-hidden" value={value} max={max || 1}>
        {percent}%
      </progress>
      {detail && <p className="mt-progress-detail">{detail}</p>}
    </div>
  );
}
