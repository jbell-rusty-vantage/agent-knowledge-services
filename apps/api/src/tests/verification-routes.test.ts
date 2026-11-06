import { describe, expect, it } from "vitest";
import { KnowledgeIntegrationService } from "@aiengineer/knowledge-application";
import type { LocalApiIdentity } from "@aiengineer/knowledge-host/config";
import { buildServer } from "../server.js";
import { createVerificationOwnershipResolver } from "@aiengineer/knowledge-host";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const tenant = id(1),
  actor = {
    kind: "service" as const,
    id: id(2),
    serviceIdentity: "mission_control_client" as const,
  },
  token = "verification-test-token-123456";
const identity: LocalApiIdentity = {
  actor,
  grants: [{ tenantId: tenant, roles: ["knowledge_operator"], scopes: [] }],
};
const headers = {
  authorization: `Bearer ${token}`,
  "x-tenant-id": tenant,
  "x-correlation-id": "verification-correlation",
  "idempotency-key": "verification-route-001",
};
const capture = {
  verificationContractVersion: "verification.v1",
  source: {
    mode: "register",
    sourceKind: "web_page",
    sourceId: id(3),
    contentArtifact: { artifactId: id(4), digest: `sha256:${"1".repeat(64)}` },
  },
  requestedProjectionKinds: ["html_dom"],
};
const parseArtifact = {
  verificationContractVersion: "verification.v1",
  captureId: id(40),
  sourceArtifact: {
    artifactId: id(41),
    tenantId: tenant,
    digest: `sha256:${"4".repeat(64)}`,
    mediaType: "text/html",
    byteLength: 4,
    objectKey: "tenant/object",
    createdAt: "2026-09-07T00:00:00.000Z",
    producerActivityId: "capture",
    producerVersion: "v1",
    encryptionClass: "managed",
    retentionClass: "audit",
    dataClassification: "restricted",
    parentArtifactIds: [],
  },
};

