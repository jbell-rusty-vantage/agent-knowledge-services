import { admissionErrorCode } from "@aiengineer/knowledge-db";
import { type KnowledgeApplyPort, refusal } from "@aiengineer/knowledge-host/knowledge-operation";
import type { OperationEnvelope, ProtocolErrorCode } from "@aiengineer/knowledge-operation-protocol";
import { z } from "zod";

/**
 * `knowledge.apply` of the Biotech graph binding over K01 (moved home from the host's `native-ports.ts`, Sprint OC R5).
 */
export const BIOTECH_APPLY_CONTRACT = { name: "biotech-knowledge-apply", version: "v1" } as const;

/** The `knowledge.apply` request a Biotech binding takes over K01 (`biotech-knowledge-apply/v1`, inline). */
export const BiotechApplyRequestSchema = z.strictObject({
  schemaVersion: z.literal("biotech-knowledge-apply.v1"),
  /** The exact biotech-knowledge-intent.v2 object; its JCS bytes are the native payload the decision binds. */
  intent: z.record(z.string(), z.unknown()),
  exactUse: z.strictObject({
    useDecisionId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/),
    processedEpoch: z.int().min(0),
    /** Required (component 2.4.0, R1 F2): the decision's normalized-values digest, never null. */
    normalizedValuesDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  }),
});

export interface BiotechAdmissionPort {
  admitExactUse(
    scope: Parameters<KnowledgeApplyPort["apply"]>[0],
    request: {
      effectKey: string;
      useDecisionId: string;
      intent: Record<string, unknown>;
      processedEpoch: number;
      normalizedValuesDigest: string;
      /** WI-05: the journaled K01 dispatch the admission transaction stamps its native commit with. */
      k01DispatchId?: string;
      originatingOrigin?: OperationEnvelope["effect"] extends infer E
        ? E extends { originatingOrigin: infer O }
          ? O
          : never
        : never;
    },
  ): Promise<
    | {
        outcome: "admitted";
        authoritativeEpoch: number;
        receipt: {
          state: string;
          dispatchId: string;
          payloadDigest: string;
          boundEffectDigest: string;
          revocationEpoch: number;
          markerScheme: string | null;
          expectedMarkerDigest: string | null;
          useDecision: { id: string; digest: string };
        };
      }
    | { outcome: "held" | "rejected"; reason: string; authoritativeEpoch: number; receipt: null }
  >;
  /** WI-05 read-back of a committed admission from its outbox row (read-only); `null` when absent or another effect's. */
  admitted?(
    scope: Parameters<KnowledgeApplyPort["apply"]>[0],
    input: { effectKey: string; dispatchId: string },
  ): Promise<{ authoritativeEpoch: number; receipt: AdmittedReceipt } | null>;
}

type AdmittedReceipt = {
  state: string;
  dispatchId: string;
  payloadDigest: string;
  boundEffectDigest: string;
  revocationEpoch: number;
  markerScheme: string | null;
  expectedMarkerDigest: string | null;
  useDecision: { id: string; digest: string };
};

/**
 * `knowledge.apply` on the Biotech graph binding (K06): exact-use admission + outbox enqueue in ONE PostgreSQL
 * transaction (`BiotechGraphAdmission`). The answer is a receipt with outcome `pending_dispatch`: admitted and durably
 * enqueued, never `applied` until the BKS acknowledgment verifies (the host keeps the effect unresolved).
 */
