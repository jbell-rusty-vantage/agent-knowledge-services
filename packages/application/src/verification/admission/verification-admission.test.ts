import { describe, expect, it, vi } from "vitest";
import type {
  VerificationArtifactHandle,
  VerificationSource,
  VerificationSourceCapture,
} from "@aiengineer/knowledge-contracts";
import type { VerificationParserOutput, VerificationParserRequest } from "@aiengineer/knowledge-preparation";
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
  type RegisterAdmissionArtifactInput,
  type VerificationAdmissionRepositoryPort,
  type VerificationParserDeployment,
  type VerificationParserPort,
} from "./verification-admission.js";

const enc = new TextEncoder();
const tenant = "11111111-1111-4111-8111-111111111111";
const otherTenant = "22222222-2222-4222-8222-222222222222";
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
const htmlProjection = {
  kind: "html_dom",
  document: { tag: "html", children: [{ tag: "body", children: [{ tag: "#text", text: "Exact value 42" }] }] },
  canonicalText: "Exact value 42",
};
const htmlResiduals = [{ code: "CSS_LAYOUT_NOT_EXECUTED", detail: "Computed layout remains unresolved." }];
const handle = (
  tenantId: string,
  bytes: Uint8Array,
  mediaType: string,
  createdAt = "2026-09-05T10:00:00.000Z",
  parents: readonly string[] = [],
  signature?: `sha256:${string}`,
): VerificationArtifactHandle => {
  const digest = sha256Digest(bytes);
  return {
    artifactId: deterministicUuid("artifact", `${tenantId}:${digest}`),
    tenantId,
    digest,
    mediaType,
    byteLength: bytes.byteLength,
    objectKey: `${tenantId}/${digest.slice(7, 9)}/${digest.slice(7)}`,
    createdAt,
    producerActivityId: "fixture",
    producerVersion: "1",
    encryptionClass: "managed",
    retentionClass: "test",
    dataClassification: "restricted",
    parentArtifactIds: [...parents],
    ...(signature ? { transformationSignature: signature } : {}),
  };
};

class MemoryRepository implements VerificationAdmissionRepositoryPort {
  readonly artifacts = new Map<string, { registration: VerificationArtifactHandle; bytes: Uint8Array }>();
  readonly captures = new Map<string, { source: VerificationSource; capture: VerificationSourceCapture }>();
  readonly authorizations: { tenantId: string; artifactId: string; purpose: string }[] = [];
  readonly registrations: RegisterAdmissionArtifactInput[] = [];
  addCapture(tenantId: string, captureId: string, sourceId: string, kind: "web_page" | "pdf", bytes: Uint8Array) {
    const content = handle(tenantId, bytes, kind === "pdf" ? "application/pdf" : "text/html");
    this.artifacts.set(`${tenantId}:${content.artifactId}`, { registration: content, bytes: Uint8Array.from(bytes) });
    this.captures.set(`${tenantId}:${captureId}`, {
      source: {
        sourceId,
        kind,
        canonicalUri: `https://example.test/${captureId}`,
        logicalIdentity: `fixture:${captureId}`,
      },
      capture: {
        captureId,
        sourceId,
        capturedAt: "2026-09-05T10:00:00.000Z",
        captureMethod: "fixture",
        captureMethodVersion: "1",
        contentArtifact: content,
      },
    });
    return content;
  }
  async getRegisteredCapture(input: { tenantId: string; captureId: string }) {
    const found = this.captures.get(`${input.tenantId}:${input.captureId}`);
    if (!found) throw new Error("CAPTURE_NOT_REGISTERED");
    return structuredClone(found);
  }
  createTrustedArtifactResolver(): TrustedArtifactResolver {
    let ticket: string | undefined;
    return {
      authorizeArtifact: async (input) => {
        this.authorizations.push(input);
        if (!this.artifacts.has(`${input.tenantId}:${input.artifactId}`)) throw new Error("FORBIDDEN");
        ticket = `${input.tenantId}:${input.artifactId}`;
      },
      hydrateRegisteredArtifact: async (input) => {
        const key = `${input.tenantId}:${input.artifactId}`;
        if (ticket !== key) throw new Error("NOT_AUTHORIZED");
        ticket = undefined;
        const item = this.artifacts.get(key);
        if (!item) throw new Error("MISSING");
        return { registration: structuredClone(item.registration), bytes: Uint8Array.from(item.bytes) };
      },
    };
  }
  async registerContentAddressedArtifact(input: RegisterAdmissionArtifactInput) {
    this.registrations.push(input);
    const proposed = handle(
      input.tenantId,
      input.bytes,
      input.mediaType,
      input.createdAt,
      input.parentArtifactIds,
      input.transformationSignature,
    );
    const key = `${input.tenantId}:${proposed.artifactId}`,
      existing = this.artifacts.get(key);
    if (existing) {
      if (existing.registration.mediaType !== input.mediaType || sha256Digest(existing.bytes) !== proposed.digest)
        throw new Error("COLLISION");
      return structuredClone(existing.registration);
    }
    for (const parent of input.parentArtifactIds ?? [])
      if (!this.artifacts.has(`${input.tenantId}:${parent}`)) throw new Error("PARENT_MISSING");
    this.artifacts.set(key, { registration: proposed, bytes: Uint8Array.from(input.bytes) });
    return structuredClone(proposed);
  }
}

