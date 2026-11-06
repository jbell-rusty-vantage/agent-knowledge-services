import { describe, expect, it } from "vitest";
import type { VerificationArtifactHandle } from "@aiengineer/knowledge-contracts";
import {
  canonicalizeJson,
  registeredProvider,
  sha256Digest,
  type TrustedArtifactResolver,
} from "@aiengineer/knowledge-verification";
import {
  StructuredExtractionProfileAdmission,
  type StructuredExtractionRuntimeGrant,
} from "./verification-structured-extraction-profile.js";

const tenant = "11111111-1111-4111-8111-111111111111";
const otherTenant = "22222222-2222-4222-8222-222222222222";
const captureId = "capture-1";
const encoder = new TextEncoder();
const bytes = (value: unknown) => encoder.encode(canonicalizeJson(value));
const handle = (id: string, value: Uint8Array): VerificationArtifactHandle => ({
  artifactId: id,
  tenantId: tenant,
  digest: sha256Digest(value),
  mediaType: "application/json",
  byteLength: value.byteLength,
  objectKey: `${tenant}/00/${id}`,
  createdAt: "2026-09-06T00:00:00.000Z",
  producerActivityId: "fixture",
  producerVersion: "1",
  encryptionClass: "managed",
  retentionClass: "test",
  dataClassification: "restricted",
  parentArtifactIds: [],
});

function fixture() {
  const sourceBytes = bytes({ source: "fixture" }),
    projectionBytes = bytes({
      kind: "html_dom",
      document: { tag: "html", children: [{ tag: "body", children: [{ tag: "#text", text: "Exact value 42" }] }] },
      canonicalText: "Exact value 42",
    });
  const source = handle("00000000-0000-4000-8000-000000000001", sourceBytes),
    representation = handle("00000000-0000-4000-8000-000000000002", projectionBytes),
    transformation = handle("00000000-0000-4000-8000-000000000003", bytes({ transformation: true }));
  const extraction = {
    schemaVersion: "verification-extraction-profile.v1",
    sourceArtifact: { artifactId: source.artifactId, digest: source.digest },
    extractionSchema: {
      schemaId: "fixture",
      schemaVersion: "1",
      schema: {
        type: "object",
        description: "Fixture.",
        properties: { value: { type: "string", description: "Exact value.", maxLength: 32 } },
        required: ["value"],
        additionalProperties: false,
      },
    },
    fields: [{ path: "/value", comparison: "exact" }],
    evidence: [
      {
        path: "/value",
        captureId,
        projectionArtifactId: representation.artifactId,
        transformationArtifactId: transformation.artifactId,
        selector: { kind: "html", domPath: "0/0" },
      },
    ],
    normalizations: [],
    duplicates: [],
    totals: [],
  };
  const extractionBytes = bytes(extraction),
    extractionArtifact = handle("00000000-0000-4000-8000-000000000004", extractionBytes);
  const producer = {
    schemaVersion: "verification-structured-extraction-profile.v1",
    tenantId: tenant,
    profileId: "registered_default",
    profileVersion: "1",
    extractionSchema: extractionArtifact,
    providerId: "gateway-structured-extraction.v1",
    providerConfigurationDigest: registeredProvider("gateway-structured-extraction.v1").configurationDigest,
    externalProcessing: { classification: "synthetic", modality: "text" },
    budget: {
      budgetId: "00000000-0000-4000-8000-000000000005",
      budgetKey: "fixture",
      ceilingCostMicros: 100,
      reservationCostMicros: 100,
    },
    maximumPromptBytes: 24_000,
  };
  const producerBytes = bytes(producer),
    producerArtifact = handle("00000000-0000-4000-8000-000000000006", producerBytes);
  const grants: StructuredExtractionRuntimeGrant[] = [
    {
      tenantId: tenant,
      captureId,
      sourceArtifact: source,
      representation,
      transformation,
      extractionSchema: extractionArtifact,
      producerProfile: producerArtifact,
    },
  ];
  const artifacts = new Map([
    [producerArtifact.artifactId, { registration: producerArtifact, bytes: producerBytes }],
    [extractionArtifact.artifactId, { registration: extractionArtifact, bytes: extractionBytes }],
  ]);
  const resolver: TrustedArtifactResolver = {
    authorizeArtifact: async ({ tenantId, artifactId }) => {
      if (tenantId !== tenant || !artifacts.has(artifactId)) throw new Error("DENIED");
    },
    hydrateRegisteredArtifact: async ({ tenantId, artifactId }) => {
      if (tenantId !== tenant) throw new Error("DENIED");
      const found = artifacts.get(artifactId);
      if (!found) throw new Error("MISSING");
      return structuredClone(found);
    },
  };
  const admission = {
    hydrateAdmittedProjection: async () => ({
      receipt: {
        captureId,
        sourceArtifact: source,
        projectionArtifact: representation,
        transformationArtifact: transformation,
      } as never,
      content: projectionBytes,
    }),
  };
  const request = {
    verificationContractVersion: "verification.v1",
    captureId,
    representation: { artifactId: representation.artifactId, digest: representation.digest },
    extractionSchema: { artifactId: extractionArtifact.artifactId, digest: extractionArtifact.digest },
    extractionProfile: "registered_default",
  };
  return { grants, resolver, admission, request, producer, extraction, artifacts };
}

