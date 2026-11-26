import type { Lesson, LessonResource } from "@mytutor/plugin-mytutor-lms/model";

const DOWNLOAD =
  /\.(pdf|zip|rar|7z|tar|gz|tgz|dmg|pkg|exe|msi|apk|docx?|xlsx?|pptx?|csv|epub|mp3|wav|m4a)$/i;

/** Whether a link points at a file to download (by its path's extension) rather than a web page. */
export function isDownloadUrl(value: string): boolean {
  try {
    return DOWNLOAD.test(new URL(value).pathname);
  } catch {
    return false;
  }
}

/** The original single resource first, then the additional ones. */
export function lessonResources(
  lesson: Pick<Lesson, "resourceUrl" | "resourceLabel" | "resources">,
): LessonResource[] {
  return [
    ...(lesson.resourceUrl
      ? [{ url: lesson.resourceUrl, label: lesson.resourceLabel }]
      : []),
    ...(lesson.resources ?? []),
  ];
}
