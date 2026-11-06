import { describe, expect, it, vi } from "vitest";
import type {
  OperationContext,
  VerificationArtifactHandle,
  VerificationSource,
  VerificationSourceCapture,
} from "@aiengineer/knowledge-contracts";
import { deterministicUuid } from "@aiengineer/knowledge-core";
import {
  canonicalizeJson,
  digestCanonicalJson,
  sha256Digest,
  type TrustedArtifactResolver,
} from "@aiengineer/knowledge-verification";
import type { VerificationParserOutput, VerificationParserRequest } from "@aiengineer/knowledge-preparation";
import {
  VerificationAdmissionService,
  type RegisterAdmissionArtifactInput,
  type VerificationParserDeployment,
} from "../admission/verification-admission.js";
import {
  VerificationOperationExecutor,
  VerificationServiceCatalog,
  type VerificationOperationRepositoryPort,
} from "../operations/verification-service.js";
import type { AcquiredVerificationSource, VerificationSourceAcquirer } from "./verification-source-acquisition.js";

const encoder = new TextEncoder();
const tenant = "11111111-1111-4111-8111-111111111111",
  otherTenant = "99999999-9999-4999-8999-999999999999";
const source: VerificationSource = {
  sourceId: "22222222-2222-4222-8222-222222222222",
  kind: "web_page",
  canonicalUri: "https://source.example/report",
  logicalIdentity: "fixture:acquired-source",
};
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
  imageDigest: `sha256:${"a".repeat(64)}`,
  limits,
};
const context = (operationId: string, tenantId = tenant): OperationContext => ({
  tenantId,
  operationId,
  attemptId: "33333333-3333-4333-8333-333333333333",
  correlationId: `correlation-${operationId}`,
  actor: { kind: "service", id: "44444444-4444-4444-8444-444444444444", serviceIdentity: "knowledge_worker" },
  capabilityVersion: "verification-service.v1",
  idempotencyKey: `key-${operationId}`,
  reason: "acquisition fixture",
  contractVersion: "v1",
});
const request = {
  verificationContractVersion: "verification.v1" as const,
  source: { mode: "acquire" as const, sourceKind: "web_page" as const, sourceUri: source.canonicalUri },
  requestedProjectionKinds: ["html_dom" as const],
};
const operationInput = {
  schemaVersion: "verification-service-request.v1" as const,
  useCase: "captureSource" as const,
  request,
};

function handle(
  bytes: Uint8Array,
  mediaType: string,
  parents: readonly string[] = [],
  signature?: `sha256:${string}`,
): VerificationArtifactHandle {
  const digest = sha256Digest(bytes);
  return {
    artifactId: deterministicUuid("acquisition-test-artifact", `${tenant}:${digest}`),
    tenantId: tenant,
    digest,
    mediaType,
    byteLength: bytes.byteLength,
    objectKey: `private/${digest.slice(7)}`,
    createdAt: "2026-09-07T00:00:00.000Z",
    producerActivityId: "fixture",
    producerVersion: "v1",
    encryptionClass: "managed",
    retentionClass: "verification",
    dataClassification: "restricted",
    parentArtifactIds: [...parents],
    ...(signature ? { transformationSignature: signature } : {}),
  };
}

class Repository implements VerificationOperationRepositoryPort {
  readonly artifacts = new Map<string, { registration: VerificationArtifactHandle; bytes: Uint8Array }>();
  readonly captures = new Map<string, { source: VerificationSource; capture: VerificationSourceCapture }>();
  readonly registrations: RegisterAdmissionArtifactInput[] = [];
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
    const registration = handle(input.bytes, input.mediaType, input.parentArtifactIds, input.transformationSignature);
    const prior = this.artifacts.get(registration.artifactId);
    if (prior) return structuredClone(prior.registration);
    this.artifacts.set(registration.artifactId, { registration, bytes: Uint8Array.from(input.bytes) });
    return structuredClone(registration);
  }
}