/** Re-register intentional fixture edits so negative tests reach the intended gate. */
function rebind(item: ReturnType<typeof fixture>): void {
  const schemaBytes = bytes(item.extraction),
    schema = handle(item.request.extractionSchema.artifactId, schemaBytes);
  item.artifacts.set(schema.artifactId, { registration: schema, bytes: schemaBytes });
  item.request.extractionSchema = { artifactId: schema.artifactId, digest: schema.digest };
  item.producer.extractionSchema = schema;
  const profileBytes = bytes(item.producer),
    profile = handle(item.grants[0]!.producerProfile.artifactId, profileBytes);
  item.artifacts.set(profile.artifactId, { registration: profile, bytes: profileBytes });
  item.grants[0] = { ...item.grants[0]!, extractionSchema: schema, producerProfile: profile };
}

describe("structured extraction producer profile admission", () => {
  it("isolates concurrent preparations using separate single-ticket resolvers", async () => {
    const item = fixture();
    let instances = 0;
    const factory = () => {
      instances++;
      let ticket: string | undefined;
      return {
        async authorizeArtifact(input: Parameters<typeof item.resolver.authorizeArtifact>[0]) {
          await item.resolver.authorizeArtifact(input);
          ticket = input.artifactId;
        },
        async hydrateRegisteredArtifact(input: Parameters<typeof item.resolver.hydrateRegisteredArtifact>[0]) {
          await new Promise((resolve) => setTimeout(resolve, 1));
          if (ticket !== input.artifactId) throw new Error("AUTHORIZATION_TICKET_OVERWRITTEN");
          ticket = undefined;
          return item.resolver.hydrateRegisteredArtifact(input);
        },
      };
    };
    const service = new StructuredExtractionProfileAdmission(item.grants, factory, item.admission);
    const results = await Promise.all([
      service.prepare({ tenantId: tenant, request: item.request }),
      service.prepare({ tenantId: tenant, request: item.request }),
    ]);
    expect(instances).toBe(2);
    expect(results[0]!.prompt).toBe(results[1]!.prompt);
  });
  it("prepares only a granted, capture-bound selected-evidence prompt and brands it", async () => {
    const item = fixture(),
      service = new StructuredExtractionProfileAdmission(item.grants, () => item.resolver, item.admission);
    const prepared = await service.prepare({ tenantId: tenant, request: item.request });
    expect(prepared.prompt).toContain("Exact value 42");
    expect(prepared.provider).toMatchObject({ providerId: "gateway-structured-extraction.v1", promotionState: "lab" });
    service.assertPrepared({ tenantId: tenant, request: item.request, preparation: prepared });
    expect(() =>
      service.assertPrepared({ tenantId: otherTenant, request: item.request, preparation: prepared }),
    ).toThrow("STRUCTURED_EXTRACTION_PREPARATION_UNTRUSTED");
    expect(() =>
      new StructuredExtractionProfileAdmission([], () => item.resolver, item.admission).assertPrepared({
        tenantId: tenant,
        request: item.request,
        preparation: prepared,
      }),
    ).toThrow("STRUCTURED_EXTRACTION_PREPARATION_UNTRUSTED");
    expect(() =>
      service.assertPrepared({ tenantId: tenant, request: item.request, preparation: structuredClone(prepared) }),
    ).toThrow("STRUCTURED_EXTRACTION_PREPARATION_UNTRUSTED");
    expect(Object.isFrozen(prepared.artifacts.producerProfile)).toBe(true);
  });

  it("rejects tenant, grant, profile-provider, and schema drift before dispatch", async () => {
    const item = fixture();
    await expect(
      new StructuredExtractionProfileAdmission(item.grants, () => item.resolver, item.admission).prepare({
        tenantId: otherTenant,
        request: item.request,
      }),
    ).rejects.toThrow("STRUCTURED_EXTRACTION_RUNTIME_GRANT_REQUIRED");
    item.producer.providerConfigurationDigest = `sha256:${"0".repeat(64)}`;
    const producerBytes = bytes(item.producer);
    item.artifacts.get("00000000-0000-4000-8000-000000000006")!.bytes = producerBytes;
    item.artifacts.get("00000000-0000-4000-8000-000000000006")!.registration = handle(
      "00000000-0000-4000-8000-000000000006",
      producerBytes,
    );
    const driftedGrant = {
      ...item.grants[0]!,
      producerProfile: item.artifacts.get("00000000-0000-4000-8000-000000000006")!.registration,
    };
    await expect(
      new StructuredExtractionProfileAdmission([driftedGrant], () => item.resolver, item.admission).prepare({
        tenantId: tenant,
        request: item.request,
      }),
    ).rejects.toThrow("STRUCTURED_EXTRACTION_PROVIDER_PROFILE_INVALID");
  });

  it("rejects stale schema digest and an already cancelled request", async () => {
    const missing = fixture();
    missing.extraction.evidence = [];
    const b = bytes(missing.extraction);
    missing.artifacts.get("00000000-0000-4000-8000-000000000004")!.bytes = b;
    missing.artifacts.get("00000000-0000-4000-8000-000000000004")!.registration = handle(
      "00000000-0000-4000-8000-000000000004",
      b,
    );
    await expect(
      new StructuredExtractionProfileAdmission(missing.grants, () => missing.resolver, missing.admission).prepare({
        tenantId: tenant,
        request: missing.request,
      }),
    ).rejects.toThrow("STRUCTURED_EXTRACTION_SCHEMA_PROFILE_BINDING_INVALID");
    const cancelled = fixture(),
      controller = new AbortController();
    controller.abort();
    await expect(
      new StructuredExtractionProfileAdmission(cancelled.grants, () => cancelled.resolver, cancelled.admission).prepare(
        { tenantId: tenant, request: cancelled.request, signal: controller.signal },
      ),
    ).rejects.toThrow("STRUCTURED_EXTRACTION_PROFILE_CANCELLED");
  });

  it.each([
    [
      "missing evidence",
      (item: ReturnType<typeof fixture>) => {
        item.extraction.evidence[0]!.path = "/other";
      },
      "STRUCTURED_EXTRACTION_PROFILE_EVIDENCE_COVERAGE_REQUIRED",
    ],
    [
      "duplicate fields",
      (item: ReturnType<typeof fixture>) => {
        item.extraction.fields.push({ ...item.extraction.fields[0]! });
      },
      "STRUCTURED_EXTRACTION_PROFILE_EVIDENCE_COVERAGE_REQUIRED",
    ],
    [
      "unbound schema field",
      (item: ReturnType<typeof fixture>) => {
        Object.assign(item.extraction.extractionSchema.schema.properties, {
          other: { type: "string", description: "Unbound.", maxLength: 10 },
        });
      },
      "STRUCTURED_EXTRACTION_PROFILE_SCHEMA_COVERAGE_REQUIRED",
    ],
    [
      "open object",
      (item: ReturnType<typeof fixture>) => {
        item.extraction.extractionSchema.schema.additionalProperties = true;
      },
      "STRUCTURED_EXTRACTION_OPEN_OBJECT_UNSUPPORTED",
    ],
    [
      "dynamic array",
      (item: ReturnType<typeof fixture>) => {
        Object.assign(item.extraction.extractionSchema.schema.properties, {
          other: {
            type: "array",
            description: "Dynamic.",
            maxItems: 2,
            items: { type: "string", description: "Item.", maxLength: 10 },
          },
        });
      },
      "STRUCTURED_EXTRACTION_ARRAY_EVIDENCE_UNSUPPORTED",
    ],
    [
      "foreign capture edge",
      (item: ReturnType<typeof fixture>) => {
        item.extraction.evidence[0]!.captureId = "other-capture";
      },
      "STRUCTURED_EXTRACTION_EVIDENCE_BINDING_INVALID",
    ],
    [
      "unresolved selector",
      (item: ReturnType<typeof fixture>) => {
        item.extraction.evidence[0]!.selector.domPath = "999";
      },
      "STRUCTURED_EXTRACTION_EVIDENCE_UNRESOLVED",
    ],
    [
      "prompt cap",
      (item: ReturnType<typeof fixture>) => {
        item.producer.maximumPromptBytes = 1;
      },
      "STRUCTURED_EXTRACTION_PROMPT_LIMIT",
    ],
  ] as const)("rejects %s after valid custody hydration", async (_name, change, code) => {
    const item = fixture();
    change(item);
    rebind(item);
    await expect(
      new StructuredExtractionProfileAdmission(item.grants, () => item.resolver, item.admission).prepare({
        tenantId: tenant,
        request: item.request,
      }),
    ).rejects.toThrow(code);
  });

  it.each(["tenantId", "byteLength", "objectKey"] as const)(
    "rejects changed hydrated %s even with identical artifact ID and bytes",
    async (field) => {
      const item = fixture(),
        profile = item.artifacts.get(item.grants[0]!.producerProfile.artifactId)!;
      profile.registration = {
        ...profile.registration,
        [field]:
          field === "tenantId" ? otherTenant : field === "byteLength" ? profile.bytes.byteLength + 1 : "changed/key",
      };
      await expect(
        new StructuredExtractionProfileAdmission(item.grants, () => item.resolver, item.admission).prepare({
          tenantId: tenant,
          request: item.request,
        }),
      ).rejects.toThrow("STRUCTURED_EXTRACTION_PRODUCER_PROFILE_BINDING_INVALID");
    },
  );

  it("rejects changed projection bytes and cancellation during projection hydration", async () => {
    const item = fixture(),
      controller = new AbortController();
    const altered = {
      hydrateAdmittedProjection: async () => ({
        ...(await item.admission.hydrateAdmittedProjection()),
        content: bytes({ altered: true }),
      }),
    };
    await expect(
      new StructuredExtractionProfileAdmission(item.grants, () => item.resolver, altered).prepare({
        tenantId: tenant,
        request: item.request,
      }),
    ).rejects.toThrow("STRUCTURED_EXTRACTION_PROJECTION_BINDING_INVALID");
    const cancelled = {
      hydrateAdmittedProjection: async () => {
        controller.abort();
        return item.admission.hydrateAdmittedProjection();
      },
    };
    await expect(
      new StructuredExtractionProfileAdmission(item.grants, () => item.resolver, cancelled).prepare({
        tenantId: tenant,
        request: item.request,
        signal: controller.signal,
      }),
    ).rejects.toThrow("STRUCTURED_EXTRACTION_PROFILE_CANCELLED");
  });

  it("rejects foreign artifact grants and snapshots the caller's grant array", async () => {
    const item = fixture(),
      grant = item.grants[0]!;
    expect(
      () =>
        new StructuredExtractionProfileAdmission(
          [{ ...grant, producerProfile: { ...grant.producerProfile, tenantId: otherTenant } }],
          () => item.resolver,
          item.admission,
        ),
    ).toThrow("STRUCTURED_EXTRACTION_RUNTIME_GRANT_TENANT_MISMATCH");
    const service = new StructuredExtractionProfileAdmission(item.grants, () => item.resolver, item.admission);
    item.grants.splice(0);
    await expect(service.prepare({ tenantId: tenant, request: item.request })).resolves.toMatchObject({ captureId });
  });

  it("fails closed on projection custody mismatch and producer-profile byte overrun", async () => {
    const badProjection = fixture();
    const mismatchedAdmission = {
      hydrateAdmittedProjection: async () => ({
        receipt: {
          captureId,
          sourceArtifact: handle("00000000-0000-4000-8000-000000000098", bytes({ wrong: true })),
          projectionArtifact: handle("00000000-0000-4000-8000-000000000099", bytes({ wrong: true })),
          transformationArtifact: handle("00000000-0000-4000-8000-000000000003", bytes({ transformation: true })),
        } as never,
        content: bytes({ kind: "html_dom", document: { tag: "html", children: [] } }),
      }),
    };
    await expect(
      new StructuredExtractionProfileAdmission(
        badProjection.grants,
        () => badProjection.resolver,
        mismatchedAdmission,
      ).prepare({ tenantId: tenant, request: badProjection.request }),
    ).rejects.toThrow("STRUCTURED_EXTRACTION_PROJECTION_BINDING_INVALID");
    const oversized = fixture(),
      body = new Uint8Array(128_001),
      registration = handle("00000000-0000-4000-8000-000000000006", body);
    oversized.artifacts.set(registration.artifactId, { registration, bytes: body });
    const grant = { ...oversized.grants[0]!, producerProfile: registration };
    await expect(
      new StructuredExtractionProfileAdmission([grant], () => oversized.resolver, oversized.admission).prepare({
        tenantId: tenant,
        request: oversized.request,
      }),
    ).rejects.toThrow("STRUCTURED_EXTRACTION_PRODUCER_PROFILE_BINDING_INVALID");
  });
});
