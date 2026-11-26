import type { Db } from "@templatedesign/platform/db";
import {
  getMember,
  type ResolvedBrand,
  resolveBrand,
  resolveWorkspace,
  type SlugCache,
  slugProblem,
  type Workspace,
  type WorkspaceMember,
} from "@templatedesign/platform/workspaces";

const FIRST_SEGMENT = /^\/([^/]+)(\/[\s\S]*)?$/;

/**
 * Splits `/pho-24/admin/floor` into the candidate workspace slug and the rest of the path.
 * A first segment counts as a slug only if it is well-formed and not reserved, so `/admin`,
 * `/api/...`, `/pricing` and files like `/robots.txt` stay app-level routes.
 */
export function splitWorkspacePath(pathname: string): { slug: string | null; rest: string } {
  const match = pathname.match(FIRST_SEGMENT);
  if (!match) return { slug: null, rest: pathname };
  const segment = match[1];
  const rest = match[2] ?? "/";
  if (slugProblem(segment) !== null) return { slug: null, rest: pathname };
  return { slug: segment, rest };
}

export type WorkspaceRequest =
  | { kind: "none" }
  | { kind: "not-found" }
  | { kind: "locked"; workspace: Workspace }
  | { kind: "sign-in-required"; workspace: Workspace }
  | { kind: "forbidden"; workspace: Workspace }
  | {
      kind: "ok";
      workspace: Workspace;
      brand: ResolvedBrand;
      member: WorkspaceMember | null;
      /** Path below the slug, always starting with `/`. */
      rest: string;
    };

export interface WorkspaceRequestInput {
  db: Db;
  app: string;
  pathname: string;
  /** The signed-in user's id, if any. */
  userId?: string;
  cache?: SlugCache;
}

/** Paths below the slug that only members may open. Everything else is the public site. */
export const isMemberOnly = (rest: string) => rest === "/admin" || rest.startsWith("/admin/");

/**
 * Resolves the workspace a request is for and decides whether the caller may see it. Pure
 * function over the database so it is unit-testable without Astro; `middleware.ts` maps the
 * result to redirects, 403s and 404s.
 */
export async function loadWorkspaceRequest(input: WorkspaceRequestInput): Promise<WorkspaceRequest> {
  const { slug, rest } = splitWorkspacePath(input.pathname);
  if (!slug) return { kind: "none" };

  const workspace = await resolveWorkspace(input.db, input.app, slug, input.cache);
  if (!workspace) return { kind: "not-found" };
  if (workspace.status === "locked") return { kind: "locked", workspace };

  const member = input.userId ? await getMember(input.db, workspace.id, input.userId) : null;
  if (isMemberOnly(rest)) {
    if (!input.userId) return { kind: "sign-in-required", workspace };
    if (!member) return { kind: "forbidden", workspace };
  }
  const brand = await resolveBrand(input.db, workspace);
  return { kind: "ok", workspace, brand, member, rest };
}
