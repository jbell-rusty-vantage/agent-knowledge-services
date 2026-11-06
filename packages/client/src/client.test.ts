import { describe, expect, it, vi } from "vitest";
import { KnowledgeClient, KnowledgeClientError } from "./index.js";

describe("KnowledgeClient", () => {
  it("posts only the strict parseArtifact request to the dedicated route", async () => {
    const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
      fetch = vi.fn<typeof globalThis.fetch>(
        async () =>
          new Response(
            JSON.stringify({
              operationId: id(9),
              state: "queued",
              contractVersion: "v1",
              statusUrl: "https://k/status",
              eventStreamUrl: "https://k/events",
              cancellationUrl: "https://k/cancel",
              retryUrl: "https://k/retry",
              reconcileUrl: "https://k/reconcile",
            }),
            { status: 202 },
          ),
      ),
      client = new KnowledgeClient({ baseUrl: "https://knowledge.example", fetch }),
      request = {
        verificationContractVersion: "verification.v1" as const,
        captureId: id(2),
        sourceArtifact: {
          artifactId: id(3),
          tenantId: id(1),
          digest: `sha256:${"a".repeat(64)}` as const,
          mediaType: "text/html",
          byteLength: 4,
          objectKey: "tenant/object",
          createdAt: "2026-09-07T00:00:00.000Z",
          producerActivityId: "capture",
          producerVersion: "v1",
          encryptionClass: "managed",
          retentionClass: "audit",
          dataClassification: "restricted" as const,
          parentArtifactIds: [],
        },
      };
    await client.parseArtifact(request, {
      tenantId: id(1),
      correlationId: "parse-client",
      idempotencyKey: "parse-client-001",
    });
    expect(String(fetch.mock.calls[0]![0])).toBe("https://knowledge.example/v1/verification/artifacts:parse");
    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toEqual(request);
  });
  it("submits benchmarks through the dedicated offline route with ownership headers", async () => {
    const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(
          JSON.stringify({
            operationId: id(9),
            state: "queued",
            contractVersion: "v1",
            statusUrl: "https://k/status",
            eventStreamUrl: "https://k/events",
            cancellationUrl: "https://k/cancel",
            retryUrl: "https://k/retry",
            reconcileUrl: "https://k/reconcile",
          }),
          { status: 202 },
        ),
    );
    const client = new KnowledgeClient({ baseUrl: "https://knowledge.example", fetch }),
      context = {
        tenantId: id(1),
        correlationId: "benchmark-client",
        idempotencyKey: "benchmark-client-1",
        attemptId: id(2),
      };
    const request = {
      verificationContractVersion: "verification.v1" as const,
      dataset: { artifactId: id(3), digest: `sha256:${"1".repeat(64)}` as const },
      experimentDefinition: { artifactId: id(4), digest: `sha256:${"2".repeat(64)}` as const },
      executionMode: "offline_recorded" as const,
    };
    await client.runBenchmark(request, context);
    expect(String(fetch.mock.calls[0]![0])).toBe("https://knowledge.example/v1/verification/benchmarks:run");
    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toEqual(request);
    expect(new Headers(fetch.mock.calls[0]![1]?.headers).get("x-verification-attempt-id")).toBe(context.attemptId);
    expect(() => client.runBenchmark({ ...request, executionMode: "live" } as never, context)).toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("sends strict verification requests with routing hints outside the body", async () => {
    const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
      calls: { url: string; body: unknown; headers: Headers }[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
        calls.push({ url: String(input), body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
        return new Response(
          JSON.stringify({
            operationId: id(9),
            state: "queued",
            contractVersion: "v1",
            statusUrl: "https://k/status",
            eventStreamUrl: "https://k/events",
            cancellationUrl: "https://k/cancel",
            retryUrl: "https://k/retry",
            reconcileUrl: "https://k/reconcile",
          }),
          { status: 202, headers: { "content-type": "application/json" } },
        );
      }),
      client = new KnowledgeClient({ baseUrl: "https://knowledge.example", fetch });
    const context = {
        tenantId: id(1),
        correlationId: "verify-correlation",
        idempotencyKey: "verification-client-001",
        attemptId: id(4),
        workItemId: id(5),
        missionId: id(6),
        causationId: "mission-parent",
        externalExecution: { runtime: "mission_control" as const, runId: "mission-run", rootRunId: "root-run" },
      },
      request = {
        verificationContractVersion: "verification.v1" as const,
        captureIds: ["capture-1"],
        extractionSchema: { artifactId: id(2), digest: `sha256:${"1".repeat(64)}` as const },
        extractionOutput: { artifactId: id(3), digest: `sha256:${"2".repeat(64)}` as const },
      };
    await client.verifyExtraction(request, context);
    expect(calls[0]?.url).toBe("https://knowledge.example/v1/verification/extractions:verify");
    expect(calls[0]?.headers.get("idempotency-key")).toBe(context.idempotencyKey);
    expect(calls[0]?.headers.get("x-verification-attempt-id")).toBe(context.attemptId);
    expect(calls[0]?.headers.get("x-verification-work-item-id")).toBe(context.workItemId);
    expect(calls[0]?.headers.get("x-verification-mission-id")).toBe(context.missionId);
    expect(calls[0]?.headers.get("x-causation-id")).toBe(context.causationId);
    expect(calls[0]?.headers.get("x-external-runtime")).toBe("mission_control");
    expect(calls[0]?.headers.get("x-external-run-id")).toBe("mission-run");
    expect(calls[0]?.body).toEqual(request);
    expect(calls[0]?.body).not.toHaveProperty("context");
  });
  it("reads vector-store detail and store-scoped operation paths without mutation bodies", async () => {
    const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const store = {
      id: id(1),
      tenantId: id(2),
      ownerIdentity: "service:test",
      storeClass: "internal_exploratory",
      slug: "test",
      name: "Test",
      purpose: "test",
      visibility: "tenant",
      lifecycle: "active",
      quotaProfile: {},
      retentionPolicy: {},
      deletionPolicy: {},
      createdAt: "2026-09-04T00:00:00.000Z",
      documentCount: 0,
      spaces: [],
      spacesTruncated: false,
    };
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      expect(init?.method).toBe("GET");
      expect(init?.body).toBeUndefined();
      return new Response(
        JSON.stringify(
          String(input).includes("/operations/")
            ? {
                operationId: id(3),
                kind: "embedding_run",
                state: "succeeded",
                context: {
                  tenantId: id(2),
                  operationId: id(3),
                  attemptId: id(4),
                  correlationId: "c",
                  actor: { kind: "service", id: id(5), serviceIdentity: "retrieval_executor" },
                  capabilityVersion: "v1",
                  idempotencyKey: "test-key",
                  reason: "test",
                  contractVersion: "v1",
                },
                inputDigest: `sha256:${"a".repeat(64)}`,
                rowVersion: 1,
                createdAt: "2026-09-04T00:00:00.000Z",
                updatedAt: "2026-09-04T00:00:00.000Z",
                receiptIds: [],
              }
            : store,
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const client = new KnowledgeClient({ baseUrl: "https://knowledge.example", fetch });
    await expect(client.getVectorStore(id(1), { tenantId: id(2), correlationId: "c" })).resolves.toMatchObject({
      id: id(1),
    });
    await client.getVectorStoreOperation(id(1), id(3), { tenantId: id(2), correlationId: "c" });
    expect(String(fetch.mock.calls[1]?.[0])).toContain(`/v1/vector-stores/${id(1)}/operations/${id(3)}`);
  });
  it("encodes packet ids and validates typed responses", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async (_input, _init) =>
        new Response(
          JSON.stringify({
            type: "https://knowledge/errors/not-found",
            title: "Not found",
            status: 404,
            code: "NOT_FOUND",
            correlationId: "corr",
          }),
          { status: 404, headers: { "content-type": "application/json" } },
        ),
    );
    const client = new KnowledgeClient({ baseUrl: "https://knowledge.example/", fetch });
    await expect(client.getEvidencePacket("packet/one")).rejects.toBeInstanceOf(KnowledgeClientError);
    expect(String(fetch.mock.calls[0]![0])).toContain("packet%2Fone");
  });
  it("adds bearer authentication without exposing token state", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret");
      const request = JSON.parse(String(init?.body));
      expect(request.expectedVersions).toMatchObject({ api: "v1", retrieval: "v1" });
      expect(request.input).not.toHaveProperty("embedding");
      return new Response(
        JSON.stringify({
          operationId: "00000000-0000-4000-8000-000000000001",
          state: "queued",
          contractVersion: "v1",
          statusUrl: "https://k/status",
          eventStreamUrl: "https://k/events",
          cancellationUrl: "https://k/cancel",
          retryUrl: "https://k/retry",
          reconcileUrl: "https://k/reconcile",
        }),
        { status: 202 },
      );
    });
    const client = new KnowledgeClient({
      baseUrl: "https://knowledge.example/",
      getAccessToken: () => "secret",
      fetch,
    });
    const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const plan = {
      policyVersion: id(1),
      query: "q",
      intents: ["knowledge_evidence" as const],
      subqueries: [{ id: "q1", text: "q", coverageRole: "required" as const }],
      spaces: ["engineering_claims" as const],
      anchors: { entities: [], concepts: [], useCases: [] },
      hardFilters: [],
      softBoosts: [],
      temporalScope: {},
      candidateK: 10,
      finalK: 5,
      graph: { maxDepth: 0, allowedEdges: [] },
      abstention: { minimumCoverage: 1 },
    };
    const context = {
      tenantId: id(2),
      operationId: id(3),
      attemptId: id(4),
      correlationId: "corr",
      actor: { kind: "service" as const, id: id(5), serviceIdentity: "retrieval_executor" as const },
      capabilityVersion: "1",
      idempotencyKey: "idem-key",
      reason: "test",
      contractVersion: "v1" as const,
    };
    await expect(client.createRetrievalRun(plan, context)).resolves.toMatchObject({ operationId: id(1) });
  });
  it("submits A2A tasks with nested context and callback authentication metadata", async () => {
    const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const context = {
      tenantId: id(1),
      operationId: id(2),
      attemptId: id(3),
      correlationId: "root:nested",
      causationId: "eve-parent",
      actor: { kind: "service" as const, id: id(4), serviceIdentity: "mission_control_client" as const },
      capabilityVersion: "a2a/v1",
      idempotencyKey: "a2a-client-001",
      reason: "nested retrieval",
      contractVersion: "v1" as const,
      externalExecution: { runtime: "eve" as const, runId: "nested", rootRunId: "root" },
    };
    const task = {
      taskId: id(5),
      kind: "retrieval" as const,
      contractVersion: "v1" as const,
      context,
      purpose: "retrieve evidence",
      capabilityVersions: { retrieval: "v1" },
      expectedOutputContract: "evidence-packet/v1",
      inputArtifactIds: [],
      operationInput: {
        plan: {
          policyVersion: id(6),
          query: "retrieve evidence",
          intents: ["knowledge_evidence" as const],
          subqueries: [{ id: "evidence", text: "retrieve evidence", coverageRole: "required" as const }],
          spaces: ["engineering_claims" as const],
          anchors: { entities: [], concepts: [], useCases: [] },
          hardFilters: [],
          softBoosts: [],
          temporalScope: {},
          candidateK: 10,
          finalK: 5,
          graph: { maxDepth: 0, allowedEdges: [] },
          abstention: { minimumCoverage: 0.5 },
        },
      },
      callback: {
        url: "https://eve.example/callback",
        authenticationReference: "secret://auth",
        signingKeyReference: "secret://signing",
      },
    };
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      expect(String(input)).toBe("https://knowledge.example/v1/a2a/tasks");
      expect(new Headers(init?.headers).get("x-correlation-id")).toBe("root:nested");
      expect(JSON.parse(String(init?.body))).toEqual(task);
      return new Response(
        JSON.stringify({
          taskId: task.taskId,
          operationId: context.operationId,
          state: "accepted",
          statusUrl: "https://knowledge.example/v1/operations/status",
          eventStreamUrl: "https://knowledge.example/v1/operations/events",
          cancellationUrl: "https://knowledge.example/v1/operations/cancel",
        }),
        { status: 202, headers: { "content-type": "application/json" } },
      );
    });
    const client = new KnowledgeClient({ baseUrl: "https://knowledge.example", getAccessToken: () => "token", fetch });
    await expect(client.submitA2ATask(task)).resolves.toMatchObject({
      taskId: task.taskId,
      operationId: context.operationId,
    });
  });
});