export function createBiotechApplyPort(
  admission: BiotechAdmissionPort,
  boundDigestOf: (
    intent: Record<string, unknown>,
    origin: NonNullable<OperationEnvelope["effect"]>["originatingOrigin"],
  ) => string,
): KnowledgeApplyPort {
  return {
    nativeContract: BIOTECH_APPLY_CONTRACT,
    async apply(scope, { envelope, intent, journaled }) {
      const effect = envelope.effect;
      const correlation = { dispatchId: envelope.dispatchId, effectKey: effect?.effectKey ?? null };
      const parsed = BiotechApplyRequestSchema.safeParse(intent);
      if (effect === null || !parsed.success) {
        throw refusal(
          "SCHEMA_UNSUPPORTED",
          "knowledge.apply on biotech-graph takes biotech-knowledge-apply.v1",
          correlation,
        );
      }
      const request = parsed.data;
      let bound: string;
      try {
        bound = boundDigestOf(request.intent, effect.originatingOrigin);
      } catch (error) {
        throw refusal("SCHEMA_UNSUPPORTED", error instanceof Error ? error.message : "intent unsupported", correlation);
      }
      if (bound !== effect.boundEffectDigest) {
        throw refusal("EFFECT_CONFLICT", "the envelope bound digest does not bind this intent and origin", correlation);
      }
      let result: Awaited<ReturnType<BiotechAdmissionPort["admitExactUse"]>>;
      try {
        result = await admission.admitExactUse(scope, {
          effectKey: effect.effectKey,
          useDecisionId: request.exactUse.useDecisionId,
          intent: request.intent,
          processedEpoch: request.exactUse.processedEpoch,
          normalizedValuesDigest: request.exactUse.normalizedValuesDigest,
          ...(journaled ? { k01DispatchId: journaled.dispatchId } : {}),
          originatingOrigin: effect.originatingOrigin,
        });
      } catch (error) {
        // Typed binding refusals (the admission transaction rolled back: nothing bound or enqueued).
        // Only the admission's own typed errors (raised before its commit; the transaction rolled back) are typed
        // refusals. A raw driver/connection error (`ECONNRESET`, a COMMIT that may be in flight) or an unclassified
        // component failure stays untyped: its commit outcome is unknown.
        const code = (error as { code?: unknown } | null)?.code;
        const name = (error as { name?: unknown } | null)?.name;
        const typed =
          (name === "BiotechAdmissionError" || name === "ComponentError" || name === "ReportBindingError") &&
          code !== "COMPONENT_FAILURE";
        if (typed && typeof code === "string" && /^[A-Z][A-Z_]+$/.test(code)) {
          const k01: ProtocolErrorCode =
            code === "REPORT_BINDING_MISMATCH" || code === "EFFECT_CONFLICT" || code === "DISPATCH_CONFLICT"
              ? "EFFECT_CONFLICT"
              : code === "DECISION_NOT_FOUND"
                ? "UNRESOLVED_EFFECT"
                : "SCHEMA_UNSUPPORTED";
          throw refusal(k01, error instanceof Error ? error.message : code, correlation, { nativeCode: code });
        }
        throw error;
      }
      if (result.outcome !== "admitted") {
        throw refusal(admissionErrorCode(result.reason), `${result.outcome}: ${result.reason}`, correlation, {
          outcome: result.outcome,
          reason: result.reason,
          authoritativeEpoch: result.authoritativeEpoch,
        });
      }
      return nativeApplied(scope, result.authoritativeEpoch, result.receipt);
    },
    ...(admission.admitted === undefined
      ? {}
      : {
          /**
           * WI-05 read-back: the admission receipt of the committed effect from the outbox row the commit stamp names
           * (`{outboxDispatchId}`), exactly what `apply` answered for the original dispatch. Read-only: no admission,
           * no enqueue. The bound digest must be the journaled dispatch's; otherwise it throws (unresolved).
           */
          async reconstruct(scope, { envelope, commit }) {
            const effect = envelope.effect;
            const dispatchId = (commit.nativeRef as { outboxDispatchId?: unknown }).outboxDispatchId;
            if (effect === null || typeof dispatchId !== "string") {
              throw new Error("NATIVE_REF_INVALID: the commit stamp names no outbox dispatch");
            }
            const admitted = await admission.admitted?.(scope, { effectKey: effect.effectKey, dispatchId });
            if (admitted == null || admitted.receipt.boundEffectDigest !== effect.boundEffectDigest) {
              throw new Error("ADMISSION_NOT_FOUND: no committed outbox row binds this effect");
            }
            return nativeApplied(scope, admitted.authoritativeEpoch, admitted.receipt);
          },
        }),
  };
}

/** The K01 view of an admitted, enqueued effect (shared by `apply` and the WI-05 read-back, so they cannot drift). */
function nativeApplied(
  scope: Parameters<KnowledgeApplyPort["apply"]>[0],
  authoritativeEpoch: number,
  receipt: AdmittedReceipt,
) {
  return {
    outcome: "pending_dispatch",
    nativeReceiptRef: {
      kind: "receipt",
      id: receipt.dispatchId,
      version: "knowledge-verification.dispatch_outbox.v1",
      digest: receipt.payloadDigest,
      tenant: scope.tenant,
      binding: scope.binding,
    },
    affectedRefs: [],
    concurrencyToken: { before: null, after: null },
    processedRevocationEpoch: authoritativeEpoch,
    details: {
      receiptState: receipt.state,
      dispatchId: receipt.dispatchId,
      payloadDigest: receipt.payloadDigest,
      revocationEpoch: receipt.revocationEpoch,
      markerScheme: receipt.markerScheme,
      expectedMarkerDigest: receipt.expectedMarkerDigest,
      useDecisionId: receipt.useDecision.id,
    },
  } satisfies Awaited<ReturnType<KnowledgeApplyPort["apply"]>>;
}
