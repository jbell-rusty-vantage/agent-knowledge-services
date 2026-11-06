import type { KnowledgeClient } from "@aiengineer/knowledge-client";
import {
  VerificationBenchmarkComparisonOperationResultSchema,
  VerificationBenchmarkOperationResultSchema,
  type OperationContext,
} from "@aiengineer/knowledge-contracts";

/** Operation kinds whose terminal success receipt `--wait` knows how to interpret. */
export const WAITABLE_VERIFICATION_RECEIPTS = Object.freeze({
  verification_capture: "register_and_admit.succeeded",
  verification_extraction: "verify_and_register.succeeded",
  verification_replay: "hydrate_and_recompute.succeeded",
  verification_benchmark: "replay_recorded_and_register.succeeded",
  verification_benchmark_compare: "compare_registered_and_publish.succeeded",
} as const);
export type WaitableVerificationKind = keyof typeof WAITABLE_VERIFICATION_RECEIPTS;

export async function waitForVerification(
  client: Pick<KnowledgeClient, "getVerificationOperation" | "getReceipt">,
  operationId: string,
  context: Pick<OperationContext, "tenantId" | "correlationId">,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const operation = await client.getVerificationOperation(operationId, context);
    if (operation.state === "succeeded") {
      const expectedKind = WAITABLE_VERIFICATION_RECEIPTS[operation.kind as WaitableVerificationKind];
      if (!expectedKind)
        throw new Error(
          `VERIFICATION_WAIT_UNSUPPORTED_KIND:${operation.kind} (poll with \`verify status\` and read the kind-specific result instead)`,
        );
      for (const id of [...operation.receiptIds].reverse()) {
        const receipt = await client.getReceipt(id, context);
        if (
          receipt.operationId !== operationId ||
          receipt.receiptKind !== expectedKind ||
          receipt.outcome !== "succeeded"
        )
          continue;
        const body = receipt.body as Record<string, unknown>;
        const output = body?.output as Record<string, unknown> | undefined;
        if (operation.kind === "verification_benchmark_compare") {
          const comparison = VerificationBenchmarkComparisonOperationResultSchema.parse(output);
          return {
            operationId,
            state: operation.state,
            comparison,
            receiptId: id,
            exitCode: comparison.engineeringGateOutcome === "fail" ? 1 : 0,
          };
        }
        if (operation.kind === "verification_benchmark")
          return {
            operationId,
            state: operation.state,
            benchmark: VerificationBenchmarkOperationResultSchema.parse(output),
            receiptId: id,
            exitCode: 0,
          };
        const result = output?.result as Record<string, unknown> | undefined;
        const qualityPassed = operation.kind === "verification_capture" ? true : result?.valid;
        if (typeof qualityPassed !== "boolean") throw new Error("VERIFICATION_RESULT_INVALID");
        return { operationId, state: operation.state, qualityPassed, receiptId: id, exitCode: qualityPassed ? 0 : 1 };
      }
      throw new Error("VERIFICATION_SUCCESS_RECEIPT_REQUIRED");
    }
    if (["failed", "cancelled", "quarantined"].includes(operation.state))
      throw new Error(`VERIFICATION_OPERATION_${operation.state.toUpperCase()}`);
    if (operation.state === "needs_review")
      return { operationId, state: operation.state, qualityPassed: false, exitCode: 1 };
    await new Promise((resolve) => setTimeout(resolve, Math.min(250, Math.max(0, deadline - Date.now()))));
  }
  throw new Error("VERIFICATION_WAIT_TIMEOUT");
}
