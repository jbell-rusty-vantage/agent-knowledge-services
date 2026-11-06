import { describe, expect, it, vi } from "vitest";
import type { VerificationParserOutput, VerificationParserRequest } from "@aiengineer/knowledge-preparation";
import type {
  OperationContext,
  VerificationArtifactHandle,
  VerificationSource,
  VerificationSourceCapture,
} from "@aiengineer/knowledge-contracts";
import { deterministicUuid } from "@aiengineer/knowledge-core";
import {
  admitExtractionSchema,
  canonicalizeJson,
  digestCanonicalJson,
  sha256Digest,
  type TrustedArtifactResolver,
} from "@aiengineer/knowledge-verification";
import {
  VerificationAdmissionService,
  type ProjectionAdmissionReceipt,
  type RegisterAdmissionArtifactInput,
  type VerificationParserDeployment,
} from "../admission/verification-admission.js";
import {
  VerificationOperationApplicationService,
  VerificationOperationExecutor,
  VerificationServiceCatalog,
  type VerificationOperationRepositoryPort,
} from "./verification-service.js";

const enc = new TextEncoder(),
  tenant = "11111111-1111-4111-8111-111111111111",
  sourceId = "22222222-2222-4222-8222-222222222222";
const image = `sha256:${"9".repeat(64)}` as const;
const limits = {
  inputBytes: 8_000_000,
  outputBytes: 4_000_000,
  timeoutMs: 45_000,
  memoryBytes: 536_870_912,
  cpuSeconds: 15,
  cpus: 1,
  temporaryBytes: 67_108_864,
  pages: 40,
  pids: 32,
};
const deployment: VerificationParserDeployment = {
  parserVersion: "verification-native-parser.v1",
  imageDigest: image,
  limits,
};
const source: VerificationSource = {
  sourceId,
  kind: "web_page",
  canonicalUri: "https://example.test/source",
  logicalIdentity: "fixture:source",
};

