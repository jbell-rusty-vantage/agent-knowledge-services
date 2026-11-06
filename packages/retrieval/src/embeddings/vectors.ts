import { createHash } from "node:crypto";
import { sha256Digest } from "@aiengineer/knowledge-core";
import type { EmbedManyRequest } from "./types.js";

export function validateVector(vector: readonly number[], dimensions: number): void {
  if (vector.length !== dimensions) {
    throw new Error(`EMBEDDING_DIMENSION_MISMATCH:${vector.length}:${dimensions}`);
  }
  if (vector.some((value) => !Number.isFinite(value))) {
    throw new Error("EMBEDDING_NON_FINITE");
  }
}

export function vectorDigest(vector: readonly number[]): `sha256:${string}` {
  const bytes = Buffer.allocUnsafe(vector.length * 8);
  vector.forEach((value, index) => bytes.writeDoubleBE(value, index * 8));
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function cacheKey(version: string, digest: string): string {
  return `${version}:${digest}`;
}

export function fakeVector(text: string, dimensions: number): number[] {
  const output: number[] = [];
  for (let block = 0; output.length < dimensions; block++) {
    const bytes = createHash("sha256").update(`${text}\0${block}`).digest();
    for (const byte of bytes) {
      output.push((byte - 127.5) / 127.5);
      if (output.length === dimensions) break;
    }
  }
  const norm = Math.sqrt(output.reduce((sum, x) => sum + x * x, 0));
  return output.map((x) => x / norm);
}

export function validateRequest(request: EmbedManyRequest): void {
  if (!request.idempotencyKey.trim()) {
    throw new Error("IDEMPOTENCY_KEY_REQUIRED");
  }
  if (!request.vectorSpaceVersionId.trim()) {
    throw new Error("VECTOR_SPACE_VERSION_REQUIRED");
  }
  if (request.inputs.length === 0) {
    throw new Error("EMBEDDING_INPUTS_REQUIRED");
  }
  const projectionIds = new Set<string>();
  for (const input of request.inputs) {
    if (!input.text.trim()) {
      throw new Error(`EMPTY_EMBEDDING_INPUT:${input.projectionId}`);
    }
    if (input.textDigest !== undefined && input.textDigest !== sha256Digest(input.text)) {
      throw new Error(`EMBEDDING_TEXT_DIGEST_MISMATCH:${input.projectionId}`);
    }
    if (projectionIds.has(input.projectionId)) {
      throw new Error(`DUPLICATE_EMBEDDING_PROJECTION:${input.projectionId}`);
    }
    projectionIds.add(input.projectionId);
  }
}
