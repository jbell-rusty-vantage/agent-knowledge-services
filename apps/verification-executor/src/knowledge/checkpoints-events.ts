import { z } from "zod";
import type { CheckpointPendingOperation } from "@aiengineer/knowledge-contracts";
import { canonicalizeJson, sha256Digest } from "@aiengineer/knowledge-verification";

const Core = { callId: z.string().min(1), input: z.unknown() };
const Action = z.discriminatedUnion("kind", [
  z.object({ ...Core, kind: z.literal("tool-call"), toolName: z.string().min(1) }),
  z.object({ ...Core, kind: z.literal("subagent-call"), subagentName: z.string().min(1), nodeId: z.string().min(1) }),
  z.object({
    ...Core,
    kind: z.literal("remote-agent-call"),
    remoteAgentName: z.string().min(1),
    nodeId: z.string().min(1),
  }),
  z.object({ ...Core, kind: z.literal("load-skill") }),
]);

export function checkpointRequestedOperations(data: unknown): CheckpointPendingOperation[] {
  const actions = z.object({ actions: z.array(Action).max(1000) }).parse(data).actions;
  return actions.flatMap((action) => {
    if (action.kind === "load-skill") return [];
    const request = action.kind === "tool-call" ? { toolName: action.toolName, input: action.input } : action;
    return [
      {
        owner: "external_tool" as const,
        operationId: action.callId,
        requestDigest: sha256Digest(canonicalizeJson(request)),
      },
    ];
  });
}

/** A settled child turn can leave its reusable session parked; a background dispatch is still pending. */
export function checkpointTerminalOutcome(data: unknown): "succeeded" | "failed" | "cancelled" | undefined {
  const event = z
    .object({
      status: z.string(),
      result: z
        .object({
          kind: z.string(),
          callId: z.string(),
          isError: z.boolean().optional(),
          output: z.unknown().optional(),
          origin: z.string().optional(),
          backgroundTask: z.object({ status: z.string() }).optional(),
          outcome: z
            .object({
              kind: z.enum(["parked", "terminal"]),
              result: z.object({ kind: z.enum(["succeeded", "failed", "cancelled"]) }),
            })
            .optional(),
        })
        .passthrough(),
    })
    .safeParse(data);
  if (!event.success) return undefined;
  const { result, status } = event.data;
  if (result.backgroundTask?.status === "working") return undefined;
  if (result.kind === "subagent-result") {
    if (result.origin === "dispatch" && result.isError) return "failed";
    return result.outcome?.result.kind;
  }
  if (result.kind !== "tool-result" && result.kind !== "load-skill-result") return undefined;
  if (
    status === "failed" ||
    status === "rejected" ||
    result.isError ||
    (result.output && typeof result.output === "object" && "isError" in result.output && result.output.isError === true)
  )
    return "failed";
  return status === "completed" ? "succeeded" : undefined;
}
