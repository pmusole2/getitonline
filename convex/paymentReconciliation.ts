import { v, type Infer } from "convex/values";
import type { RegisteredAction } from "convex/server";
import { api, internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { action, internalAction, query } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { createLencoAdapter, isValidProviderId, type LencoFetch } from "./lib/lencoAdapter";
import {
  isValidCheckoutReference,
  isValidTopUpReference,
  isValidWithdrawalReference,
} from "./lib/providerOperationContracts";
import {
  projectRecoveryStatus,
  recoverySelectorValidator,
  recoveryStatusValidator,
  type RecoveryStatus,
  type RecoverySelector,
} from "./lib/paymentReconciliation";
import type { ReceiptAcquisition } from "./lib/providerSettlementContracts";
import { selectOwnedOperation } from "./paymentReconciliationData";

export const getStatus = query({
  args: recoverySelectorValidator,
  returns: recoveryStatusValidator,
  handler: async (ctx, args): Promise<RecoveryStatus> => {
    const selected = await selectOwnedOperation(ctx, args);
    return selected?.result === "found" ? await projectRecoveryStatus(ctx, selected.operation) : selected;
  },
});

export type ReconciliationDependencies = { env: () => Record<string, string | undefined>; fetchImpl?: LencoFetch };
type ReconciliationCtx = Pick<ActionCtx, "runQuery" | "runMutation">;

const lookupOutcomeValidator = v.union(
  v.object({ result: v.literal("not_found") }),
  v.object({ result: v.literal("ineligible") }),
  v.object({ result: v.literal("unresolved") }),
  v.object({
    result: v.literal("processed"),
    application: v.union(v.literal("pending"), v.literal("applied"), v.literal("review"), v.literal("unsupported")),
  })
);
type LookupOutcome = Infer<typeof lookupOutcomeValidator>;

// All wrappers consume this workflow directly (no nested action or extra retry).
// The actual lookup is frozen intent state, never a caller/inbox supplied selector.
async function reconcileOperation(
  ctx: ReconciliationCtx,
  operation: Doc<"paymentOperations">,
  dependencies: ReconciliationDependencies
): Promise<LookupOutcome> {
  if (operation.kind === "wallet_purchase") {
    return { result: "ineligible" };
  }
  const validReference =
    operation.kind === "withdrawal_transfer"
      ? isValidWithdrawalReference(operation.providerReference)
      : operation.kind === "checkout_collection"
        ? isValidCheckoutReference(operation.providerReference)
        : isValidTopUpReference(operation.providerReference);
  if (
    !validReference ||
    !Number.isFinite(operation.attemptedAt) ||
    (operation.attemptedAt ?? -1) < 0 ||
    (operation.providerId !== undefined && !isValidProviderId(operation.providerId))
  ) {
    return { result: "ineligible" };
  }
  const lookup =
    operation.providerId === undefined
      ? { kind: "reference" as const, reference: operation.providerReference }
      : { kind: "provider_id" as const, providerId: operation.providerId };
  const env = dependencies.env();
  const adapter = createLencoAdapter(
    {
      apiKey: env["LENCO_API_KEY"] ?? "",
      ...(env["LENCO_BASE_URL"] === undefined ? {} : { baseUrl: env["LENCO_BASE_URL"] }),
    },
    dependencies.fetchImpl
  );
  const receipt =
    operation.kind === "withdrawal_transfer"
      ? lookup.kind === "reference"
        ? await adapter.getTransferByReference(lookup.reference)
        : await adapter.getTransferById(lookup.providerId)
      : lookup.kind === "reference"
        ? await adapter.getCollectionByReference(lookup.reference)
        : await adapter.getCollectionById(lookup.providerId);
  if (!receipt.ok) {
    return { result: "unresolved" };
  }
  const acquisition: ReceiptAcquisition = { kind: "status_get", lookup };
  const settled = await ctx.runMutation(internal.providerSettlement.settleProviderReceipt, {
    operationId: operation._id,
    receipt: receipt.value,
    acquisition,
  });
  return { result: "processed", application: settled.application };
}

export function createRefreshAction(
  dependencies: ReconciliationDependencies
): RegisteredAction<"public", RecoverySelector, Promise<RecoveryStatus>> {
  return action({
    args: recoverySelectorValidator,
    returns: recoveryStatusValidator,
    handler: async (ctx, args): Promise<RecoveryStatus> => {
      // Authenticate and select before even reading managed provider config.
      const selected = await ctx.runQuery(internal.paymentReconciliationData.getOwnedOperation, args);
      if (selected?.result !== "found") {
        return selected;
      }
      await reconcileOperation(ctx, selected.operation, dependencies);
      // Owed settlement precedes this fresh access/ownership check. Loss of
      // access during GET denies the private response, not the owed settlement.
      const current = await ctx.runQuery(api.paymentReconciliation.getStatus, { operationId: selected.operation._id });
      return current;
    },
  });
}

async function reconcileInbox(
  ctx: ReconciliationCtx,
  inboxId: Doc<"lencoWebhookInbox">["_id"],
  dependencies: ReconciliationDependencies
): Promise<LookupOutcome> {
  const work = await ctx.runQuery(internal.paymentReconciliationData.getInboxWork, { inboxId });
  if (work === null) {
    return { result: "ineligible" };
  }
  const binding = {
    inboxId: work.inbox._id,
    bodyDigest: work.inbox.bodyDigest,
    operationId: work.operation._id,
    eventKind: work.inbox.eventKind,
    classification: work.inbox.classification,
  };
  const outcome = await reconcileOperation(ctx, work.operation, dependencies);
  if (outcome.result === "processed") {
    await ctx.runMutation(internal.paymentReconciliationData.recordLookupResult, {
      ...binding,
      result: outcome.application,
    });
  }
  return outcome;
}

// Injectable internal builders keep transport-only mocks and the exact same
// registered argument contracts as the production actor-free action wrappers.
export function createReconcileOperationAction(
  dependencies: ReconciliationDependencies
): RegisteredAction<"internal", { operationId: Doc<"paymentOperations">["_id"] }, Promise<LookupOutcome>> {
  return internalAction({
    args: { operationId: v.id("paymentOperations") },
    returns: lookupOutcomeValidator,
    handler: async (ctx, args): Promise<LookupOutcome> => {
      const operation = await ctx.runQuery(internal.paymentReconciliationData.getOperation, args);
      return operation === null ? { result: "not_found" } : await reconcileOperation(ctx, operation, dependencies);
    },
  });
}

export function createReconcileInboxAction(
  dependencies: ReconciliationDependencies
): RegisteredAction<"internal", { inboxId: Doc<"lencoWebhookInbox">["_id"] }, Promise<LookupOutcome>> {
  return internalAction({
    args: { inboxId: v.id("lencoWebhookInbox") },
    returns: lookupOutcomeValidator,
    handler: async (ctx, args): Promise<LookupOutcome> => await reconcileInbox(ctx, args.inboxId, dependencies),
  });
}

const runtimeDependencies: ReconciliationDependencies = {
  env: () => ({ LENCO_API_KEY: process.env.LENCO_API_KEY, LENCO_BASE_URL: process.env.LENCO_BASE_URL }),
};

export const refresh = createRefreshAction(runtimeDependencies);
export const reconcileStoredOperation = createReconcileOperationAction(runtimeDependencies);
export const reconcileAssociatedInbox = createReconcileInboxAction(runtimeDependencies);
