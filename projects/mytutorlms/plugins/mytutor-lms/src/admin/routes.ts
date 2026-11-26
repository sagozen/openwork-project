// Workspace screens live in the URL hash (#/students, #/courses/abc/grading),
// so browser Back works and every screen can be bookmarked. The hash keeps
// this independent of how the EmDash admin routes its own pages.
export type Route =
  | { view: "home" }
  | { view: "courses" }
  | { view: "students" }
  | { view: "grading" }
  | { view: "team" }
  | { view: "site" }
  | { view: "editor"; id: string }
  | { view: "roster" | "assignments" | "media" | "live"; id: string };

const COURSE_VIEWS = {
  students: "roster",
  grading: "assignments",
  videos: "media",
  live: "live",
} as const;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const [first, id, sub] = parts.map(decodeURIComponent);
  if (!first) return { view: "home" };
  if (parts.length === 1) {
    if (first === "courses") return { view: "courses" };
    if (first === "students") return { view: "students" };
    if (first === "grading") return { view: "grading" };
    if (first === "team") return { view: "team" };
    if (first === "site") return { view: "site" };
    return { view: "home" };
  }
  if (first !== "courses" || !id || !(id === "new" || ID.test(id)))
    return { view: "home" };
  if (parts.length === 2) return { view: "editor", id };
  if (parts.length === 3 && sub && sub in COURSE_VIEWS && id !== "new")
    return { view: COURSE_VIEWS[sub as keyof typeof COURSE_VIEWS], id };
  return { view: "home" };
}

export function routeHash(route: Route): string {
  switch (route.view) {
    case "home":
      return "#/";
    case "editor":
      return `#/courses/${encodeURIComponent(route.id)}`;
    case "roster":
      return `#/courses/${encodeURIComponent(route.id)}/students`;
    case "assignments":
      return `#/courses/${encodeURIComponent(route.id)}/grading`;
    case "media":
      return `#/courses/${encodeURIComponent(route.id)}/videos`;
    case "live":
      return `#/courses/${encodeURIComponent(route.id)}/live`;
    default:
      return `#/${route.view}`;
  }
}
