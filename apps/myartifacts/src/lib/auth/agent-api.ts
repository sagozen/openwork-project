import { handleAgentApi } from "@templatedesign/platform/agents";
import { createAuth, getSessionContext } from "@templatedesign/platform/auth";
import { errorResponse, HttpError } from "@templatedesign/platform/http";
import type { Env } from "../types";
import { isOwner } from "./owner";

/** What the middleware knows about the browser session, as far as the agent API cares. */
export interface AgentApiLocals {
  user?: { id: string; email: string; name: string };
  session?: { id: string };
  /** A session exists but its address is not on the owner list. */
  nonOwner?: boolean;
}

const notOwner = (request: Request) =>
  errorResponse(new HttpError("forbidden", 403, "This account is not the owner of this app."), request);

/**
 * Connected-apps API (list, revoke, the OAuth consent decision) for the signed-in owner. A signed-in
 * address that is not the owner gets 403 and can never reach the consent decision; an anonymous
 * caller gets 401 from the platform handler.
 */
export async function handleOwnerAgentApi(env: Env, request: Request, locals: AgentApiLocals): Promise<Response> {
  if (locals.nonOwner) return notOwner(request);
  const session = locals.user && locals.session ? { user: locals.user, session: { id: locals.session.id } } : null;
  return (await handleAgentApi(env, request, session)) ?? new Response("Not found", { status: 404 });
}

/**
 * The Better Auth handler also serves the consent decision directly, behind the same session
 * cookie. This refuses that one endpoint for a session whose address is not the owner's; every
 * other auth route is left to Better Auth. Returns null when the request may proceed.
 */
export async function refuseNonOwnerConsent(env: Env, request: Request): Promise<Response | null> {
  if (!new URL(request.url).pathname.startsWith("/api/auth/oauth2/consent")) return null;
  const session = await getSessionContext(createAuth(env), env, request);
  return session && !isOwner(session.user.email, env) ? notOwner(request) : null;
}
