import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { AppUserRole } from "./platform";

export type AccessDenial = "unauthenticated" | "unknown_user" | "banned" | "deleted" | "forbidden";

export type AccessDecision = { ok: true; user: Doc<"users"> } | { ok: false; reason: AccessDenial };

const DENIAL_MESSAGES: Record<AccessDenial, string> = {
  unauthenticated: "Unauthenticated",
  unknown_user: "Account not found. Sign in again to finish setting up your account.",
  banned: "Account is banned",
  deleted: "Account is deleted",
  forbidden: "Unauthorized",
};

/**
 * Pure access policy. The caller's identity comes only from the verified Clerk
 * token (`subject`), never from request arguments. `user` is the stored record
 * for that subject, if any.
 */
export function decideAccess(input: {
  subject: string | null;
  user: Doc<"users"> | null;
  allowedRoles?: readonly AppUserRole[];
}): AccessDecision {
  if (!input.subject) {
    return { ok: false, reason: "unauthenticated" };
  }
  if (!input.user) {
    return { ok: false, reason: "unknown_user" };
  }
  if (input.user.deletedAt !== undefined) {
    return { ok: false, reason: "deleted" };
  }
  if (input.user.isBanned) {
    return { ok: false, reason: "banned" };
  }
  if (input.allowedRoles && !input.allowedRoles.includes(input.user.role)) {
    return { ok: false, reason: "forbidden" };
  }
  return { ok: true, user: input.user };
}

export function denialMessage(reason: AccessDenial): string {
  return DENIAL_MESSAGES[reason];
}

/**
 * Resolves the stored record for a Clerk subject. A deletion marker always wins: if any row for
 * the subject is deleted, or a legacy `deleted:<subject>` row exists, that deleted row is returned
 * even when an active duplicate also exists.
 */
export async function loadAccountState(ctx: Pick<QueryCtx, "db">, clerkId: string): Promise<Doc<"users"> | null> {
  const rows = await ctx.db
    .query("users")
    .withIndex("by_clerk_id", (q) => q.eq("clerkId", clerkId))
    .collect();
  const legacyDeleted = await ctx.db
    .query("users")
    .withIndex("by_clerk_id", (q) => q.eq("clerkId", `deleted:${clerkId}`))
    .first();

  const deletedRow = legacyDeleted ?? rows.find((row) => row.deletedAt !== undefined) ?? null;
  return deletedRow ?? rows[0] ?? null;
}

/** Returns the signed-in, active user, or throws. Any role may call this. */
export async function requireUser(ctx: QueryCtx | MutationCtx): Promise<Doc<"users">> {
  return requireRole(ctx);
}

/**
 * Returns the signed-in, active user, or null for guests. A signed-in account that is unknown,
 * banned, or deleted is also treated as a guest, so it can read only public data. Use this for
 * reads that serve both public and private records. Mutations must use `requireUser`.
 */
export async function optionalUser(ctx: QueryCtx | MutationCtx): Promise<Doc<"users"> | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    return null;
  }

  const user = await loadAccountState(ctx, identity.subject);
  const decision = decideAccess({ subject: identity.subject, user });
  return decision.ok ? decision.user : null;
}

/** Returns the signed-in, active user with one of `allowedRoles`, or throws. */
export async function requireRole(
  ctx: QueryCtx | MutationCtx,
  allowedRoles?: readonly AppUserRole[]
): Promise<Doc<"users">> {
  const identity = await ctx.auth.getUserIdentity();
  const user = identity ? await loadAccountState(ctx, identity.subject) : null;

  const decision = decideAccess({
    subject: identity?.subject ?? null,
    user,
    allowedRoles,
  });
  if (!decision.ok) {
    throw new Error(denialMessage(decision.reason));
  }
  return decision.user;
}

/**
 * Pure rule for records owned by one user: the owner always may act; other signed-in
 * users only when their role is in `staffRoles` (for example, admins reading a wallet).
 */
export function canActFor(input: {
  actor: Doc<"users">;
  targetUserId: Doc<"users">["_id"];
  staffRoles?: readonly AppUserRole[];
}): boolean {
  if (input.actor._id === input.targetUserId) {
    return true;
  }
  return input.staffRoles?.includes(input.actor.role) ?? false;
}

/** Like `requireUser`, but also allows staff roles to act for `targetUserId`. */
export async function requireSelfOr(
  ctx: QueryCtx | MutationCtx,
  targetUserId: Doc<"users">["_id"],
  staffRoles: readonly AppUserRole[]
): Promise<Doc<"users">> {
  const actor = await requireUser(ctx);
  if (!canActFor({ actor, targetUserId, staffRoles })) {
    throw new Error("Unauthorized");
  }
  return actor;
}
