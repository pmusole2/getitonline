import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { internalMutation } from "./_generated/server";
import {
  AI_WINDOWS,
  aiWindowStart,
  resolveAiLimits,
  type AiLimitScope,
  type AiLimits,
  type AiWindow,
} from "./lib/aiLimits";

// Pinkie provider-call reservation. Internal only: the calling action has already checked consent and identity, and
// the caller is taken from that verified context, never from a client. Every bucket is checked before the first write,
// so a refused reservation changes nothing.

const AI_LIMIT_MESSAGE = "AI usage limit reached";
const GLOBAL_KEY = "global";
const ALL_GUESTS_KEY = "all";
const GUEST_SESSION_ID_MAX_LENGTH = 128;
const GUEST_SESSION_ID_PATTERN = /^[\x21-\x7E]+$/;

// The guest session ID is stored as an indexed key, so it must stay short and printable. Checked before any read.
function isValidGuestSessionId(sessionId: string): boolean {
  return sessionId.length <= GUEST_SESSION_ID_MAX_LENGTH && GUEST_SESSION_ID_PATTERN.test(sessionId);
}

const callerValidator = v.union(
  v.object({ kind: v.literal("account"), userId: v.id("users") }),
  v.object({ kind: v.literal("guest"), sessionId: v.string() })
);

type AiCaller = { kind: "account"; userId: Id<"users"> } | { kind: "guest"; sessionId: string };

type Bucket = { scope: AiLimitScope; key: string };

type PlannedWrite = {
  bucket: Bucket;
  window: AiWindow;
  windowStart: number;
  existing: Doc<"aiUsage"> | null;
};

// Account calls count against global and their own account. Guest calls count against global, the shared guest
// bucket, and their own session, so guests cannot take more than the all-guests caps of the global allowance.
function bucketsFor(caller: AiCaller): Bucket[] {
  const global: Bucket = { scope: "global", key: GLOBAL_KEY };
  if (caller.kind === "account") {
    return [global, { scope: "account", key: caller.userId }];
  }
  return [global, { scope: "allGuests", key: ALL_GUESTS_KEY }, { scope: "guest", key: caller.sessionId }];
}

function limitFor(limits: AiLimits, scope: AiLimitScope, window: AiWindow): number {
  return window === "minute" ? limits[scope].perMinute : limits[scope].perDay;
}

async function findUsage(
  ctx: MutationCtx,
  bucket: Bucket,
  window: AiWindow,
  windowStart: number
): Promise<Doc<"aiUsage"> | null> {
  return await ctx.db
    .query("aiUsage")
    .withIndex("by_scope_key_window", (q) =>
      q.eq("scope", bucket.scope).eq("key", bucket.key).eq("window", window).eq("windowStart", windowStart)
    )
    .first();
}

async function loadLimits(ctx: MutationCtx): Promise<AiLimits> {
  const config = await ctx.db
    .query("appConfig")
    .withIndex("by_key", (q) => q.eq("key", "singleton"))
    .first();
  return resolveAiLimits(config?.aiLimits);
}

export const reserveAiCall = internalMutation({
  args: { caller: callerValidator },
  handler: async (ctx, args): Promise<null> => {
    const { caller } = args;
    if (caller.kind === "guest" && !isValidGuestSessionId(caller.sessionId)) {
      throw new Error("Invalid AI session");
    }

    const now = Date.now();
    const limits = await loadLimits(ctx);

    // Read and check every bucket first. Nothing is written until all of them have room.
    const writes: PlannedWrite[] = [];
    for (const bucket of bucketsFor(caller)) {
      for (const window of AI_WINDOWS) {
        const windowStart = aiWindowStart(window, now);
        const existing = await findUsage(ctx, bucket, window, windowStart);
        if ((existing?.count ?? 0) + 1 > limitFor(limits, bucket.scope, window)) {
          throw new Error(AI_LIMIT_MESSAGE);
        }
        writes.push({ bucket, window, windowStart, existing });
      }
    }

    for (const write of writes) {
      if (write.existing) {
        await ctx.db.patch(write.existing._id, { count: write.existing.count + 1 });
      } else {
        await ctx.db.insert("aiUsage", {
          scope: write.bucket.scope,
          key: write.bucket.key,
          window: write.window,
          windowStart: write.windowStart,
          count: 1,
        });
      }
    }
    return null;
  },
});
