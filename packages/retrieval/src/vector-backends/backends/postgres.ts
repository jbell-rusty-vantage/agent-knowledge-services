import {
  type VectorSearchBackend,
  type VectorSearchCandidate,
  type VectorSearchRequest,
  VectorBackendError,
  validateEmbedding,
  validateSearchLimit,
} from "../types.js";

export interface PostgresRpcResult {
  readonly data: unknown;
  readonly error: null | {
    readonly message?: string;
    readonly code?: string;
    readonly details?: string;
  };
}

export interface PostgresRpcClient {
  rpc(functionName: string, parameters: Readonly<Record<string, unknown>>): PromiseLike<PostgresRpcResult>;
}

/** Authoritative pgvector adapter. Tenant authorization is enforced by the RPC's session context and RLS. */
export class PostgresVectorSearchBackend implements VectorSearchBackend {
  constructor(
    private readonly client: PostgresRpcClient,
    private readonly assertTenantContext?: (tenantId: string) => void | Promise<void>,
  ) {}

  async search(request: VectorSearchRequest): Promise<readonly VectorSearchCandidate[]> {
    validateEmbedding(request.embedding);
    validateSearchLimit(request.limit);
    await this.assertTenantContext?.(request.tenantId);
    const result = await this.client.rpc("search_knowledge_1536", {
      p_vector_space_version_id: request.vectorSpaceVersionId,
      p_query: serializeHalfVector(request.embedding),
      p_limit: request.limit,
    });
    if (result.error !== null) {
      throw new VectorBackendError(
        result.error.code ?? "POSTGRES_RPC_FAILED",
        result.error.message ?? "Postgres vector search failed",
        result.error,
      );
    }
    if (!Array.isArray(result.data))
      throw new VectorBackendError("INVALID_RPC_RESPONSE", "Postgres vector search returned a non-array response");
    return Object.freeze(result.data.map(parseCandidate));
  }
}

export function serializeHalfVector(embedding: readonly number[]): string {
  validateEmbedding(embedding);
  return `[${embedding.map((value) => (Object.is(value, -0) ? "0" : String(value))).join(",")}]`;
}

function parseCandidate(value: unknown, index: number): VectorSearchCandidate {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new VectorBackendError("INVALID_RPC_RESPONSE", `Candidate ${index} is not an object`);
  }
  const row = value as Record<string, unknown>;
  if (
    typeof row.vector_item_id !== "string" ||
    row.vector_item_id.length === 0 ||
    typeof row.score !== "number" ||
    !Number.isFinite(row.score)
  ) {
    throw new VectorBackendError("INVALID_RPC_RESPONSE", `Candidate ${index} has invalid identity or score`);
  }
  if (
    row.search_projection_id !== null &&
    row.search_projection_id !== undefined &&
    typeof row.search_projection_id !== "string"
  ) {
    throw new VectorBackendError("INVALID_RPC_RESPONSE", `Candidate ${index} has an invalid projection identity`);
  }
  if (row.search_text !== null && row.search_text !== undefined && typeof row.search_text !== "string") {
    throw new VectorBackendError("INVALID_RPC_RESPONSE", `Candidate ${index} has invalid search text`);
  }
  return Object.freeze({
    vectorItemId: row.vector_item_id,
    ...(typeof row.search_projection_id === "string" ? { searchProjectionId: row.search_projection_id } : {}),
    score: row.score,
    ...(typeof row.search_text === "string" ? { searchText: row.search_text } : {}),
  });
}
