/** Real loopback discovery/capture/storage fixture. Only discovery-provider results are scripted. */
import { randomUUID, randomBytes } from "node:crypto";
import { ScopedExecutorAccess, scopedCustodyOperations } from "../../access.js";
import { createHttpServer } from "../../http.js";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve, sep } from "node:path";
import { SourceDiscoveryAttemptSchema } from "@aiengineer/knowledge-contracts";
import type { AuthScope, ExternalCustodyReader } from "@aiengineer/knowledge-research-core";
import {
  disposableDatabaseUrl,
  disposableStorageConfig,
} from "../../../../../packages/persistence/test/disposable.mjs";
import { VerificationExecutor, loadExecutorConfig } from "../../executor.js";
import { createKnowledgeServices, defaultUseClassesFile, type KnowledgeServices } from "../../knowledge/context.js";
import { createSourceDiscoveryHost } from "../../knowledge/source-discovery-host.js";
import { knowledgeOperations } from "../../knowledge/operations.js";
import { type captureFragment, createCaptureCustodyReader, readCaptureProvenance } from "../capture-bridge.js";

export async function openCapturedSourceFixture(scope: AuthScope, evidenceRoot: string) {
  const databaseUrl = disposableDatabaseUrl(),
    storage = disposableStorageConfig();
  if (!databaseUrl || !storage) throw new Error("PHASE0_REAL_STORAGE_REQUIRED");
  const root = resolve(evidenceRoot);
  await mkdir(root, { recursive: true });
  const documents = [
    "# Model X model card\nModel X has 7B parameters.\nThe model uses a transformer architecture.\n",
    "# Model X technical note\nThe published parameter count for Model X is 7 billion.\nThis note refers to the base model.\n",
  ];
  const documentServer = createServer((request, response) => {
    const index = request.url === "/model.md" ? 0 : request.url === "/note.md" ? 1 : -1;
    if (index < 0) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
    response.end(documents[index]);
  });
  await new Promise<void>((done) => documentServer.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${(documentServer.address() as AddressInfo).port}`;
  const urls = [`${base}/model.md`, `${base}/note.md`];
  let providerCalls = 0;
  const host = createSourceDiscoveryHost({ tavilyApiKey: "scripted-local-provider" }, async () => {
    providerCalls += 1;
    return new Response(
      JSON.stringify({
        results: urls.map((url, index) => ({
          url,
          title: `Model X source ${index + 1}`,
          content: "Read the captured document for evidence.",
        })),
      }),
    );
  });
  let services: KnowledgeServices | undefined;
  let closeRoute: (() => Promise<void>) | undefined;
  const producerAttemptId = randomUUID();
  const captureRunId = randomUUID();
  const open = async (directory: string) => {
    const executor = await VerificationExecutor.create(
      loadExecutorConfig({
        VERIFY_STORE_DIR: directory,
        VERIFY_TENANT_ID: scope.tenant,
        VERIFY_PRODUCER_ATTEMPT_ID: producerAttemptId,
        VERIFY_VERIFIER_ATTEMPT_ID: randomUUID(),
      }),
    );
    const knowledge = createKnowledgeServices(
      {
        databaseUrl,
        storage,
        defaultTenantId: scope.tenant,
        artifactDir: join(directory, "ledger"),
        workspaceDir: resolve(import.meta.dirname, "../../../../../../../aiengineer/ai-engineer-db-contract/workspace"),
        allowStale: false,
        useClassesFile: defaultUseClassesFile(),
      },
      { verification: executor, sourceDiscoveryHost: host },
    );
    services = knowledge;
    return { executor, knowledge };
  };
  const checks: Record<string, string> = {};
  const refusal = async (label: string, operation: () => Promise<unknown>) => {
    try {
      await operation();
    } catch (error) {
      checks[label] = error instanceof Error ? error.message : String(error);
      return;
    }
    throw new Error(`PHASE0_EXPECTED_REFUSAL:${label}`);
  };
  try {
    const producer = await open(join(root, "producer-store"));
    const request = {
      schemaVersion: "source-discovery-managed-request.v1",
      providerCode: "tavily",
      queryText: "Model X parameter count primary sources",
      purpose: "Bounded local source custody fixture",
      parameters: {},
      requestedUrls: [],
      idempotencyKey: `phase0:${scope.origin.invocationId}`,
    };
    const attempt = SourceDiscoveryAttemptSchema.parse(
      (await knowledgeOperations.invoke("source_discover", { request }, producer.knowledge)).output,
    );
    if (attempt.state !== "succeeded" || attempt.resultCount !== 2) throw new Error("PHASE0_DISCOVERY_FAILED");
    const replay = (await knowledgeOperations.invoke("source_discover", { request }, producer.knowledge)).output;
    if (JSON.stringify(replay) !== JSON.stringify(attempt) || providerCalls !== 1)
      throw new Error("PHASE0_DISCOVERY_REPLAY_FAILED");
    const selection = (
      await knowledgeOperations.invoke(
        "source_select",
        {
          request: {
            schemaVersion: "source-discovery-selection.v1",
            attemptId: attempt.attemptId,
            idempotencyKey: `select:${scope.origin.invocationId}`,
            decisions: [1, 2].map((rank) => ({
              rank,
              disposition: "selected",
              reason: "Capture full local source bytes",
            })),
          },
        },
        producer.knowledge,
      )
    ).output;
    const captures = [],
      bridges = [];
    const quotes = ["Model X has 7B parameters.", "The published parameter count for Model X is 7 billion."];
    for (let index = 0; index < urls.length; index += 1) {
      const captured = await producer.executor.captureSource({
        url: urls[index]!,
        method: "https_get",
        runId: captureRunId,
      });
      captures.push(captured);
    }
    const assignment = {
      tenantId: scope.tenant,
      callerId: "phase0-host",
      runId: captureRunId,
      parentSessionId: "phase0-parent",
      assignmentId: "phase0-fragments",
      producerAttemptId,
      role: "producer",
      pinSha256: "a".repeat(64),
      grantId: "phase0-fragments",
      readScope: captures.map((item) => item.captureId),
      allowedOperations: ["verify_capture_fragment"],
      namespace: `${scope.tenant}/${captureRunId}/phase0-fragments`,
      deadline: new Date(Date.now() + 60_000).toISOString(),
    };
    const access = new ScopedExecutorAccess({
      grants: [{ assignment, operations: scopedCustodyOperations(producer.executor) }],
    });
    const routeToken = randomBytes(24).toString("hex");
    const routeServer = createHttpServer(producer.executor, { token: routeToken, scopedAccess: access });
    await new Promise<void>((done) => routeServer.listen(0, "127.0.0.1", done));
    closeRoute = () => new Promise<void>((done) => routeServer.close(() => done()));
    const endpoint = `http://127.0.0.1:${(routeServer.address() as AddressInfo).port}`;
    const routeCalls: unknown[] = [];
    const invoke = async (payload: unknown, assigned: unknown = assignment) => {
      const response = await fetch(`${endpoint}/scoped/invoke`, {
        method: "POST",
        headers: { authorization: `Bearer ${routeToken}`, "content-type": "application/json" },
        body: JSON.stringify({ assignment: assigned, operation: "verify_capture_fragment", payload }),
      });
      const result = await response.json();
      routeCalls.push({ operation: "verify_capture_fragment", status: response.status, payload, result });
      if (!response.ok) throw new Error(JSON.stringify(result));
      return result as Awaited<ReturnType<typeof captureFragment>>;
    };
    const catalogResponse = await fetch(`${endpoint}/scoped/catalog`, {
      method: "POST",
      headers: { authorization: `Bearer ${routeToken}`, "content-type": "application/json" },
      body: JSON.stringify({ assignment }),
    });
    if (!catalogResponse.ok) throw new Error("PHASE0_CATALOG_UNAVAILABLE");
    const catalog = await catalogResponse.json();
    for (let index = 0; index < captures.length; index += 1) {
      const captured = captures[index]!;
      bridges.push(
        await invoke({
          id: `phase0-fragment-${index + 1}`,
          binding: scope.binding,
          captureId: captured.captureId,
          representationDigest: captured.contentArtifact.digest,
          quote: quotes[index]!,
          access: { rights: "public", limits: [] },
        }),
      );
    }
    const first = captures[0]!,
      bridge = bridges[0]!;
    const bridgeInput = {
      id: bridge.fragment.id,
      binding: scope.binding,
      captureId: first.captureId,
      representationDigest: first.contentArtifact.digest,
      quote: quotes[0]!,
      access: { rights: "public" as const, limits: [] },
    };
    if (JSON.stringify(await invoke(bridgeInput)) !== JSON.stringify(bridge))
      throw new Error("PHASE0_BRIDGE_REPLAY_FAILED");
    await refusal("missing_digest", () => invoke({ ...bridgeInput, representationDigest: "" }));
    await refusal("wrong_digest", () =>
      invoke({
        ...bridgeInput,
        representationDigest: `sha256:${"0".repeat(64)}`,
      }),
    );
    await refusal("wrong_scope", () => invoke(bridgeInput, { ...assignment, tenantId: "wrong-tenant" }));
    await refusal("unassigned_capture", () => invoke({ ...bridgeInput, captureId: "unassigned-capture" }));
    const unauthenticated = await fetch(`${endpoint}/scoped/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assignment, operation: "verify_capture_fragment", payload: bridgeInput }),
    });
    if (unauthenticated.status !== 401) throw new Error("PHASE0_AUTH_REFUSAL_MISSING");
    checks.unauthenticated = "HTTP_401";
    await writeFile(
      join(root, "public-fragment-route.json"),
      JSON.stringify(
        { endpoint, catalog, assignment, routeCalls, unauthenticatedStatus: unauthenticated.status },
        null,
        2,
      ),
    );
    await closeRoute();
    closeRoute = undefined;
    await producer.knowledge.close();
    services = undefined;
    const old = resolve(root, "producer-store"),
      retained = resolve(root, "retired-producer-store");
    if (![old, retained].every((path) => path.startsWith(root + sep))) throw new Error("PHASE0_STORAGE_PATH_DENIED");
    await rename(old, retained);
    const consumer = await open(join(root, "reconstructed-store"));
    const reader: ExternalCustodyReader = createCaptureCustodyReader(consumer.executor.store);
    for (let index = 0; index < bridges.length; index += 1) {
      const item = bridges[index]!;
      const bytes = await reader.get(scope, item.fragment.representation);
      if (!bytes || Buffer.from(bytes).toString("utf8") !== documents[index])
        throw new Error("PHASE0_RECONSTRUCTION_FAILED");
      const record = await readCaptureProvenance(consumer.executor.store, scope, item.fragment.sourceVersion);
      if (
        record.captureId !== captures[index]!.captureId ||
        record.contentArtifact.artifactId !== item.fragment.representation.id
      )
        throw new Error("PHASE0_PROVENANCE_FAILED");
    }
    await refusal("read_wrong_digest", () =>
      reader.get(scope, { ...bridge.fragment.capture, digest: `sha256:${"0".repeat(64)}` }),
    );
    await refusal("read_wrong_binding", () =>
      reader.get(scope, { ...bridge.fragment.capture, binding: "other-binding" }),
    );
    await refusal("discovery_wrong_scope", () =>
      knowledgeOperations.invoke(
        "source_attempt",
        { attemptId: attempt.attemptId, tenantId: "00000000-0000-4000-8000-000000000099" },
        consumer.knowledge,
      ),
    );
    const restored = (
      await knowledgeOperations.invoke("source_attempt", { attemptId: attempt.attemptId }, consumer.knowledge)
    ).output;
    const evidence = {
      attempt,
      selection,
      restored,
      captures,
      bridges,
      providerCalls,
      checks,
      captureRunId,
      reconstructed: true,
    };
    await writeFile(join(root, "capture-custody.json"), JSON.stringify(evidence, null, 2));
    for (let index = 0; index < documents.length; index += 1)
      await writeFile(join(root, `source-${index + 1}.md`), documents[index]!);
    return {
      ...evidence,
      externalCustody: reader,
      close: async () => {
        await services?.close();
        await new Promise<void>((done) => documentServer.close(() => done()));
      },
    };
  } catch (error) {
    await closeRoute?.();
    await services?.close();
    await new Promise<void>((done) => documentServer.close(() => done()));
    throw error;
  }
}
