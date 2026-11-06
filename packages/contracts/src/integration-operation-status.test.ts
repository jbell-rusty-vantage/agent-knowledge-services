import { describe, expect, it } from "vitest";
import { OperationStatusSchema } from "./integration.js";

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const digest = `sha256:${"a".repeat(64)}`;
const base = {
  operationId: id(1),
  kind: "verification_structured_extraction",
  state: "failed",
  context: {
    tenantId: id(2),
    operationId: id(1),
    attemptId: id(3),
    correlationId: "operation-failure-contract",
    actor: { kind: "service", id: id(4), serviceIdentity: "knowledge_worker" },
    capabilityVersion: "verification-service.v1",
    idempotencyKey: "operation-failure-contract-001",
    reason: "contract fixture",
    contractVersion: "v1",
  },
  inputDigest: digest,
  rowVersion: 1,
  createdAt: "2026-09-08T00:00:00.000Z",
  updatedAt: "2026-09-08T00:01:00.000Z",
  receiptIds: [id(5)],
};

describe("OperationStatus failure summary", () => {
  it("permits only a compact typed receipt-derived summary", () => {
    expect(
      OperationStatusSchema.parse({
        ...base,
        failure: {
          receiptId: id(5),
          category: "provider_upstream_failure",
          errorClass: "PROVIDER_HTTP_FAILURE",
          retryable: true,
          qualityFailure: false,
        },
      }),
    ).toMatchObject({ failure: { category: "provider_upstream_failure", qualityFailure: false } });
  });

  it("rejects an unknown category and raw receipt drift", () => {
    expect(() =>
      OperationStatusSchema.parse({
        ...base,
        failure: {
          receiptId: id(5),
          category: "not-a-category",
          errorClass: "UNKNOWN",
          retryable: false,
          qualityFailure: false,
        },
      }),
    ).toThrow();
    expect(() =>
      OperationStatusSchema.parse({
        ...base,
        failure: {
          receiptId: id(5),
          category: "harness_failure",
          errorClass: "UNKNOWN",
          retryable: false,
          qualityFailure: false,
          body: { message: "private" },
        },
      }),
    ).toThrow();
    expect(() =>
      OperationStatusSchema.parse({
        ...base,
        failure: {
          receiptId: id(5),
          category: "harness_failure",
          errorClass: "private error",
          retryable: false,
          qualityFailure: false,
        },
      }),
    ).toThrow();
  });
});
