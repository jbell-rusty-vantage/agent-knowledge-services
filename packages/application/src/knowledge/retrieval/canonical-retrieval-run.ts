import {
  RetrievalRunInputSchema,
  type AcceptedOperation,
  type MutationEnvelope,
} from "@aiengineer/knowledge-contracts";
import type { LocalApiIdentity } from "../../access/api-access.js";
import type { KnowledgeOperationPort } from "../../operations/surface.js";
import { isRetrievalUnsupportedError, type CanonicalRetrievalExecutorPort } from "./canonical-retrieval-executor.js";

export type CanonicalRetrievalRunSubmission =
  | { readonly ok: true; readonly accepted: AcceptedOperation }
  | { readonly ok: false; readonly reason: "retrieval_version_required" | "executor_unavailable" };

/**
 * Admits and synchronously executes one canonical retrieval run. Callers have
 * already authorized the identity for `operation.submit` on the envelope tenant and
 * bound the envelope actor to that identity; `retrieval_run` stays API-owned kind semantics.
 */
export async function submitCanonicalRetrievalRun(
  ports: {
    readonly operations: Pick<KnowledgeOperationPort, "submit">;
    readonly executor?: CanonicalRetrievalExecutorPort;
  },
  input: { readonly envelope: MutationEnvelope; readonly identity: LocalApiIdentity; readonly origin: string },
): Promise<CanonicalRetrievalRunSubmission> {
  const { envelope } = input;
  RetrievalRunInputSchema.parse(envelope.input);
  if (envelope.expectedVersions.retrieval !== "v1") return { ok: false, reason: "retrieval_version_required" };
  if (!ports.executor) return { ok: false, reason: "executor_unavailable" };
  const accepted = await ports.operations.submit("retrieval_run", envelope, input.origin);
  await ports.executor.execute(envelope, input.identity);
  return { ok: true, accepted };
}

/**
 * Problem classification for a failed retrieval execution, shared by the API error
 * handler and MCP. Unclassified failures remain internal errors in each transport.
 */
export function retrievalExecutionProblem(
  error: unknown,
):
  | { readonly status: 422; readonly code: "RETRIEVAL_CAPABILITY_UNSUPPORTED"; readonly response: unknown }
  | { readonly status: 409 | 503; readonly code: "CONFLICT" | "INTERNAL_ERROR" }
  | undefined {
  if (isRetrievalUnsupportedError(error))
    return { status: 422, code: "RETRIEVAL_CAPABILITY_UNSUPPORTED", response: error.response };
  const message = error instanceof Error ? error.message : "";
  if (message.startsWith("RETRIEVAL_") || message.startsWith("NO_ACTIVE_PUBLISHED_"))
    return { status: 409, code: "CONFLICT" };
  if (message.startsWith("AI_GATEWAY_")) return { status: 503, code: "INTERNAL_ERROR" };
  return undefined;
}