describe("verification HTTP composition", () => {
  it("does not let an attestation header bypass external lineage checks in a custom resolver", async () => {
    const operations = new KnowledgeIntegrationService();
    const api = buildServer({
      verificationOperationService: operations,
      resolveIdentity: () => identity,
      resolveVerificationContext: ({ tenantId, identity, correlationId, idempotencyKey }) => ({
        tenantId,
        actor: identity.actor,
        correlationId,
        idempotencyKey,
        operationId: id(91),
        attemptId: id(92),
        capabilityVersion: "verification.v1",
        reason: "untrusted retry regression",
        contractVersion: "v1",
        externalExecution: {
          runtime: "eve",
          runId: "original:turn",
          sessionId: "original",
          turnId: "turn",
          toolCallId: "original-call",
        },
      }),
    });
    try {
      const response = await api.inject({
        method: "POST",
        url: "/v1/verification/captures",
        payload: capture,
        headers: {
          ...headers,
          "x-eve-runtime-attestation": "caller-controlled-placeholder",
          "x-external-runtime": "eve",
          "x-external-run-id": "retry:turn",
          "x-external-session-id": "retry",
          "x-external-turn-id": "turn",
          "x-external-tool-call-id": "retry-call",
        },
      });
      expect(response.statusCode, response.body).toBe(403);
      expect(operations.get(id(91), tenant)).toBeUndefined();
    } finally {
      await api.close();
    }
  });
  it("matches only the literal parser action suffix", async () => {
    const server = buildServer();
    try {
      for (const url of ["/v1/verification/artifacts-anything", "/v1/verification/artifacts:other"]) {
        expect(
          (
            await server.inject({
              method: "POST",
              url,
              headers,
              payload: parseArtifact,
            })
          ).statusCode,
        ).toBe(404);
      }
    } finally {
      await server.close();
    }
  });
  it("does not enqueue parseArtifact without a configured exact-grant admission predicate", async () => {
    const options = (operations: KnowledgeIntegrationService) => ({
      verificationOperationService: operations,
      resolveIdentity: () => identity,
      resolveVerificationContext: ({ tenantId, identity, correlationId, idempotencyKey }: any) => ({
        tenantId,
        operationId: id(42),
        attemptId: id(43),
        correlationId,
        actor: identity.actor,
        capabilityVersion: "verification.v1",
        idempotencyKey,
        reason: "parse route test",
        contractVersion: "v1" as const,
      }),
    });
    const unavailableOperations = new KnowledgeIntegrationService(),
      unavailable = buildServer(options(unavailableOperations));
    try {
      expect(
        (
          await unavailable.inject({
            method: "POST",
            url: "/v1/verification/artifacts:parse",
            headers,
            payload: parseArtifact,
          })
        ).statusCode,
      ).toBe(503);
      expect(unavailableOperations.get(id(42), tenant)).toBeUndefined();
    } finally {
      await unavailable.close();
    }
    const deniedOperations = new KnowledgeIntegrationService(),
      denied = buildServer({
        ...options(deniedOperations),
        isParseArtifactRequestAdmitted: () => false,
      });
    try {
      expect(
        (
          await denied.inject({
            method: "POST",
            url: "/v1/verification/artifacts:parse",
            headers,
            payload: parseArtifact,
          })
        ).statusCode,
      ).toBe(403);
      expect(deniedOperations.get(id(42), tenant)).toBeUndefined();
    } finally {
      await denied.close();
    }
    const admittedOperations = new KnowledgeIntegrationService(),
      admitted = buildServer({
        ...options(admittedOperations),
        isParseArtifactRequestAdmitted: (candidate, input) =>
          candidate === tenant && input.sourceArtifact.artifactId === id(41),
      });
    try {
      expect(
        (
          await admitted.inject({
            method: "POST",
            url: "/v1/verification/artifacts:parse",
            headers,
            payload: parseArtifact,
          })
        ).statusCode,
      ).toBe(202);
      expect(admittedOperations.get(id(42), tenant)).toMatchObject({
        kind: "verification_parse_artifact",
      });
    } finally {
      await admitted.close();
    }
  });
  it("requires registered comparison profiles and rejects caller-computed results before creating an operation", async () => {
    const operations = new KnowledgeIntegrationService(),
      request = {
        verificationContractVersion: "verification.v1",
        baselineRunId: id(80),
        candidateRunId: id(81),
        comparisonProfile: "paired_default",
      };
    const options = {
      verificationOperationService: operations,
      resolveIdentity: () => identity,
      resolveVerificationContext: ({ tenantId, identity, correlationId, idempotencyKey }: any) => ({
        tenantId,
        operationId: id(82),
        attemptId: id(83),
        correlationId,
        actor: identity.actor,
        capabilityVersion: "verification.v1",
        idempotencyKey,
        reason: "comparison route test",
        contractVersion: "v1" as const,
      }),
    };
    const unavailable = buildServer(options);
    try {
      expect(
        (
          await unavailable.inject({
            method: "POST",
            url: "/v1/verification/benchmarks:compare",
            headers,
            payload: request,
          })
        ).statusCode,
      ).toBe(503);
      expect(operations.get(id(82), tenant)).toBeUndefined();
    } finally {
      await unavailable.close();
    }
    const api = buildServer({
      ...options,
      isBenchmarkComparisonRequestAdmitted: (tenantId, input) =>
        tenantId === tenant && input.comparisonProfile === "paired_default",
    });
    try {
      for (const invalid of [
        { ...request, result: {} },
        { ...request, profileArtifact: { artifactId: id(84) } },
        { ...request, candidateRunId: request.baselineRunId },
      ])
        expect(
          (
            await api.inject({
              method: "POST",
              url: "/v1/verification/benchmarks:compare",
              headers,
              payload: invalid,
            })
          ).statusCode,
        ).toBe(400);
      expect(
        (
          await api.inject({
            method: "POST",
            url: "/v1/verification/benchmarks:compare",
            headers,
            payload: { ...request, comparisonProfile: "regression_gate" },
          })
        ).statusCode,
      ).toBe(403);
      expect(operations.get(id(82), tenant)).toBeUndefined();
      const accepted = await api.inject({
        method: "POST",
        url: "/v1/verification/benchmarks:compare",
        headers,
        payload: request,
      });
      expect(accepted.statusCode, accepted.body).toBe(202);
      expect(operations.get(id(82), tenant)).toMatchObject({
        kind: "verification_benchmark_compare",
        context: { attemptId: id(83) },
      });
      expect(operations.input(id(82), tenant)).toEqual({
        schemaVersion: "verification-service-request.v1",
        useCase: "compareBenchmarkRuns",
        request,
      });
    } finally {
      await api.close();
    }
  });
  it("admits only strict offline benchmark references under trusted ownership", async () => {
    const operations = new KnowledgeIntegrationService();
    const api = buildServer({
      isBenchmarkRequestAdmitted: (tenantId, input) => tenantId === tenant && input.dataset.artifactId === id(72),
      verificationOperationService: operations,
      resolveIdentity: () => identity,
      resolveVerificationContext: ({ tenantId, identity, correlationId, idempotencyKey }) => ({
        tenantId,
        operationId: id(70),
        attemptId: id(71),
        correlationId,
        actor: identity.actor,
        capabilityVersion: "verification.v1",
        idempotencyKey,
        reason: "benchmark route test",
        contractVersion: "v1",
      }),
    });
    const request = {
      verificationContractVersion: "verification.v1",
      dataset: { artifactId: id(72), digest: `sha256:${"1".repeat(64)}` },
      experimentDefinition: {
        artifactId: id(73),
        digest: `sha256:${"2".repeat(64)}`,
      },
      executionMode: "offline_recorded",
    };
    try {
      for (const changed of [
        { ...request, checkpointPlan: [] },
        { ...request, executionMode: "live" },
        { ...request, authority: { approved: true } },
      ])
        expect(
          (
            await api.inject({
              method: "POST",
              url: "/v1/verification/benchmarks:run",
              headers,
              payload: changed,
            })
          ).statusCode,
        ).toBe(400);
      expect(operations.get(id(70), tenant)).toBeUndefined();
      expect(
        (
          await api.inject({
            method: "POST",
            url: "/v1/verification/benchmarks:run",
            headers,
            payload: {
              ...request,
              dataset: { ...request.dataset, artifactId: id(99) },
            },
          })
        ).statusCode,
      ).toBe(403);
      expect(operations.get(id(70), tenant)).toBeUndefined();
      const response = await api.inject({
        method: "POST",
        url: "/v1/verification/benchmarks:run",
        headers,
        payload: request,
      });
      expect(response.statusCode, response.body).toBe(202);
      expect(operations.get(id(70), tenant)).toMatchObject({
        kind: "verification_benchmark",
        context: { attemptId: id(71) },
      });
      expect(operations.input(id(70), tenant)).toMatchObject({
        useCase: "runBenchmark",
        request,
      });
    } finally {
      await api.close();
    }
    const unavailable = buildServer({ resolveIdentity: () => identity });
    try {
      expect(
        (
          await unavailable.inject({
            method: "POST",
            url: "/v1/verification/benchmarks:run",
            headers,
            payload: request,
          })
        ).statusCode,
      ).toBe(503);
    } finally {
      await unavailable.close();
    }
  });
  it("parses the literal replay action suffix without including it in the run ID", async () => {
    const api = buildServer({
      verificationOperationService: new KnowledgeIntegrationService(),
      resolveIdentity: () => identity,
      resolveVerificationContext: async ({ tenantId, identity, correlationId, idempotencyKey }: any) => ({
        tenantId,
        operationId: id(20),
        attemptId: id(21),
        correlationId,
        actor: identity.actor,
        capabilityVersion: "verification-service.v1",
        idempotencyKey,
        reason: "replay routing test",
        contractVersion: "v1" as const,
      }),
    });
    try {
      const response = await api.inject({
        method: "POST",
        url: `/v1/verification/runs/${id(50)}:replay`,
        headers,
        payload: {
          verificationContractVersion: "verification.v1",
          runId: id(50),
          replayMode: "deterministic_only",
        },
      });
      expect(response.statusCode, response.body).toBe(202);
      const invalid = await api.inject({
        method: "POST",
        url: `/v1/verification/runs/${id(50)}:other`,
        headers,
        payload: {},
      });
      expect(invalid.statusCode).toBe(404);
    } finally {
      await api.close();
    }
  });
  it("admits exact external execution grants when optional headers are absent", async () => {
    const database = {
      transaction: async (_tenant: unknown, work: any) => work({ query: async () => ({ rows: [{ id: id(31) }] }) }),
    };
    const api = buildServer({
      verificationOperationService: new KnowledgeIntegrationService(),
      resolveIdentity: () => identity,
      resolveVerificationContext: createVerificationOwnershipResolver(
        database as never,
        JSON.stringify([
          {
            tenantId: tenant,
            actor,
            missionId: id(33),
            agentDeploymentId: "mission-dispatch",
            capabilityVersion: "verification-service.v1",
            externalExecution: {
              runtime: "mission_control",
              runId: "mission-run",
            },
          },
        ]),
      ),
    });
    try {
      const response = await api.inject({
        method: "POST",
        url: "/v1/verification/captures",
        payload: capture,
        headers: {
          ...headers,
          "x-verification-attempt-id": id(31),
          "x-verification-work-item-id": id(32),
          "x-verification-mission-id": id(33),
          "x-external-runtime": "mission_control",
          "x-external-run-id": "mission-run",
        },
      });
      expect(response.statusCode, response.body).toBe(202);
    } finally {
      await api.close();
    }
  });
  it("derives trusted operation context server-side and returns a durable receipt", async () => {
    const operations = new KnowledgeIntegrationService(),
      api = buildServer({
        verificationOperationService: operations,
        resolveIdentity: (candidate) => (candidate === token ? identity : undefined),
        publicOrigin: "https://knowledge.example",
        resolveVerificationContext: ({ tenantId, identity, correlationId, idempotencyKey }) => ({
          tenantId,
          operationId: id(10),
          attemptId: id(11),
          correlationId,
          actor: identity.actor,
          capabilityVersion: "verification-service.v1",
          idempotencyKey,
          reason: "authenticated verification request",
          contractVersion: "v1",
        }),
      });
    const response = await api.inject({
      method: "POST",
      url: "/v1/verification/captures",
      headers,
      payload: capture,
    });
    expect(response.statusCode, response.body).toBe(202);
    expect(response.json()).toMatchObject({
      operationId: id(10),
      state: "queued",
    });
    expect(operations.get(id(10), tenant)).toMatchObject({
      kind: "verification_capture",
      context: { actor },
    });
    expect(operations.input(id(10), tenant)).toMatchObject({
      schemaVersion: "verification-service-request.v1",
      useCase: "captureSource",
    });
    await api.close();
  });
  it("rejects caller trust fields, missing idempotency, and mismatched trusted context before admission", async () => {
    const operations = new KnowledgeIntegrationService(),
      base = {
        verificationOperationService: operations,
        resolveIdentity: (candidate: string) => (candidate === token ? identity : undefined),
        resolveVerificationContext: ({ tenantId, identity, correlationId, idempotencyKey }: any) => ({
          tenantId,
          operationId: id(20),
          attemptId: id(21),
          correlationId,
          actor: identity.actor,
          capabilityVersion: "verification-service.v1",
          idempotencyKey,
          reason: "authenticated verification request",
          contractVersion: "v1" as const,
        }),
      };
    const api = buildServer(base);
    const injected = await api.inject({
      method: "POST",
      url: "/v1/verification/captures",
      headers,
      payload: { ...capture, grant: { allowed: true } },
    });
    expect(injected.statusCode).toBe(400);
    const { "idempotency-key": _omitted, ...headersWithoutKey } = headers;
    const noKey = await api.inject({
      method: "POST",
      url: "/v1/verification/captures",
      headers: headersWithoutKey,
      payload: capture,
    });
    expect(noKey.statusCode).toBe(400);
    await api.close();
    const mismatch = buildServer({
      ...base,
      resolveVerificationContext: async (input: any) => ({
        ...(await base.resolveVerificationContext(input)),
        tenantId: id(99),
      }),
    });
    const denied = await mismatch.inject({
      method: "POST",
      url: "/v1/verification/captures",
      headers,
      payload: capture,
    });
    expect(denied.statusCode).toBe(403);
    expect(operations.get(id(20), tenant)).toBeUndefined();
    await mismatch.close();
  });
  it("keeps verification mutations unavailable when trusted composition is absent", async () => {
    const api = buildServer({
      resolveIdentity: (candidate) => (candidate === token ? identity : undefined),
    });
    const response = await api.inject({
      method: "POST",
      url: "/v1/verification/captures",
      headers,
      payload: capture,
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: "CAPABILITY_NOT_ADMITTED" });
    await api.close();
  });
  it("passes strict routing hints to an ownership resolver and rejects unresolved ownership", async () => {
    const operations = new KnowledgeIntegrationService(),
      hintHeaders = {
        ...headers,
        "x-verification-attempt-id": id(31),
        "x-verification-work-item-id": id(32),
        "x-verification-mission-id": id(33),
        "x-causation-id": "mission-parent",
        "x-external-runtime": "mission_control",
        "x-external-run-id": "mission-run",
      };
    let observed: unknown;
    const denied = buildServer({
      verificationOperationService: operations,
      resolveIdentity: (candidate) => (candidate === token ? identity : undefined),
      resolveVerificationContext: (input) => {
        observed = input.hints;
        return undefined;
      },
    });
    const response = await denied.inject({
      method: "POST",
      url: "/v1/verification/captures",
      headers: hintHeaders,
      payload: capture,
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "FORBIDDEN" });
    expect(observed).toEqual({
      attemptId: id(31),
      workItemId: id(32),
      missionId: id(33),
      causationId: "mission-parent",
      externalExecution: { runtime: "mission_control", runId: "mission-run" },
    });
    expect(operations.get(id(31), tenant)).toBeUndefined();
    await denied.close();
  });
});