function parserResult(
  request: VerificationParserRequest,
  projections: readonly unknown[] = [htmlProjection],
  residuals: readonly unknown[] = htmlResiduals,
  overrides: Partial<VerificationParserOutput> = {},
): VerificationParserOutput {
  const nativeOutput = enc.encode(
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
    ...overrides,
  };
}
const make = (
  repository: MemoryRepository,
  implementation?: (request: VerificationParserRequest) => Promise<VerificationParserOutput>,
) => {
  const parse = vi.fn(implementation ?? (async (request) => parserResult(request)));
  const service = new VerificationAdmissionService(repository, { parse } as VerificationParserPort, deployment, {
    storageBucket: "verification-artifacts",
    producerVersion: "verification-admission.v1",
    encryptionClass: "managed",
    retentionClass: "verification",
    now: () => "2026-09-05T12:00:00.000Z",
  });
  return { service, parse };
};

describe("authenticated verification projection admission", () => {
  it("authorizes a registered capture before hydration and rejects tenant/parent forgery before parser execution", async () => {
    const repository = new MemoryRepository();
    const captureId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      sourceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const source = repository.addCapture(tenant, captureId, sourceId, "web_page", enc.encode("source"));
    const { service, parse } = make(repository);
    await expect(
      service.parseAndAdmit({
        tenantId: otherTenant,
        captureId,
        expectedSourceArtifact: { artifactId: source.artifactId, digest: source.digest as `sha256:${string}` },
        kind: "html",
      }),
    ).rejects.toThrow("CAPTURE_NOT_REGISTERED");
    expect(repository.authorizations).toHaveLength(0);
    await expect(
      service.parseAndAdmit({
        tenantId: tenant,
        captureId,
        expectedSourceArtifact: { artifactId: source.artifactId, digest: `sha256:${"0".repeat(64)}` },
        kind: "html",
      }),
    ).rejects.toThrow("CAPTURE_EXPECTED_IDENTITY_MISMATCH");
    expect(repository.authorizations).toHaveLength(0);
    expect(parse).not.toHaveBeenCalled();
  });

  it("preflights every projection and parser identity before any registration", async () => {
    const repository = new MemoryRepository();
    const captureId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const source = repository.addCapture(
      tenant,
      captureId,
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      "pdf",
      enc.encode("%PDF-fixture"),
    );
    const malformed = { kind: "geometry", pages: [], invented: true };
    const { service } = make(repository, async (request) =>
      parserResult(
        request,
        [{ kind: "pdf_text", pageCount: 1, pages: [], residuals: [] }, malformed],
        [{ code: "VISUAL_CONTENT_NOT_ASSESSED", physicalPageNumber: 1, detail: "visual" }],
      ),
    );
    await expect(
      service.parseAndAdmit({
        tenantId: tenant,
        captureId,
        expectedSourceArtifact: { artifactId: source.artifactId, digest: source.digest as `sha256:${string}` },
        kind: "pdf",
      }),
    ).rejects.toThrow(/PROJECTION_INVALID|PARSER_/);
    expect(repository.registrations).toHaveLength(0);
    const unregistered = new MemoryRepository();
    const htmlId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const html = unregistered.addCapture(
      tenant,
      htmlId,
      "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      "web_page",
      enc.encode("html"),
    );
    const unsupported = make(unregistered, async (request) =>
      parserResult(request, [{ kind: "dataset", datasetVersionId: "forged", rows: [] }]),
    );
    await expect(
      unsupported.service.parseAndAdmit({
        tenantId: tenant,
        captureId: htmlId,
        expectedSourceArtifact: { artifactId: html.artifactId, digest: html.digest as `sha256:${string}` },
        kind: "html",
      }),
    ).rejects.toThrow("PARSER_PROJECTION_SET_INVALID");
    expect(unregistered.registrations).toHaveLength(0);
    for (const projection of [
      { kind: "repository", commit: "main", lineRangeConvention: "zero_based_half_open", files: [] },
      { kind: "dataset", datasetVersionId: "forged", rows: [] },
    ] as const) {
      const repo = new MemoryRepository(),
        capture = repo.addCapture(
          tenant,
          htmlId,
          "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          "web_page",
          enc.encode("html"),
        );
      const candidate = make(repo, async (request) => parserResult(request, [projection]));
      await expect(
        candidate.service.parseAndAdmit({
          tenantId: tenant,
          captureId: htmlId,
          expectedSourceArtifact: { artifactId: capture.artifactId, digest: capture.digest as `sha256:${string}` },
          kind: "html",
        }),
      ).rejects.toThrow(/PROJECTION_INVALID|PARSER_PROJECTION_SET_INVALID/);
      expect(repo.registrations).toHaveLength(0);
    }
    const oversizedRepo = new MemoryRepository(),
      oversizedCapture = oversizedRepo.addCapture(
        tenant,
        htmlId,
        "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        "web_page",
        enc.encode("html"),
      );
    const oversized = make(oversizedRepo, async (request) =>
      parserResult(request, [{ ["x".repeat(4_000_001)]: null }]),
    );
    await expect(
      oversized.service.parseAndAdmit({
        tenantId: tenant,
        captureId: htmlId,
        expectedSourceArtifact: {
          artifactId: oversizedCapture.artifactId,
          digest: oversizedCapture.digest as `sha256:${string}`,
        },
        kind: "html",
      }),
    ).rejects.toThrow("PARSER_OUTPUT_PREFLIGHT_LIMIT");
    expect(oversizedRepo.registrations).toHaveLength(0);
    const arrayRepo = new MemoryRepository(),
      arrayCapture = arrayRepo.addCapture(
        tenant,
        htmlId,
        "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        "web_page",
        enc.encode("html"),
      );
    const oversizedArray = make(arrayRepo, async (request) => parserResult(request, new Array(100_001).fill(null)));
    await expect(
      oversizedArray.service.parseAndAdmit({
        tenantId: tenant,
        captureId: htmlId,
        expectedSourceArtifact: {
          artifactId: arrayCapture.artifactId,
          digest: arrayCapture.digest as `sha256:${string}`,
        },
        kind: "html",
      }),
    ).rejects.toThrow("PARSER_OUTPUT_PREFLIGHT_LIMIT");
    expect(arrayRepo.registrations).toHaveLength(0);
    const nativeRepo = new MemoryRepository(),
      nativeCapture = nativeRepo.addCapture(
        tenant,
        htmlId,
        "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        "web_page",
        enc.encode("html"),
      );
    const oversizedNative = make(nativeRepo, async (request) => {
      const nativeOutput = new Uint8Array(4_000_001);
      return parserResult(request, [htmlProjection], htmlResiduals, {
        nativeOutput,
        nativeOutputDigest: sha256Digest(nativeOutput),
      });
    });
    await expect(
      oversizedNative.service.parseAndAdmit({
        tenantId: tenant,
        captureId: htmlId,
        expectedSourceArtifact: {
          artifactId: nativeCapture.artifactId,
          digest: nativeCapture.digest as `sha256:${string}`,
        },
        kind: "html",
      }),
    ).rejects.toThrow("PARSER_NATIVE_OUTPUT_LIMIT");
    expect(nativeRepo.registrations).toHaveLength(0);
    for (const override of [
      { imageDigest: `sha256:${"0".repeat(64)}` },
      { parserVersion: "verification-native-parser.v0" },
    ] as const) {
      const repo = new MemoryRepository(),
        capture = repo.addCapture(
          tenant,
          htmlId,
          "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          "web_page",
          enc.encode("html"),
        );
      const candidate = make(repo, async (request) =>
        parserResult(request, [htmlProjection], htmlResiduals, override as never),
      );
      await expect(
        candidate.service.parseAndAdmit({
          tenantId: tenant,
          captureId: htmlId,
          expectedSourceArtifact: { artifactId: capture.artifactId, digest: capture.digest as `sha256:${string}` },
          kind: "html",
        }),
      ).rejects.toThrow("PARSER_DEPLOYMENT_IDENTITY_MISMATCH");
      expect(repo.registrations).toHaveLength(0);
    }
  });

  it("snapshots deployment/configuration and stops registration when cancellation arrives between phases", async () => {
    const repository = new MemoryRepository(),
      captureId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const source = repository.addCapture(
      tenant,
      captureId,
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      "web_page",
      enc.encode("source"),
    );
    const mutableDeployment = {
        parserVersion: "verification-native-parser.v1" as const,
        imageDigest: image,
        limits: { ...limits },
      },
      config = {
        storageBucket: "verification-artifacts",
        producerVersion: "verification-admission.v1",
        encryptionClass: "managed",
        retentionClass: "verification",
        now: () => "2026-09-05T12:00:00.000Z",
      };
    const parser = { parse: async (request: VerificationParserRequest) => parserResult(request) };
    const service = new VerificationAdmissionService(repository, parser, mutableDeployment, config);
    mutableDeployment.limits.outputBytes = 1;
    (mutableDeployment as { imageDigest: `sha256:${string}` }).imageDigest = `sha256:${"0".repeat(64)}`;
    config.storageBucket = "mutated";
    await expect(
      service.parseAndAdmit({
        tenantId: tenant,
        captureId,
        expectedSourceArtifact: { artifactId: source.artifactId, digest: source.digest as `sha256:${string}` },
        kind: "html",
      }),
    ).resolves.toHaveLength(1);
    expect(repository.registrations.every((item) => item.storageBucket === "verification-artifacts")).toBe(true);

    const cancelledRepo = new MemoryRepository(),
      cancelledSource = cancelledRepo.addCapture(
        tenant,
        captureId,
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        "web_page",
        enc.encode("source"),
      ),
      controller = new AbortController();
    const cancelled = make(cancelledRepo, async (request) => {
      controller.abort();
      return parserResult(request);
    });
    await expect(
      cancelled.service.parseAndAdmit({
        tenantId: tenant,
        captureId,
        expectedSourceArtifact: {
          artifactId: cancelledSource.artifactId,
          digest: cancelledSource.digest as `sha256:${string}`,
        },
        kind: "html",
        signal: controller.signal,
      }),
    ).rejects.toThrow("PARSER_CANCELLED");
    expect(cancelledRepo.registrations).toHaveLength(0);

    const partialRepo = new MemoryRepository(),
      partialSource = partialRepo.addCapture(
        tenant,
        captureId,
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        "web_page",
        enc.encode("source"),
      ),
      partialController = new AbortController(),
      originalRegister = partialRepo.registerContentAddressedArtifact.bind(partialRepo);
    let first = true;
    partialRepo.registerContentAddressedArtifact = async (input) => {
      const registered = await originalRegister(input);
      if (first) {
        first = false;
        partialController.abort();
      }
      return registered;
    };
    const partial = make(partialRepo);
    await expect(
      partial.service.parseAndAdmit({
        tenantId: tenant,
        captureId,
        expectedSourceArtifact: {
          artifactId: partialSource.artifactId,
          digest: partialSource.digest as `sha256:${string}`,
        },
        kind: "html",
        signal: partialController.signal,
      }),
    ).rejects.toThrow("PARSER_CANCELLED");
    expect(partialRepo.registrations).toHaveLength(1);
  });

  it("reuses equal projection bytes but authenticates a distinct parent-specific transformation envelope", async () => {
    const repository = new MemoryRepository();
    const firstId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      secondId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const first = repository.addCapture(
      tenant,
      firstId,
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      "web_page",
      enc.encode("first parent"),
    );
    const second = repository.addCapture(
      tenant,
      secondId,
      "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      "web_page",
      enc.encode("second parent"),
    );
    const { service } = make(repository);
    const firstReceipt = (
      await service.parseAndAdmit({
        tenantId: tenant,
        captureId: firstId,
        expectedSourceArtifact: { artifactId: first.artifactId, digest: first.digest as `sha256:${string}` },
        kind: "html",
      })
    )[0]!;
    const secondReceipt = (
      await service.parseAndAdmit({
        tenantId: tenant,
        captureId: secondId,
        expectedSourceArtifact: { artifactId: second.artifactId, digest: second.digest as `sha256:${string}` },
        kind: "html",
      })
    )[0]!;
    expect(secondReceipt.projectionArtifact.artifactId).toBe(firstReceipt.projectionArtifact.artifactId);
    expect(secondReceipt.projectionArtifact.createdAt).toBe(firstReceipt.projectionArtifact.createdAt);
    expect(secondReceipt.transformationArtifact.artifactId).not.toBe(firstReceipt.transformationArtifact.artifactId);
    expect(secondReceipt.transformationArtifact.parentArtifactIds).toContain(second.artifactId);
    await expect(
      service.hydrateAdmittedProjection({
        tenantId: tenant,
        captureId: secondId,
        expectedSourceArtifact: { artifactId: second.artifactId, digest: second.digest as `sha256:${string}` },
        transformationArtifactId: firstReceipt.transformationArtifact.artifactId,
        projectionArtifactId: firstReceipt.projectionArtifact.artifactId,
      }),
    ).rejects.toThrow("PROJECTION_ENVELOPE_BINDING_MISMATCH");
    await expect(
      service.hydrateAdmittedProjection({
        tenantId: tenant,
        captureId: secondId,
        expectedSourceArtifact: { artifactId: second.artifactId, digest: second.digest as `sha256:${string}` },
        transformationArtifactId: secondReceipt.transformationArtifact.artifactId,
        projectionArtifactId: second.artifactId,
      }),
    ).rejects.toThrow("PROJECTION_ENVELOPE_BINDING_MISMATCH");
    await expect(
      service.hydrateAdmittedProjection({
        tenantId: tenant,
        captureId: secondId,
        expectedSourceArtifact: { artifactId: second.artifactId, digest: second.digest as `sha256:${string}` },
        transformationArtifactId: secondReceipt.transformationArtifact.artifactId,
        projectionArtifactId: secondReceipt.projectionArtifact.artifactId,
      }),
    ).resolves.toMatchObject({ projection: { kind: "html_dom" } });
  });

  it("hydrates authenticated projection bytes into the pure field verifier and rejects locator/value mutation", async () => {
    const repository = new MemoryRepository(),
      captureId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const source = repository.addCapture(
      tenant,
      captureId,
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      "web_page",
      enc.encode("source"),
    );
    const { service } = make(repository);
    const receipt = (
      await service.parseAndAdmit({
        tenantId: tenant,
        captureId,
        expectedSourceArtifact: { artifactId: source.artifactId, digest: source.digest as `sha256:${string}` },
        kind: "html",
      })
    )[0]!;
    const schema = admitExtractionSchema({
      schemaId: "field",
      schemaVersion: "1",
      schema: {
        type: "object",
        description: "Known field.",
        properties: { value: { type: "string", description: "Exact source value.", maxLength: 32 } },
        required: ["value"],
        additionalProperties: false,
      },
    }).schema!;
    const base = {
      tenantId: tenant,
      expectedSourceArtifact: { artifactId: source.artifactId, digest: source.digest as `sha256:${string}` },
      schema,
      fields: [{ path: "/value", comparison: "exact" as const }],
      evidence: [
        {
          path: "/value",
          captureId,
          projectionArtifactId: receipt.projectionArtifact.artifactId,
          transformationArtifactId: receipt.transformationArtifact.artifactId,
          selector: { kind: "html" as const, domPath: "0/0" },
        },
      ],
    };
    await expect(service.verifyExtraction({ ...base, candidate: { value: "Exact value 42" } })).resolves.toMatchObject({
      valid: true,
    });
    const evidenced = await service.verifyExtractionWithEvidence({ ...base, candidate: { value: "Exact value 42" } });
    expect(evidenced.result).toMatchObject({
      schemaVersion: "verification-extraction-field-evidence.v1",
      valid: true,
      acceptedLeaves: [
        {
          path: "/value",
          lineage: {
            sourceArtifact: { artifactId: source.artifactId },
            nativeOutputArtifact: { artifactId: receipt.nativeOutputArtifact.artifactId },
            transformationArtifact: { artifactId: receipt.transformationArtifact.artifactId },
            projectionArtifact: { artifactId: receipt.projectionArtifact.artifactId },
          },
        },
      ],
    });
    expect(new Set(evidenced.boundArtifacts.map((artifact) => artifact.artifactId)).size).toBe(
      evidenced.boundArtifacts.length,
    );
    expect(evidenced.boundArtifacts.map((artifact) => artifact.artifactId)).toEqual(
      expect.arrayContaining([
        source.artifactId,
        receipt.nativeOutputArtifact.artifactId,
        receipt.transformationArtifact.artifactId,
        receipt.projectionArtifact.artifactId,
      ]),
    );
    await expect(service.verifyExtraction({ ...base, candidate: { value: "Exact value 43" } })).resolves.toMatchObject({
      valid: false,
    });
    await expect(
      service.verifyExtraction({
        ...base,
        candidate: { value: "Exact value 42" },
        evidence: [{ ...base.evidence[0]!, selector: { kind: "html" as const, domPath: "9/9" } }],
      }),
    ).resolves.toMatchObject({ valid: false });
    const transformationKey = `${tenant}:${receipt.transformationArtifact.artifactId}`,
      originalTransformation = structuredClone(repository.artifacts.get(transformationKey)!);
    const oversizedEnvelope = new Uint8Array(64_001);
    repository.artifacts.set(transformationKey, {
      registration: {
        ...originalTransformation.registration,
        digest: sha256Digest(oversizedEnvelope),
        byteLength: oversizedEnvelope.byteLength,
      },
      bytes: oversizedEnvelope,
    });
    await expect(
      service.hydrateAdmittedProjection({
        tenantId: tenant,
        captureId,
        expectedSourceArtifact: { artifactId: source.artifactId, digest: source.digest as `sha256:${string}` },
        transformationArtifactId: receipt.transformationArtifact.artifactId,
        projectionArtifactId: receipt.projectionArtifact.artifactId,
      }),
    ).rejects.toThrow("PROJECTION_ENVELOPE_LIMIT");
    repository.artifacts.set(transformationKey, originalTransformation);
    const stored = repository.artifacts.get(`${tenant}:${receipt.projectionArtifact.artifactId}`)!;
    stored.bytes[0] = (stored.bytes[0] ?? 0) ^ 1;
    await expect(service.verifyExtraction({ ...base, candidate: { value: "Exact value 42" } })).rejects.toThrow(
      "ADMISSION_ARTIFACT_INTEGRITY_FAILURE",
    );
  });
});
