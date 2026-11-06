export const CANONICAL_EMBEDDING_DIMENSIONS = 1_536 as const;

export interface VectorSearchRequest {
  readonly tenantId: string;
  readonly vectorSpaceVersionId: string;
  readonly embedding: readonly number[];
  readonly limit: number;
}

export interface VectorSearchCandidate {
  readonly vectorItemId: string;
  readonly searchProjectionId?: string;
  readonly score: number;
  readonly searchText?: string;
}

export interface VectorSearchBackend {
  search(request: VectorSearchRequest): Promise<readonly VectorSearchCandidate[]>;
}

export interface ExactVectorItem {
  readonly tenantId: string;
  readonly vectorSpaceVersionId: string;
  readonly vectorSpaceKey: string;
  readonly vectorItemId: string;
  readonly searchProjectionId?: string;
  readonly embedding: readonly number[];
  readonly searchText?: string;
  readonly lifecycle?: "active" | "superseded" | "withdrawn";
}

export function validateEmbedding(
  embedding: readonly number[],
  expectedDimensions = CANONICAL_EMBEDDING_DIMENSIONS,
): void {
  if (embedding.length !== expectedDimensions) {
    throw new VectorBackendError(
      "INVALID_DIMENSIONS",
      `Embedding has ${embedding.length} dimensions; expected ${expectedDimensions}`,
    );
  }
  if (embedding.some((value) => !Number.isFinite(value))) {
    throw new VectorBackendError("INVALID_EMBEDDING", "Embedding values must all be finite");
  }
}

export function validateSearchLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new VectorBackendError("INVALID_LIMIT", "Search limit must be an integer between 1 and 200");
  }
}

export class VectorBackendError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "VectorBackendError";
  }
}
