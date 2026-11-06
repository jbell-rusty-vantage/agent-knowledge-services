import {
  type DeclaredUse,
  type ExactUseIngestionReceipt,
  ExactUseAdmissionError,
  type IngestionExecutor,
  type IngestionIntent,
  type UseClassPolicy,
  assertUseAdmissible,
  isKnowledgeError,
} from "@aiengineer/knowledge-db";
import { type KnowledgeApplyPort, refusal } from "@aiengineer/knowledge-host/knowledge-operation";
import {
  type JsonDocument,
  type JsonValue,
  type ProtocolErrorCode,
  digestCanonical,
  originDigest,
} from "@aiengineer/knowledge-operation-protocol";

/**
 * `knowledge.apply` of the AI Engineer binding (moved home from the host's `native-ports.ts`, Sprint OC R5): the
 * knowledge-db `IngestionExecutor` (SV-08 exact-use admission inside the native AI Engineer ingestion transaction). It
 * needs the AI Engineer knowledge database (`KNOWLEDGE_DB_URL`/`POSTGRES_URL` + `SCHEMA_WORKSPACE_DIR`), so the
 * executable builds it and injects it (`HostInjection.apply`); without it `knowledge.apply` answers SCHEMA_UNSUPPORTED.
 */
export const INGESTION_APPLY_CONTRACT = { name: "knowledge-ingestion-intent", version: "v1" } as const;

const ADMISSION_CODES: Readonly<Record<string, ProtocolErrorCode>> = {
  STALE_DECISION: "STALE_DECISION",
  REVIEW_REQUIRED: "REVIEW_REQUIRED",
  EFFECT_CONFLICT: "EFFECT_CONFLICT",
  UNRESOLVED_EFFECT: "UNRESOLVED_EFFECT",
  EXACT_REVISION_UNAVAILABLE: "EXACT_REVISION_UNAVAILABLE",
};

type ApplyInput = Parameters<KnowledgeApplyPort["apply"]>[1];
type Scope = Parameters<KnowledgeApplyPort["apply"]>[0];

/**
 * The checks `apply` and `preview` share, in apply's order, before any native read: the declared use (K08 F9: the
 * envelope's `use`/`audience` or the intent's `declaredUse`, never a silent default; an official or consequential use
 * without `exactUse` refuses REVIEW_REQUIRED). Returns the intent the native executor receives (the declared use
 * carried into it).
 */
function prepareIntent(
  envelope: ApplyInput["envelope"],
  requested: JsonDocument,
  useClasses: UseClassPolicy | undefined,
  operation: "knowledge.apply" | "knowledge.plan_preview",
): {
  readonly intent: JsonDocument;
  readonly exactUse: Record<string, unknown> | undefined;
  readonly context: Record<string, unknown> | undefined;
} {
  let intent = requested;
  const document = requested as Record<string, unknown> | null;
  const exactUse = document?.exactUse as Record<string, unknown> | undefined;
  const context = document?.context as Record<string, unknown> | undefined;
  // The declared use is explicit, never a silent default: the envelope's `use`/`audience` (K01), else the intent's
  // own `declaredUse`; both present and different refuses; neither, under a use-class policy, refuses.
  const fromEnvelope: DeclaredUse | undefined =
    envelope.use !== undefined && envelope.audience !== undefined
      ? { use: envelope.use, audience: envelope.audience }
      : undefined;
  const fromIntent = (document?.declaredUse as DeclaredUse | undefined) ?? undefined;
  if (
    fromEnvelope !== undefined &&
    fromIntent !== undefined &&
    (fromEnvelope.use !== fromIntent.use || fromEnvelope.audience !== fromIntent.audience)
  ) {
    throw refusal("SCHEMA_UNSUPPORTED", "the envelope and the intent declare different uses", {
      dispatchId: envelope.dispatchId,
    });
  }
  const declaredUse = fromEnvelope ?? fromIntent;
  if (useClasses !== undefined && declaredUse === undefined) {
    throw refusal(
      "SCHEMA_UNSUPPORTED",
      `${operation} must declare its use (envelope use/audience or intent declaredUse); there is no default`,
      { dispatchId: envelope.dispatchId },
      { useClassRegistry: useClasses.registry.id },
    );
  }
  if (declaredUse !== undefined && document !== null && typeof document === "object") {
    // The native executor classifies the intent itself: carry the declared use into it (bound bytes are plan-level).
    intent = { ...document, declaredUse } as unknown as JsonDocument;
  }
  if (useClasses !== undefined && document !== null && typeof document === "object") {
    const classified = { ...document, declaredUse } as unknown as IngestionIntent;
    try {
      assertUseAdmissible(classified, useClasses);
    } catch (error) {
      if (isKnowledgeError(error) && error.code === "REVIEW_REQUIRED")
        throw refusal("REVIEW_REQUIRED", error.message, { dispatchId: envelope.dispatchId });
      throw error;
    }
  }
  return { intent, exactUse, context };
}