function parser(request: VerificationParserRequest): VerificationParserOutput {
  const projections = [
      {
        kind: "html_dom" as const,
        document: { tag: "html", children: [{ tag: "body", children: [{ tag: "#text", text: "Acquired value" }] }] },
        canonicalText: "Acquired value",
      },
    ],
    residuals = [{ code: "CSS_LAYOUT_NOT_EXECUTED", detail: "Fixture parser does not execute layout." }];
  const nativeOutput = encoder.encode(
    canonicalizeJson({
      parserVersion: deployment.parserVersion,
      parentDigest: request.parentDigest,
      projections,
      residuals,
    }),
  );
  return {
    parserVersion: deployment.parserVersion,
    parentDigest: request.parentDigest,
    projections,
    residuals,
    nativeOutput,
    nativeOutputDigest: sha256Digest(nativeOutput),
    imageDigest: deployment.imageDigest,
    transformationSignature: digestCanonicalJson({
      parserVersion: deployment.parserVersion,
      imageDigest: deployment.imageDigest,
      limits,
      kind: request.kind,
    }),
  };
}

function setup(options: {
  readonly source?: VerificationSource;
  readonly acquirer: VerificationSourceAcquirer["acquire"];
  readonly assertActive?: (value: { tenantId: string; operationId: string }) => Promise<void>;
  readonly parse?: (request: VerificationParserRequest) => VerificationParserOutput;
}) {
  const repository = new Repository();
  const admission = new VerificationAdmissionService(
    repository,
    { parse: async (value) => (options.parse ?? parser)(value) },
    deployment,
    {
      storageBucket: "verification",
      producerVersion: "admission.v1",
      encryptionClass: "managed",
      retentionClass: "verification",
      now: () => "2026-09-07T00:00:00.000Z",
    },
  );
  const catalog = new VerificationServiceCatalog({
    captureGrants: [],
    acquisitionGrants: [{ tenantId: tenant, sourceKey: "fixture-source", source: options.source ?? source }],
    extractionProfileArtifacts: [],
  });
  const executor = new VerificationOperationExecutor(
    repository,
    admission,
    {
      loadResultArtifact: async () => {
        throw new Error("UNUSED");
      },
    },
    { assertActive: options.assertActive ?? (async () => {}) },
    catalog,
    {
      storageBucket: "verification",
      producerVersion: "service.v1",
      encryptionClass: "managed",
      retentionClass: "verification",
      now: () => "2026-09-07T00:00:00.000Z",
      cancellationPollMs: 25,
    },
    { acquire: options.acquirer },
  );
  return { repository, executor };
}
const acquired = (): AcquiredVerificationSource => {
  const bytes = encoder.encode("<html>Acquired value</html>");
  return {
    sourceKey: "fixture-source",
    sourceUri: source.canonicalUri,
    finalUri: source.canonicalUri,
    redirectUris: [],
    status: 200,
    mediaType: "text/html",
    capturedAt: "2026-09-07T00:00:00.000Z",
    responseMetadata: { contentLength: bytes.byteLength },
    bytes,
  };
};

