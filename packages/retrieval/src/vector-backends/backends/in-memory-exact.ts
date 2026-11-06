import {
  CANONICAL_EMBEDDING_DIMENSIONS,
  type ExactVectorItem,
  type VectorSearchBackend,
  type VectorSearchCandidate,
  type VectorSearchRequest,
  VectorBackendError,
  validateEmbedding,
  validateSearchLimit,
} from "../types.js";

/** Deterministic exact-cosine backend used as the evaluation oracle and local fake. */
export class InMemoryExactCosineBackend implements VectorSearchBackend {
  readonly #items = new Map<string, ExactVectorItem>();

  constructor(items: readonly ExactVectorItem[] = []) {
    this.add(items);
  }

  add(items: readonly ExactVectorItem[]): void {
    const pending = new Map<string, ExactVectorItem>();
    for (const item of items) {
      validateEmbedding(item.embedding);
      const key = itemKey(item.tenantId, item.vectorItemId);
      const existing = this.#items.get(key) ?? pending.get(key);
      if (existing !== undefined) {
        if (!sameItem(existing, item))
          throw new VectorBackendError(
            "IMMUTABLE_ITEM_CONFLICT",
            `Vector item ${item.vectorItemId} already exists with different content`,
          );
        continue;
      }
      pending.set(key, freezeItem(item));
    }
    for (const [key, item] of pending) this.#items.set(key, item);
  }

  count(tenantId?: string, vectorSpaceVersionId?: string): number {
    return [...this.#items.values()].filter(
      (item) =>
        (tenantId === undefined || item.tenantId === tenantId) &&
        (vectorSpaceVersionId === undefined || item.vectorSpaceVersionId === vectorSpaceVersionId),
    ).length;
  }

  async search(request: VectorSearchRequest): Promise<readonly VectorSearchCandidate[]> {
    validateEmbedding(request.embedding);
    validateSearchLimit(request.limit);
    const queryMagnitude = magnitude(request.embedding);
    if (queryMagnitude === 0)
      throw new VectorBackendError("ZERO_VECTOR", "Cosine search does not accept a zero query vector");

    return [...this.#items.values()]
      .filter(
        (item) =>
          item.tenantId === request.tenantId &&
          item.vectorSpaceVersionId === request.vectorSpaceVersionId &&
          (item.lifecycle ?? "active") === "active",
      )
      .map(
        (item): VectorSearchCandidate => ({
          vectorItemId: item.vectorItemId,
          ...(item.searchProjectionId === undefined ? {} : { searchProjectionId: item.searchProjectionId }),
          score: cosine(request.embedding, item.embedding, queryMagnitude),
          ...(item.searchText === undefined ? {} : { searchText: item.searchText }),
        }),
      )
      .sort((left, right) => right.score - left.score || left.vectorItemId.localeCompare(right.vectorItemId))
      .slice(0, request.limit)
      .map((candidate) => Object.freeze(candidate));
  }
}

function cosine(left: readonly number[], right: readonly number[], leftMagnitude: number): number {
  let dot = 0;
  let rightSquared = 0;
  for (let index = 0; index < CANONICAL_EMBEDDING_DIMENSIONS; index += 1) {
    const leftValue = left[index]!;
    const rightValue = right[index]!;
    dot += leftValue * rightValue;
    rightSquared += rightValue * rightValue;
  }
  if (rightSquared === 0) return -1;
  return dot / (leftMagnitude * Math.sqrt(rightSquared));
}

function magnitude(vector: readonly number[]): number {
  return Math.sqrt(vector.reduce((total, value) => total + value * value, 0));
}

function itemKey(tenantId: string, itemId: string): string {
  return `${tenantId}\u0000${itemId}`;
}

function freezeItem(item: ExactVectorItem): ExactVectorItem {
  return Object.freeze({ ...item, embedding: Object.freeze([...item.embedding]) });
}

function sameItem(left: ExactVectorItem, right: ExactVectorItem): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.vectorSpaceVersionId === right.vectorSpaceVersionId &&
    left.vectorSpaceKey === right.vectorSpaceKey &&
    left.vectorItemId === right.vectorItemId &&
    left.searchProjectionId === right.searchProjectionId &&
    left.searchText === right.searchText &&
    (left.lifecycle ?? "active") === (right.lifecycle ?? "active") &&
    left.embedding.length === right.embedding.length &&
    left.embedding.every((value, index) => value === right.embedding[index])
  );
}