function handle(
  bytes: Uint8Array,
  mediaType: string,
  parents: readonly string[] = [],
  signature?: `sha256:${string}`,
): VerificationArtifactHandle {
  const digest = sha256Digest(bytes);
  return {
    artifactId: deterministicUuid("artifact", `${tenant}:${digest}`),
    tenantId: tenant,
    digest,
    mediaType,
    byteLength: bytes.byteLength,
    objectKey: `${tenant}/${digest.slice(7, 9)}/${digest.slice(7)}`,
    createdAt: "2026-09-05T12:00:00.000Z",
    producerActivityId: "fixture",
    producerVersion: "1",
    encryptionClass: "managed",
    retentionClass: "verification",
    dataClassification: "restricted",
    parentArtifactIds: [...parents],
    ...(signature ? { transformationSignature: signature } : {}),
  };
}
class MemoryRepository implements VerificationOperationRepositoryPort {
  artifacts = new Map<string, { registration: VerificationArtifactHandle; bytes: Uint8Array }>();
  captures = new Map<string, { source: VerificationSource; capture: VerificationSourceCapture }>();
  registrations: RegisterAdmissionArtifactInput[] = [];
  add(value: unknown, mediaType = "application/json") {
    const bytes = enc.encode(typeof value === "string" ? value : canonicalizeJson(value)),
      registration = handle(bytes, mediaType);
    this.artifacts.set(registration.artifactId, { registration, bytes });
    return registration;
  }
  createTrustedArtifactResolver(): TrustedArtifactResolver {
    let ticket: string | undefined;
    return {
      authorizeArtifact: async ({ tenantId, artifactId }) => {
        if (tenantId !== tenant || !this.artifacts.has(artifactId)) throw new Error("FORBIDDEN");
        ticket = artifactId;
      },
      hydrateRegisteredArtifact: async ({ tenantId, artifactId }) => {
        if (tenantId !== tenant || ticket !== artifactId) throw new Error("NOT_AUTHORIZED");
        ticket = undefined;
        const item = this.artifacts.get(artifactId)!;
        return { registration: structuredClone(item.registration), bytes: Uint8Array.from(item.bytes) };
      },
    };
  }
  async getRegisteredCapture({ tenantId, captureId }: { tenantId: string; captureId: string }) {
    const value = this.captures.get(`${tenantId}:${captureId}`);
    if (!value) throw new Error("CAPTURE_NOT_REGISTERED");
    return structuredClone(value);
  }
  async recordCapture({
    tenantId,
    source,
    capture,
  }: {
    tenantId: string;
    source: VerificationSource;
    capture: VerificationSourceCapture;
    producerAttemptId: string;
  }) {
    const key = `${tenantId}:${capture.captureId}`,
      prior = this.captures.get(key);
    if (prior && canonicalizeJson(prior) !== canonicalizeJson({ source, capture }))
      throw new Error("CAPTURE_IDENTITY_COLLISION");
    this.captures.set(key, structuredClone({ source, capture }));
  }
  async registerContentAddressedArtifact(input: RegisterAdmissionArtifactInput) {
    this.registrations.push(input);
    for (const parent of input.parentArtifactIds ?? [])
      if (!this.artifacts.has(parent)) throw new Error("PARENT_MISSING");
    const registration = handle(input.bytes, input.mediaType, input.parentArtifactIds, input.transformationSignature),
      prior = this.artifacts.get(registration.artifactId);
    if (prior) return structuredClone(prior.registration);
    this.artifacts.set(registration.artifactId, { registration, bytes: Uint8Array.from(input.bytes) });
    return structuredClone(registration);
  }
}
function parserResult(request: VerificationParserRequest): VerificationParserOutput {
  const projections = [
      {
        kind: "html_dom",
        document: { tag: "html", children: [{ tag: "body", children: [{ tag: "#text", text: "Exact value 42" }] }] },
        canonicalText: "Exact value 42",
      },
    ],
    residuals = [{ code: "CSS_LAYOUT_NOT_EXECUTED", detail: "Computed layout remains unresolved." }],
    nativeOutput = enc.encode(
      JSON.stringify({
        parserVersion: "verification-native-parser.v1",
        parentDigest: request.parentDigest,
        projections,
        residuals,
      }),
    );
  return {
    parserVersion: "verification-native-parser.v1",
    parentDigest: request.parentDigest,
    projections,
    residuals,
    nativeOutput,
    nativeOutputDigest: sha256Digest(nativeOutput),
    imageDigest: image,
    transformationSignature: digestCanonicalJson({
      parserVersion: "verification-native-parser.v1",
      imageDigest: image,
      limits: { ...limits },
      kind: request.kind,
    }),
  };
}
const context = (operationId: string): OperationContext => ({
  tenantId: tenant,
  operationId,
  attemptId: "33333333-3333-4333-8333-333333333333",
  correlationId: `correlation-${operationId}`,
  actor: { kind: "service", id: "44444444-4444-4444-8444-444444444444", serviceIdentity: "knowledge_worker" },
  capabilityVersion: "verification-service.v1",
  idempotencyKey: `verification-${operationId}`,
  reason: "bounded verification fixture",
  contractVersion: "v1",
});