describe("verification capture acquire executor", () => {
  it("captures and recovers both PDF projections with one shared native output", async () => {
    const pdfSource: VerificationSource = { ...source, kind: "pdf" };
    const pdfInput = {
      ...operationInput,
      request: {
        ...request,
        source: { ...request.source, sourceKind: "pdf" },
        requestedProjectionKinds: ["pdf_text", "geometry"],
      },
    };
    const acquire = vi.fn(async () => ({ ...acquired(), mediaType: "application/pdf" }));
    const parse = vi.fn((input: VerificationParserRequest): VerificationParserOutput => {
      expect(input.kind).toBe("pdf");
      const text = "Acquired value";
      const projections = [
        {
          kind: "pdf_text",
          pageCount: 1,
          pages: [
            {
              physicalPageNumber: 1,
              text,
              textLayerDigest: sha256Digest(encoder.encode(text)),
              widthPoints: 600,
              heightPoints: 800,
            },
          ],
          residuals: [
            { kind: "unresolved_visual_content", physicalPageNumber: 1, detail: "Visual content not assessed" },
          ],
        },
        { kind: "geometry", pages: [{ physicalPageNumber: 1, widthPoints: 600, heightPoints: 800, tokens: [] }] },
      ];
      const residuals = [
        { code: "VISUAL_CONTENT_NOT_ASSESSED", physicalPageNumber: 1, detail: "Visual content not assessed" },
      ];
      const nativeOutput = encoder.encode(
        canonicalizeJson({
          parserVersion: deployment.parserVersion,
          parentDigest: input.parentDigest,
          projections,
          residuals,
        }),
      );
      return { ...parser(input), projections, residuals, nativeOutput, nativeOutputDigest: sha256Digest(nativeOutput) };
    });
    const { executor, repository } = setup({ source: pdfSource, acquirer: acquire, parse });
    const executionContext = context("abababab-abab-4bab-8bab-abababababab");
    const result = await executor.execute("verification_capture", pdfInput, executionContext);
    const output = result.output as any;
    expect(output.projections.map((item: any) => [item.projectionKind, item.projectionOrdinal])).toEqual([
      ["pdf_text", 0],
      ["geometry", 1],
    ]);
    expect(output.projections[0].nativeOutputArtifact).toEqual(output.projections[1].nativeOutputArtifact);
    expect(result.boundArtifacts).toHaveLength(7);
    expect(new Set(result.boundArtifacts.map((item) => item.artifactId)).size).toBe(7);
    expect(repository.artifacts.size).toBe(8);
    await executor.execute("verification_capture", pdfInput, executionContext);
    expect(acquire).toHaveBeenCalledTimes(1);
  });

  it("rejects PDF source-kind, projection-order and media mismatches before persistence", async () => {
    const acquire = vi.fn(async () => ({ ...acquired(), mediaType: "application/pdf" }));
    const { executor, repository } = setup({ acquirer: acquire });
    const executionContext = context("acacacac-acac-4cac-8cac-acacacacacac");
    for (const requestedProjectionKinds of [
      ["pdf_text", "geometry"],
      ["geometry", "pdf_text"],
    ]) {
      await expect(
        executor.execute(
          "verification_capture",
          {
            ...operationInput,
            request: { ...request, source: { ...request.source, sourceKind: "pdf" }, requestedProjectionKinds },
          },
          executionContext,
        ),
      ).rejects.toThrow("VERIFICATION_CAPTURE_MODE_NOT_ADMITTED");
    }
    expect(acquire).not.toHaveBeenCalled();
    await expect(executor.execute("verification_capture", operationInput, executionContext)).rejects.toThrow(
      "VERIFICATION_ACQUISITION_RESPONSE_BINDING",
    );
    expect(repository.registrations).toHaveLength(0);
  });

  it("registers raw acquired bytes and canonical receipt metadata before parser admission", async () => {
    const acquire = vi.fn(async () => acquired()),
      { repository, executor } = setup({ acquirer: acquire });
    const result = await executor.execute(
      "verification_capture",
      operationInput,
      context("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
    );
    expect(acquire).toHaveBeenCalledWith(expect.objectContaining({ sourceKey: "fixture-source" }));
    const output = result.output as any,
      receipt = output.acquisitionReceipt as VerificationArtifactHandle,
      capture = output.capture as VerificationSourceCapture;
    const raw = repository.artifacts.get(capture.contentArtifact.artifactId)!;
    expect(raw.registration.parentArtifactIds).toEqual([receipt.artifactId]);
    expect(new TextDecoder().decode(raw.bytes)).toBe("<html>Acquired value</html>");
    const metadata = JSON.parse(new TextDecoder().decode(repository.artifacts.get(receipt.artifactId)!.bytes));
    expect(metadata).toMatchObject({
      tenantId: tenant,
      operationId: context("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").operationId,
      sourceId: source.sourceId,
      contentDigest: raw.registration.digest,
      response: { sourceKey: "fixture-source", sourceUri: source.canonicalUri },
    });
    expect(output.projections).toHaveLength(1);
  });

  it("recovers the registered capture without a second acquisition", async () => {
    const acquire = vi.fn(async () => acquired()),
      { executor } = setup({ acquirer: acquire });
    const executionContext = context("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    await executor.execute("verification_capture", operationInput, executionContext);
    await executor.execute("verification_capture", operationInput, executionContext);
    expect(acquire).toHaveBeenCalledTimes(1);
  });

  it("rejects foreign tenants and ungranted URIs before acquisition", async () => {
    const acquire = vi.fn(async () => acquired()),
      { executor } = setup({ acquirer: acquire });
    await expect(
      executor.execute(
        "verification_capture",
        operationInput,
        context("cccccccc-cccc-4ccc-8ccc-cccccccccccc", otherTenant),
      ),
    ).rejects.toThrow("VERIFICATION_ACQUISITION_GRANT_REQUIRED");
    await expect(
      executor.execute(
        "verification_capture",
        {
          ...operationInput,
          request: { ...request, source: { ...request.source, sourceUri: "https://other.example/report" } },
        },
        context("dddddddd-dddd-4ddd-8ddd-dddddddddddd"),
      ),
    ).rejects.toThrow("VERIFICATION_ACQUISITION_GRANT_REQUIRED");
    expect(acquire).not.toHaveBeenCalled();
  });

  it("does not register artifacts when cancellation interrupts acquisition", async () => {
    let calls = 0;
    const { repository, executor } = setup({
      acquirer: ({ signal }) =>
        new Promise((_resolve, reject) =>
          signal?.addEventListener("abort", () => reject(new Error("ACQUISITION_CANCELLED")), { once: true }),
        ),
      assertActive: async () => {
        calls += 1;
        if (calls >= 3) throw new Error("VERIFICATION_OPERATION_CANCELLED");
      },
    });
    await expect(
      executor.execute("verification_capture", operationInput, context("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee")),
    ).rejects.toThrow("VERIFICATION_OPERATION_CANCELLED");
    expect(repository.registrations).toHaveLength(0);
    expect(repository.captures).toHaveLength(0);
  });

  it("fails closed when a recovered acquisition receipt has tampered bytes", async () => {
    const acquire = vi.fn(async () => acquired()),
      { repository, executor } = setup({ acquirer: acquire });
    const executionContext = context("ffffffff-ffff-4fff-8fff-ffffffffffff");
    const first = await executor.execute("verification_capture", operationInput, executionContext);
    const receiptId = (first.output as any).acquisitionReceipt.artifactId as string;
    repository.artifacts.get(receiptId)!.bytes = encoder.encode("tampered");
    await expect(executor.execute("verification_capture", operationInput, executionContext)).rejects.toThrow(
      "VERIFICATION_ACQUISITION_RECEIPT_INVALID",
    );
    expect(acquire).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed acquisition metadata before artifact or capture persistence", async () => {
    const malformed = { ...acquired(), status: 600 } as unknown as AcquiredVerificationSource;
    const { repository, executor } = setup({ acquirer: async () => malformed });
    await expect(
      executor.execute("verification_capture", operationInput, context("12121212-1212-4212-8212-121212121212")),
    ).rejects.toThrow("VERIFICATION_ACQUISITION_RESPONSE_BINDING");
    expect(repository.registrations).toHaveLength(0);
    expect(repository.captures).toHaveLength(0);
  });

  it("does not start parser work when recovered capture retrieval observes cancellation", async () => {
    let cancelled = false;
    const parse = vi.fn(parser);
    const acquire = vi.fn(async () => acquired());
    const { executor } = setup({
      acquirer: acquire,
      parse,
      assertActive: async () => {
        if (cancelled) throw new Error("VERIFICATION_OPERATION_CANCELLED");
      },
    });
    const executionContext = context("13131313-1313-4313-8313-131313131313");
    await executor.execute("verification_capture", operationInput, executionContext);
    parse.mockClear();
    cancelled = true;
    await expect(executor.execute("verification_capture", operationInput, executionContext)).rejects.toThrow(
      "VERIFICATION_OPERATION_CANCELLED",
    );
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(parse).not.toHaveBeenCalled();
  });
});
