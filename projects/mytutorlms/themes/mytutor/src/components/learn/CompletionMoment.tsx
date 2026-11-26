import type { Translate } from "../../i18n";

/**
 * The one celebration: a check that draws itself once when the whole course
 * is complete. Reduced motion shows it already drawn.
 */
export default function CompletionMoment({ t }: { t: Translate }) {
  return (
    <div className="completion-banner" role="status">
      <svg
        className="completion-check"
        viewBox="0 0 48 48"
        width="48"
        height="48"
        aria-hidden="true"
      >
        <circle cx="24" cy="24" r="22" />
        <path d="M14 25l7 7 13-15" />
      </svg>
      <div>
        <h2>{t("classroom.courseDone.title")}</h2>
        <p>{t("classroom.courseDone.body")}</p>
      </div>
    </div>
  );
}