describe("verification durable application slice", () => {
  it("requires an exact capture plus complete immutable handle for parseArtifact grants", () => {
    const sourceArtifact = handle(enc.encode("parse source"), "text/html"),
      captureId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const catalog = new VerificationServiceCatalog({
      captureGrants: [],
      extractionProfileArtifacts: [],
      parseArtifactGrants: [{ captureId, sourceArtifact, parserKind: "html" }],
    });
    expect(catalog.hasParseArtifactGrants()).toBe(true);
    expect(catalog.parseArtifact(captureId, sourceArtifact).parserKind).toBe("html");
    expect(
      catalog.admitsParseArtifact({ verificationContractVersion: "verification.v1", captureId, sourceArtifact }),
    ).toBe(true);
    expect(
      catalog.admitsParseArtifact({
        verificationContractVersion: "verification.v1",
        captureId,
        sourceArtifact: { ...sourceArtifact, objectKey: "other/key" },
      }),
    ).toBe(false);
    expect(() => catalog.parseArtifact("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", sourceArtifact)).toThrow(
      "VERIFICATION_PARSE_ARTIFACT_GRANT_REQUIRED",
    );
  });
  it("strictly admits only bounded public requests before durable submission", async () => {
    const submit = vi.fn(async () => ({ operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" })),
      service = new VerificationOperationApplicationService({ submit } as never, "http://localhost:3000");
    const request = {
      verificationContractVersion: "verification.v1",
      source: {
        mode: "register",
        sourceKind: "web_page",
        sourceId,
        contentArtifact: { artifactId: "55555555-5555-4555-8555-555555555555", digest: `sha256:${"1".repeat(64)}` },
      },
      requestedProjectionKinds: ["html_dom"],
    };
    await service.submitCaptureSource(request, context("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"));
    expect(submit).toHaveBeenCalledWith(
      "verification_capture",
      expect.objectContaining({ input: expect.objectContaining({ useCase: "captureSource" }) }),
      "http://localhost:3000",
    );
    expect(() =>
      service.submitCaptureSource(
        { ...request, grant: { allowed: true } },
        context("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
      ),
    ).toThrow();
    expect(() =>
      service.submitCaptureSource(
        { ...request, source: { mode: "acquire", sourceKind: "web_page", sourceUri: "https://example.test" } },
        context("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
      ),
    ).toThrow("VERIFICATION_CAPTURE_MODE_NOT_ADMITTED");
  });

  it("registers parentless native projection lineage, verifies fields, and replays from registered bytes", async () => {
    const repository = new MemoryRepository(),
      sourceArtifact = repository.add("<html><body>Exact value 42</body></html>", "text/html");
    const admission = new VerificationAdmissionService(
      repository,
      { parse: async (request) => parserResult(request) },
      deployment,
      {
        storageBucket: "verification-artifacts",
        producerVersion: "verification-admission.v1",
        encryptionClass: "managed",
        retentionClass: "verification",
        now: () => "2026-09-05T12:00:00.000Z",
      },
    );
    const active = new Set<string>(),
      completed = new Map<string, VerificationArtifactHandle>();
    const makeExecutor = (catalog: VerificationServiceCatalog) =>
      new VerificationOperationExecutor(
        repository,
        admission,
        {
          loadResultArtifact: async ({ operationId }) => {
            const found = completed.get(operationId);
            if (!found) throw new Error("MISSING");
            return found;
          },
        },
        {
          assertActive: async ({ operationId }) => {
            if (!active.has(operationId)) throw new Error("VERIFICATION_OPERATION_CANCELLED");
          },
        },
        catalog,
        {
          storageBucket: "verification-artifacts",
          producerVersion: "verification-service.v1",
          encryptionClass: "managed",
          retentionClass: "verification",
          now: () => "2026-09-05T12:00:00.000Z",
        },
      );
    const captureOperation = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    active.add(captureOperation);
    const captureCatalog = new VerificationServiceCatalog({
      captureGrants: [
        {
          source,
          contentArtifact: {
            artifactId: sourceArtifact.artifactId,
            digest: sourceArtifact.digest as `sha256:${string}`,
          },
          capturedAt: sourceArtifact.createdAt,
          captureMethod: "registered_artifact",
          captureMethodVersion: "1",
          parserKind: "html",
          projectionKinds: ["html_dom"],
        },
      ],
      extractionProfileArtifacts: [],
    });
    const captureRequest = {
      verificationContractVersion: "verification.v1",
      source: {
        mode: "register" as const,
        sourceKind: "web_page" as const,
        sourceId,
        contentArtifact: { artifactId: sourceArtifact.artifactId, digest: sourceArtifact.digest },
      },
      requestedProjectionKinds: ["html_dom" as const],
    };
    const capture = await makeExecutor(captureCatalog).execute(
      "verification_capture",
      { schemaVersion: "verification-service-request.v1", useCase: "captureSource", request: captureRequest },
      context(captureOperation),
    );
    const captureOutput = capture.output as Record<string, unknown>,
      captureBinding = captureOutput.capture as VerificationSourceCapture,
      projection = (captureOutput.projections as unknown as ProjectionAdmissionReceipt[])[0]!;
    expect(projection.projectionArtifact.parentArtifactIds).toEqual([]);
    expect(projection.transformationArtifact.parentArtifactIds).toEqual(
      expect.arrayContaining([sourceArtifact.artifactId, projection.projectionArtifact.artifactId]),
    );
    const profile = {
      schemaVersion: "verification-extraction-profile.v1",
      sourceArtifact: { artifactId: sourceArtifact.artifactId, digest: sourceArtifact.digest },
      extractionSchema: {
        schemaId: "fixture-field",
        schemaVersion: "1",
        schema: {
          type: "object",
          description: "Fixture output.",
          properties: { value: { type: "string", description: "Exact source value.", maxLength: 32 } },
          required: ["value"],
          additionalProperties: false,
        },
      },
      fields: [{ path: "/value", comparison: "exact" }],
      evidence: [
        {
          path: "/value",
          captureId: captureBinding.captureId,
          projectionArtifactId: projection.projectionArtifact.artifactId,
          transformationArtifactId: projection.transformationArtifact.artifactId,
          selector: { kind: "html", domPath: "0/0" },
        },
      ],
      normalizations: [],
      duplicates: [],
      totals: [],
    };
    const profileArtifact = repository.add(profile),
      candidateArtifact = repository.add({ value: "Exact value 42" });
    const catalog = new VerificationServiceCatalog({
      captureGrants: [],
      extractionProfileArtifacts: [
        { artifactId: profileArtifact.artifactId, digest: profileArtifact.digest as `sha256:${string}` },
      ],
    });
    const executor = makeExecutor(catalog),
      verifyOperation = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    active.add(verifyOperation);
    const verifyRequest = {
      verificationContractVersion: "verification.v1",
      captureIds: [captureBinding.captureId],
      extractionSchema: { artifactId: profileArtifact.artifactId, digest: profileArtifact.digest },
      extractionOutput: { artifactId: candidateArtifact.artifactId, digest: candidateArtifact.digest },
    };
    const verified = await executor.execute(
      "verification_extraction",
      { schemaVersion: "verification-service-request.v1", useCase: "verifyExtraction", request: verifyRequest },
      context(verifyOperation),
    );
    expect((verified.output as Record<string, unknown>).result).toMatchObject({
      schemaVersion: "verification-extraction-field-evidence.v1",
      valid: true,
      acceptedLeaves: [
        {
          path: "/value",
          lineage: {
            sourceArtifact: { artifactId: sourceArtifact.artifactId },
            projectionArtifact: { artifactId: projection.projectionArtifact.artifactId },
          },
        },
      ],
    });
    expect(verified.boundArtifacts.map((item) => item.artifactId)).toEqual(
      expect.arrayContaining([
        profileArtifact.artifactId,
        candidateArtifact.artifactId,
        sourceArtifact.artifactId,
        projection.nativeOutputArtifact.artifactId,
        projection.transformationArtifact.artifactId,
        projection.projectionArtifact.artifactId,
      ]),
    );
    expect(new Set(verified.boundArtifacts.map((item) => item.artifactId)).size).toBe(verified.boundArtifacts.length);
    completed.set(verifyOperation, verified.resultArtifact);
    const replayOperation = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    active.add(replayOperation);
    const replayed = await executor.execute(
      "verification_replay",
      {
        schemaVersion: "verification-service-request.v1",
        useCase: "replayRun",
        request: {
          verificationContractVersion: "verification.v1",
          runId: verifyOperation,
          replayMode: "deterministic_only",
        },
      },
      context(replayOperation),
    );
    expect(replayed.output).toMatchObject({
      replayMatched: true,
      result: { schemaVersion: "verification-extraction-field-evidence.v1", valid: true },
    });
    expect(repository.registrations.filter((item) => item.artifactType === "verification_bundle")).toHaveLength(1);
    expect(
      repository.registrations.filter((item) => item.artifactType === "deterministic_verification_result"),
    ).toHaveLength(2);
    const legacyOperation = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      legacyResult = await admission.verifyExtraction({
        tenantId: tenant,
        expectedSourceArtifact: {
          artifactId: sourceArtifact.artifactId,
          digest: sourceArtifact.digest as `sha256:${string}`,
        },
        schema: admitExtractionSchema(profile.extractionSchema).schema!,
        candidate: { value: "Exact value 42" },
        fields: profile.fields as never,
        evidence: profile.evidence as never,
        normalizations: [],
        duplicates: [],
        totals: [],
      }),
      legacyArtifact = repository.add({
        schemaVersion: "verification-operation-result.v1",
        operationId: legacyOperation,
        useCase: "verifyExtraction",
        requestDigest: digestCanonicalJson(verifyRequest),
        boundArtifacts: [],
        output: { request: verifyRequest, result: legacyResult },
      });
    completed.set(legacyOperation, legacyArtifact);
    const legacyReplayOperation = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    active.add(legacyReplayOperation);
    const legacyReplay = await executor.execute(
      "verification_replay",
      {
        schemaVersion: "verification-service-request.v1",
        useCase: "replayRun",
        request: {
          verificationContractVersion: "verification.v1",
          runId: legacyOperation,
          replayMode: "deterministic_only",
        },
      },
      context(legacyReplayOperation),
    );
    expect((legacyReplay.output as Record<string, unknown>).result).toEqual(legacyResult);
    const malformedOperation = "12121212-1212-4121-8121-121212121212",
      malformedArtifact = repository.add({
        schemaVersion: "verification-operation-result.v1",
        operationId: malformedOperation,
        useCase: "verifyExtraction",
        requestDigest: digestCanonicalJson(verifyRequest),
        boundArtifacts: [],
        output: {
          request: verifyRequest,
          result: {
            ...((verified.output as Record<string, unknown>).result as Record<string, unknown>),
            unexpected: "rejected",
          },
        },
      });
    completed.set(malformedOperation, malformedArtifact);
    active.add("13131313-1313-4131-8131-131313131313");
    await expect(
      executor.execute(
        "verification_replay",
        {
          schemaVersion: "verification-service-request.v1",
          useCase: "replayRun",
          request: {
            verificationContractVersion: "verification.v1",
            runId: malformedOperation,
            replayMode: "deterministic_only",
          },
        },
        context("13131313-1313-4131-8131-131313131313"),
      ),
    ).rejects.toThrow("VERIFICATION_REPLAY_RESULT_SHAPE_UNSUPPORTED");
  });

  it("snapshots configured grants and cancels a running parser before result registration", async () => {
    const repository = new MemoryRepository(),
      sourceArtifact = repository.add("<html><body>cancel</body></html>", "text/html");
    const mutableGrant = {
      source: { ...source },
      contentArtifact: { artifactId: sourceArtifact.artifactId, digest: sourceArtifact.digest as `sha256:${string}` },
      capturedAt: sourceArtifact.createdAt,
      captureMethod: "registered_artifact",
      captureMethodVersion: "1",
      parserKind: "html" as const,
      projectionKinds: ["html_dom"] as ["html_dom"],
    };
    const catalog = new VerificationServiceCatalog({ captureGrants: [mutableGrant], extractionProfileArtifacts: [] });
    mutableGrant.source.logicalIdentity = "mutated-after-configuration";
    expect(catalog.capture(sourceId, sourceArtifact)).toMatchObject({ source: { logicalIdentity: "fixture:source" } });
    let assertions = 0;
    const admission = new VerificationAdmissionService(
      repository,
      {
        parse: async (request) =>
          new Promise<VerificationParserOutput>((_resolve, reject) =>
            request.signal!.addEventListener("abort", () => reject(new Error("PARSER_CANCELLED")), { once: true }),
          ),
      },
      deployment,
      {
        storageBucket: "verification-artifacts",
        producerVersion: "verification-admission.v1",
        encryptionClass: "managed",
        retentionClass: "verification",
        now: () => "2026-09-05T12:00:00.000Z",
      },
    );
    const executor = new VerificationOperationExecutor(
      repository,
      admission,
      {
        loadResultArtifact: async () => {
          throw new Error("UNUSED");
        },
      },
      {
        assertActive: async () => {
          assertions += 1;
          if (assertions >= 3) throw new Error("VERIFICATION_OPERATION_CANCELLED");
        },
      },
      catalog,
      {
        storageBucket: "verification-artifacts",
        producerVersion: "verification-service.v1",
        encryptionClass: "managed",
        retentionClass: "verification",
        now: () => "2026-09-05T12:00:00.000Z",
        cancellationPollMs: 25,
      },
    );
    const operationId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      request = {
        verificationContractVersion: "verification.v1",
        source: {
          mode: "register" as const,
          sourceKind: "web_page" as const,
          sourceId,
          contentArtifact: { artifactId: sourceArtifact.artifactId, digest: sourceArtifact.digest },
        },
        requestedProjectionKinds: ["html_dom" as const],
      };
    await expect(
      executor.execute(
        "verification_capture",
        { schemaVersion: "verification-service-request.v1", useCase: "captureSource", request },
        context(operationId),
      ),
    ).rejects.toThrow("VERIFICATION_OPERATION_CANCELLED");
    expect(repository.registrations).toHaveLength(0);
  });
});
