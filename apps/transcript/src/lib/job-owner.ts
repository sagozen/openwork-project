import type { Actor, ApiLocals } from "./api";

type JobOwner = { tenant_id: string | null; guest_id: string | null };

/** Jobs belong to a tenant, or to the guest cookie when there is no tenant. */
export function actorOwnsJob(actor: Pick<Actor, "tenantId" | "guestId">, job: JobOwner): boolean {
  if (job.tenant_id) return actor.tenantId === job.tenant_id;
  return Boolean(actor.guestId) && actor.guestId === job.guest_id;
}

/**
 * The browser visitor as the job API sees them: a signed-in tenant, or a guest identified by the
 * `ta_guest` cookie. Pages use this so `/?job=` shows exactly what the API would return.
 */
export function browserActor(locals: ApiLocals): Actor {
  if (locals.user && locals.tenantId) {
    return { tenantId: locals.tenantId, userId: locals.user.id, guestId: null, viaApi: false, livemode: true };
  }
  return { tenantId: null, userId: null, guestId: locals.guestId || null, viaApi: false, livemode: true };
}

export function canViewJob(locals: ApiLocals, job: JobOwner): boolean {
  return actorOwnsJob(browserActor(locals), job);
}