/** The intent's originating origin is the bound effect's (canonical origin digest equality; malformed is unequal). */
function sameOrigin(exactUse: Record<string, unknown>, effect: NonNullable<ApplyInput["envelope"]["effect"]>): boolean {
  try {
    return originDigest(exactUse.originatingOrigin as never) === originDigest(effect.originatingOrigin);
  } catch {
    return false;
  }
}

/** A native executor failure as a typed K01 refusal (shared by `apply` and `preview`); other errors pass through. */
function nativeRefusal(error: unknown, correlation: { dispatchId: string; effectKey: string | null }): unknown {
  if (error instanceof ExactUseAdmissionError) {
    return refusal(ADMISSION_CODES[error.code] ?? "EFFECT_CONFLICT", error.message, correlation);
  }
  if (isKnowledgeError(error)) {
    const code: ProtocolErrorCode =
      ADMISSION_CODES[error.code] ??
      (error.exit === 1
        ? "SCHEMA_UNSUPPORTED"
        : error.code === "DB_UNAVAILABLE"
          ? "CAPABILITY_UNAVAILABLE"
          : "INTERNAL");
    return refusal(code, `${error.code}: ${error.message}`, correlation);
  }
  return error;
}

/**
 * K08 F9 at the K01 boundary: the effect's use comes from the K01 envelope (`use`/`audience`) or the intent's
 * `declaredUse`; there is no default. An official or consequential use without `exactUse` refuses REVIEW_REQUIRED
 * before any read or write. With the executor's `preview`, the port also serves the read-only `knowledge.plan_preview`.
 */
