import { createHash } from "node:crypto";

// Node ids must be stable across replays of the same representation, so they
// are derived from content rather than generated. This one-argument helper is
// duplicated by the two-argument `deterministicUuid(namespace, value)` in
// packages/core/src/runtime/artifacts.ts; consolidating both into `domain` is
// deferred to Phase 3 (Phase 1 memo, decision P1-3) because it would touch
// chunking, projections, application and runtime at once.
export function deterministicUuid(value: string): string {
  const bytes = createHash("sha256").update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
