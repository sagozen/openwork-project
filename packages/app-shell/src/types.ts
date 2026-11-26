import type { ResolvedBrand, Workspace, WorkspaceMember } from "@templatedesign/platform/workspaces";

/** What the shell middleware leaves on `Astro.locals` for pages and API routes. */
export interface ShellLocals {
  workspace?: Workspace;
  brand?: ResolvedBrand;
  /** The signed-in user's membership in `workspace`, or null for visitors and non-members. */
  member?: WorkspaceMember | null;
}

export type { ResolvedBrand, Workspace, WorkspaceMember };