export function createIngestionApplyPort(
  ingestion: Pick<IngestionExecutor, "apply"> &
    Partial<Pick<IngestionExecutor, "committedExactUseReceipt" | "preview">>,
  useClasses?: UseClassPolicy,
): KnowledgeApplyPort {
  const committed = ingestion.committedExactUseReceipt?.bind(ingestion);
  const preview = ingestion.preview?.bind(ingestion);
  return {
    nativeContract: INGESTION_APPLY_CONTRACT,
    async apply(scope, { envelope, intent: requested, journaled }) {
      const effect = envelope.effect;
      const { intent, exactUse, context } = prepareIntent(envelope, requested, useClasses, "knowledge.apply");
      if (effect === null || exactUse === undefined) {
        throw refusal("SCHEMA_UNSUPPORTED", "knowledge.apply over K01 takes an exact-use ingestion intent", {
          dispatchId: envelope.dispatchId,
        });
      }
      const correlation = { dispatchId: envelope.dispatchId, effectKey: effect.effectKey };
      if (context?.tenantId !== scope.tenant) {
        throw refusal("SCOPE_DENIED", "the intent names another tenant", correlation);
      }
      if (exactUse.effectKey !== effect.effectKey) {
        throw refusal("EFFECT_CONFLICT", "the intent's exact-use effect key differs from the envelope", correlation);
      }
      // Integrator decision 2026-10-25: the envelope carries the plan-level bound digest the use decision binds; the
      // native executor recomputes it from the plan and refuses EFFECT_CONFLICT when the intent's differs.
      if (exactUse.boundEffectDigest !== effect.boundEffectDigest) {
        throw refusal(
          "EFFECT_CONFLICT",
          "the envelope bound digest differs from the intent's exact-use digest",
          correlation,
        );
      }
      if (!sameOrigin(exactUse, effect)) {
        throw refusal("EFFECT_CONFLICT", "the intent's originating origin differs from the bound effect", correlation);
      }
      let receipt: ExactUseIngestionReceipt;
      try {
        // WI-05: the native transaction stamps its commit with this (journaled) K01 dispatch.
        receipt = (await ingestion.apply(
          intent,
          journaled ? { effectDispatchId: journaled.dispatchId } : {},
        )) as ExactUseIngestionReceipt;
      } catch (error) {
        throw nativeRefusal(error, correlation);
      }
      return nativeApplied(scope, receipt);
    },
    ...(committed === undefined
      ? {}
      : {
          /**
           * WI-05 read-back of the committed native receipt the commit stamp names (`{receiptId}`): exactly what
           * `apply` returned for the original dispatch. Read-only; a receipt that does not bind the committed effect
           * receipt throws (the effect stays unresolved).
           */
          async reconstruct(scope, { envelope, commit }) {
            const effectKey = envelope.effect?.effectKey;
            const receiptId = (commit.nativeRef as { receiptId?: unknown }).receiptId;
            if (effectKey === undefined || typeof receiptId !== "string") {
              throw new Error("NATIVE_REF_INVALID: the commit stamp names no ingestion receipt");
            }
            return nativeApplied(scope, await committed({ tenantId: scope.tenant, effectKey, receiptId }));
          },
        }),
    ...(preview === undefined
      ? {}
      : {
          /**
           * Sprint OC `knowledge.plan_preview`: the same checks as `apply` except the decision fields (the intent's
           * `exactUse.useDecisionId`/`boundEffectDigest`/`processedEpoch`/`normalizedValuesDigest` and the envelope's
           * `effect.boundEffectDigest` are ignored), then the executor's read-only planner. Writes nothing.
           */
          async preview(scope, { envelope, intent: requested }) {
            const effect = envelope.effect;
            const { intent, exactUse, context } = prepareIntent(
              envelope,
              requested,
              useClasses,
              "knowledge.plan_preview",
            );
            if (exactUse === undefined) {
              throw refusal(
                "SCHEMA_UNSUPPORTED",
                "knowledge.plan_preview takes an exact-use ingestion intent (exactUse.effectKey and originatingOrigin)",
                { dispatchId: envelope.dispatchId },
              );
            }
            const named = typeof exactUse.effectKey === "string" ? exactUse.effectKey : null;
            const correlation = { dispatchId: envelope.dispatchId, effectKey: effect?.effectKey ?? named };
            if (context?.tenantId !== scope.tenant) {
              throw refusal("SCOPE_DENIED", "the intent names another tenant", correlation);
            }
            if (effect !== null) {
              if (exactUse.effectKey !== effect.effectKey) {
                throw refusal(
                  "EFFECT_CONFLICT",
                  "the intent's exact-use effect key differs from the envelope",
                  correlation,
                );
              }
              if (!sameOrigin(exactUse, effect)) {
                throw refusal(
                  "EFFECT_CONFLICT",
                  "the intent's originating origin differs from the bound effect",
                  correlation,
                );
              }
            }
            try {
              return await preview(intent);
            } catch (error) {
              throw nativeRefusal(error, correlation);
            }
          },
        }),
  };
}

/** The K01 view of an exact-use ingestion receipt (shared by `apply` and the WI-05 read-back, so they cannot drift). */
function nativeApplied(scope: Scope, receipt: ExactUseIngestionReceipt) {
  const admission = receipt.admission;
  return {
    outcome: receipt.outcome,
    nativeReceiptRef: {
      kind: "receipt",
      id: receipt.receiptId,
      version: "knowledge-ingestion-receipt.v1",
      digest: admission?.effectReceiptDigest ?? digestCanonical(receipt as unknown as JsonValue),
      tenant: scope.tenant,
      binding: scope.binding,
    },
    affectedRefs: [],
    concurrencyToken: { before: String(receipt.head.before), after: String(receipt.head.after) },
    processedRevocationEpoch: admission?.authoritativeEpoch ?? 0,
    details: {
      receiptId: receipt.receiptId,
      outcome: receipt.outcome,
      duplicateOf: receipt.duplicateOf,
      admission: (admission ?? null) as unknown as JsonDocument,
    },
  } satisfies Awaited<ReturnType<KnowledgeApplyPort["apply"]>>;
}
