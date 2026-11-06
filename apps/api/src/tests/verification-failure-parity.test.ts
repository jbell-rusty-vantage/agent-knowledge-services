import { describe, expect, it, vi } from "vitest";
import { OperationStatusSchema } from "@aiengineer/knowledge-contracts";
import { PostgresKnowledgeOperationService } from "../../../../packages/persistence/src/operation-service.js";
import type { PostgresCanonicalRepository } from "../../../../packages/persistence/src/postgres.js";
import { buildServer } from "../server.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const tenant = id(1),
  operationId = id(2),
  receiptId = id(3);
const actor = {
  kind: "service" as const,
  id: id(4),
  serviceIdentity: "mission_control_client" as const,
};
const context = {
  tenantId: tenant,
  operationId,
  attemptId: id(5),
  actor,
  capabilityVersion: "verification-service.v1",
  correlationId: "failure-parity",
  idempotencyKey: "failure-parity-001",
  reason: "failure projection",
  contractVersion: "v1" as const,
};
const categories = [
  ["PROVIDER_HTTP_FAILURE", "provider_upstream_failure", false],
  ["PROVIDER_INPUT_POLICY_REJECTED", "policy_rejection", false],
  ["ACTIVITY_REGISTRY_REQUIRED", "harness_failure", false],
] as const;

describe("canonical failure receipt to public verification HTTP", () => {
  it.each(categories)(
    "preserves %s without exposing raw receipt material",
    async (errorClass, category, qualityFailure) => {
      let state = "failed";
      const record = {
        id: operationId,
        tenantId: tenant,
        operationKind: "verification_structured_extraction",
        idempotencyKey: context.idempotencyKey,
        request: {
          schemaVersion: "knowledge-operation-request/v1",
          kind: "verification_structured_extraction",
          input: {},
          expectedVersions: { verification: "verification.v1" },
        },
        rowVersion: 1,
        createdAt: "2026-09-08T00:00:00.000Z",
        updatedAt: "2026-09-08T00:00:00.000Z",
      };
      const repository = {
        getOperationRecord: vi.fn(async (tenantId: string) =>
          tenantId === tenant ? { ...record, status: state } : undefined,
        ),
        listSteps: vi.fn(async () => [
          {
            input: { schemaVersion: "knowledge-operation-request/v1", context },
          },
        ]),
        listReceipts: vi.fn(async () => [
          {
            id: receiptId,
            receiptKind: "failure",
            outcome: "failed",
            body: {
              errorClass,
              retryable: false,
              attemptsExhausted: true,
              rawProviderBody: "PRIVATE_CANARY",
              apiKey: "PRIVATE_CANARY",
              category: "forged_category",
            },
          },
        ]),
      };
      const operations = new PostgresKnowledgeOperationService(repository as unknown as PostgresCanonicalRepository);
      const api = buildServer({
        verificationOperationService: operations,
        resolveIdentity: () => ({
          actor,
          grants: [{ tenantId: tenant, roles: ["knowledge_operator"], scopes: [] }],
        }),
      });
      const headers = {
        authorization: "Bearer synthetic-failure",
        "x-tenant-id": tenant,
      };
      try {
        const response = await api.inject({
          method: "GET",
          url: `/v1/verification/operations/${operationId}`,
          headers,
        });
        expect(response.statusCode, response.body).toBe(200);
        const status = OperationStatusSchema.parse(response.json());
        const expected = {
          receiptId,
          category,
          errorClass,
          retryable: false,
          qualityFailure,
        };
        expect(status.failure).toEqual(expected);
        expect(JSON.stringify(status)).not.toMatch(/PRIVATE_CANARY|rawProviderBody|apiKey|forged_category/);
        state = "succeeded";
        const recovered = await api.inject({
          method: "GET",
          url: `/v1/verification/operations/${operationId}`,
          headers,
        });
        expect(recovered.statusCode).toBe(200);
        expect(recovered.json().failure).toBeUndefined();
      } finally {
        await api.close();
      }
    },
  );
});
