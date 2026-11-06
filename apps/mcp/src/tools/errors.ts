import { transportProblem, type ResourceReadResult } from "@aiengineer/knowledge-host";
type ResourceReadFailureCode = Extract<ResourceReadResult<unknown>, { ok: false }>["failure"]["code"];

export function toolError(
  code:
    | "FORBIDDEN"
    | "ACTOR_MISMATCH"
    | "CAPABILITY_NOT_ADMITTED"
    | "RESOURCE_ID_REQUIRED"
    | ResourceReadFailureCode
    | ReturnType<typeof transportProblem>["code"],
  details?: unknown,
) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ code }) }],
    ...(details === undefined ? {} : { structuredContent: details as Record<string, unknown> }),
    isError: true,
  };
}

/**
 * Returns a shared read result as MCP content. A failure carries the same problem
 * code the API route returns; a missing capability is CAPABILITY_NOT_ADMITTED.
 */
export function readToolResult<T>(result: ResourceReadResult<T>) {
  if (!result.ok)
    return toolError(result.failure.reason === "unavailable" ? "CAPABILITY_NOT_ADMITTED" : result.failure.code);
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result.value) }],
    structuredContent: result.value as unknown as Record<string, unknown>,
  };
}

/**
 * Runs a shared read and maps an uncaught failure to the API error handler's problem
 * code, so no internal message reaches the MCP caller.
 */
export async function inProcessRead<T>(read: () => Promise<ResourceReadResult<T>>) {
  let result: ResourceReadResult<T>;
  try {
    result = await read();
  } catch (error) {
    return toolError(transportProblem(error).code);
  }
  return readToolResult(result);
}

/** Runs canonical retrieval in process with the API route's admission and failure codes. */
