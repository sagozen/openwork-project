import type { LessonResource } from "@mytutor/plugin-mytutor-lms/model";
import { Icon } from "../ui";
import type { Translate } from "../../i18n";
import { isDownloadUrl } from "../../lib/resources";

/**
 * Links the instructor attached to the lesson. They open in a new tab; links
 * to files (.pdf, .zip and similar) say "Download" instead of "Open".
 */
export default function ResourceList({
  t,
  resources,
}: {
  t: Translate;
  resources: LessonResource[];
}) {
  if (!resources.length) return null;
  return (
    <section className="resource" aria-label={t("classroom.resources")}>
      <p className="eyebrow">{t("classroom.keepBuilding")}</p>
      <ul>
        {resources.map((resource, index) => {
          const download = isDownloadUrl(resource.url);
          return (
            <li key={`${index}:${resource.url}`}>
              <strong>{resource.label || t("classroom.resource")}</strong>
              <a
                className="button secondary small"
                href={resource.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                {download
                  ? t("classroom.resourceDownload")
                  : t("classroom.resourceOpen")}
                <Icon name={download ? "file" : "external-link"} size={16} />
                <span className="mt-visually-hidden">
                  {resource.label ? ` ${resource.label}` : ""}{" "}
                  {t("classroom.newTab")}
                </span>
              </a>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
