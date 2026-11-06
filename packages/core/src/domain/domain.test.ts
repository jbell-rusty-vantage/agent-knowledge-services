import { describe, expect, it } from "vitest";
import {
  assertAppendOnly,
  assertAuthorityCompatible,
  assertIdempotentReplay,
  canonicalJson,
  createIdempotencyKey,
  DomainInvariantError,
  sha256Digest,
  transitionOperation,
  transitionPromotion,
  transitionPublication,
} from "./index.js";

const guard = { expectedRowVersion: 2, actualRowVersion: 2, expectedDigest: "same", actualDigest: "same" };
describe("domain invariants", () => {
  it("allows only explicit state transitions with optimistic guards", () => {
    expect(transitionOperation("queued", "running", guard).nextRowVersion).toBe(3);
    expect(transitionPromotion("approved", "published", guard).resultingState).toBe("published");
    expect(transitionPublication("published", "superseded", guard).resultingState).toBe("superseded");
    expect(() => transitionPublication("draft", "published", guard)).toThrowError(DomainInvariantError);
    expect(() => transitionOperation("queued", "running", { ...guard, actualRowVersion: 3 })).toThrowError(/stale/);
  });
  it("canonicalizes objects and derives stable digests/idempotency keys", () => {
    expect(canonicalJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    expect(sha256Digest({ b: 2, a: 1 })).toBe(sha256Digest({ a: 1, b: 2 }));
    expect(createIdempotencyKey({ capabilityVersion: "1", parameterDigest: "p", inputDigests: ["i"] })).toBe(
      createIdempotencyKey({ capabilityVersion: "1", parameterDigest: "p", inputDigests: ["i"] }),
    );
  });
  it("enforces append-only, idempotency, and authority boundaries", () => {
    expect(() => assertAppendOnly("old", "new")).toThrowError(/Immutable/);
    expect(() => assertIdempotentReplay("i", "i", "o", "different")).toThrowError(/conflicting/);
    expect(() => assertAuthorityCompatible("internal_exploratory", "official_canonical", false)).toThrowError(
      /promotion decision/,
    );
    expect(() => assertAuthorityCompatible("internal_exploratory", "official_canonical", true)).not.toThrow();
  });
});
