import { requireDisposableDatabaseUrl, runLocalPersistenceTests } from "./support/persistence.js";
import { randomUUID } from "node:crypto";
import { A2AKnowledgeAdapter } from "../a2a-adapter.js";
import { serviceIdentity, tokenHeaders } from "./support/identity.js";
import {
  PostgresCallbackReplayStore,
  PostgresCanonicalRepository,
  PostgresKnowledgeOperationService,
} from "@aiengineer/knowledge-persistence";
import { describe, expect, it } from "vitest";
import { buildServer } from "../server.js";

describe.skipIf(!runLocalPersistenceTests)("durable A2A callback transport local integration", () => {
  it("rejects an authenticated callback replay after API and database-connection restart", async () => {
    const connectionString = requireDisposableDatabaseUrl();
    const tenantId = randomUUID();
    const { actor, identity } = serviceIdentity(tenantId, randomUUID());
    const token = "durable-a2a-token-at-least-16-characters";
    const secret = "durable-callback-secret-is-at-least-32-bytes";
    const signingKeyReference = "secret://local/durable-callback";
    const now = new Date();
    const clock = () => now;
    const context = {
      tenantId,
      operationId: randomUUID(),
      attemptId: randomUUID(),
      correlationId: `root:${randomUUID()}:nested-eve`,
      causationId: `eve-parent:${randomUUID()}`,
      actor,
      capabilityVersion: "a2a-durable/v1",
      idempotencyKey: `a2a-durable:${randomUUID()}`,
      reason: "prove restart-safe callback replay protection",
      contractVersion: "v1" as const,
      externalExecution: {
        runtime: "eve" as const,
        runId: `nested-${randomUUID()}`,
        rootRunId: `root-${randomUUID()}`,
      },
    };
    const task = {
      taskId: randomUUID(),
      kind: "document_preparation" as const,
      contractVersion: "v1" as const,
      context,
      purpose: "retrieve nested evidence",
      capabilityVersions: { transformation: "v1" },
      expectedOutputContract: "knowledge.representation/v1",
      inputArtifactIds: [],
      operationInput: {
        schemaVersion: "knowledge.transformation/v1",
        captureOperationId: randomUUID(),
        document: {
          documentKind: "web_page",
          canonicalTitle: "Durable A2A fixture",
          versionLabel: "captured",
        },
        profile: {
          profileKey: "deterministic-text",
          version: "1",
          mediaType: "text/plain",
          managedProcessingAllowed: false,
        },
        providerRoute: ["deterministic-text"],
      },
      callback: {
        url: "https://eve.example/callbacks/knowledge",
        authenticationReference: "secret://local/callback-bearer",
        signingKeyReference,
      },
    };
    const requestHeaders = tokenHeaders(token, tenantId, context.correlationId);
    const resolver = (candidate: string) => (candidate === token ? identity : undefined);
    const secretResolver = (candidateTenant: string, reference: string) =>
      candidateTenant === tenantId && reference === signingKeyReference ? secret : undefined;

    const firstRepository = new PostgresCanonicalRepository({
      connectionString,
      localOnly: true,
    });
    const firstOperations = new PostgresKnowledgeOperationService(firstRepository);
    const firstApi = buildServer({
      operationService: firstOperations,
      resolveIdentity: resolver,
      resolveCallbackSigningSecret: secretResolver,
      callbackReplayStore: new PostgresCallbackReplayStore(firstRepository),
      callbackClock: clock,
    });
    try {
      expect(
        (
          await firstApi.inject({
            method: "POST",
            url: "/v1/a2a/tasks",
            headers: requestHeaders,
            payload: task,
          })
        ).statusCode,
      ).toBe(202);
      const callback = new A2AKnowledgeAdapter(firstOperations, "https://knowledge.example").callback(
        task,
        {
          outcome: "succeeded",
          nestedRunId: context.externalExecution.runId,
        },
        secret,
        now.toISOString(),
      );
      const firstDelivery = await firstApi.inject({
        method: "POST",
        url: "/v1/a2a/callbacks",
        headers: {
          ...requestHeaders,
          "x-knowledge-callback-signing-key-reference": signingKeyReference,
        },
        payload: callback,
      });
      expect(firstDelivery.statusCode).toBe(202);

      await firstApi.close();
      await firstRepository.close();

      const restartedRepository = new PostgresCanonicalRepository({
        connectionString,
        localOnly: true,
      });
      const restartedApi = buildServer({
        operationService: new PostgresKnowledgeOperationService(restartedRepository),
        resolveIdentity: resolver,
        resolveCallbackSigningSecret: secretResolver,
        callbackReplayStore: new PostgresCallbackReplayStore(restartedRepository),
        callbackClock: clock,
      });
      try {
        const replay = await restartedApi.inject({
          method: "POST",
          url: "/v1/a2a/callbacks",
          headers: {
            ...requestHeaders,
            "x-knowledge-callback-signing-key-reference": signingKeyReference,
          },
          payload: callback,
        });
        expect(replay.statusCode).toBe(409);
        expect(replay.json()).toMatchObject({ code: "CONFLICT" });
      } finally {
        await restartedApi.close();
        await restartedRepository.close();
      }
    } catch (error) {
      await firstApi.close().catch(() => undefined);
      await firstRepository.close().catch(() => undefined);
      throw error;
    }
  });
});
