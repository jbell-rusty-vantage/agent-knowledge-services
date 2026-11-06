import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { VerificationArtifactHandle } from "@aiengineer/knowledge-contracts";
import {
  canonicalizeJson,
  digestCanonicalJson,
  providerDigest,
  sha256Digest,
} from "@aiengineer/knowledge-verification";
import { diagnosticsBenchmarkArms } from "./verification-benchmark.js";
import { OfflineBenchmarkInputCatalog, RegisteredBenchmarkInputAdmission } from "./verification-benchmark-inputs.js";
import { hydrateRegisteredBenchmarkObservations } from "./verification-benchmark-observations.js";

const tenantId = "11111111-1111-4111-8111-111111111111",
  now = "2026-09-05T12:00:00.000Z";
const encoder = new TextEncoder(),
  decoder = new TextDecoder("utf8", { fatal: true });
const encode = (value: unknown) => encoder.encode(JSON.stringify(value));
const encodeCanonical = (value: unknown) => encoder.encode(canonicalizeJson(value));

async function fixture() {
  let sequence = 1;
  const records = new Map<string, { registration: VerificationArtifactHandle; bytes: Uint8Array }>();
  function register(bytes: Uint8Array, parentArtifactIds: string[] = [], transformationSignature?: `sha256:${string}`) {
    const artifactId = `00000000-0000-4000-8000-${String(sequence++).padStart(12, "0")}`;
    const registration: VerificationArtifactHandle = {
      artifactId,
      tenantId,
      digest: sha256Digest(bytes),
      mediaType: "application/json",
      byteLength: bytes.length,
      objectKey: `private/${artifactId}`,
      createdAt: now,
      producerActivityId: "fixture",
      producerVersion: "1",
      encryptionClass: "managed",
      retentionClass: "audit",
      dataClassification: "restricted",
      parentArtifactIds,
      ...(transformationSignature === undefined ? {} : { transformationSignature }),
    };
    records.set(artifactId, { registration, bytes });
    return registration;
  }
  function rewrite(
    handle: VerificationArtifactHandle,
    bytes: Uint8Array,
    changes: Partial<VerificationArtifactHandle> = {},
  ) {
    const record = records.get(handle.artifactId)!;
    record.bytes = bytes;
    record.registration = {
      ...record.registration,
      ...changes,
      digest: sha256Digest(bytes),
      byteLength: bytes.byteLength,
    };
    return record.registration;
  }
  const datasetBytes = new Uint8Array(
    await readFile(
      new URL(
        "../../../../../catalog/verification-benchmarks/diagnostics-companies-pilot-v3/dataset.json",
        import.meta.url,
      ),
    ),
  );
  const dataset = JSON.parse(decoder.decode(datasetBytes));
  const datasetArtifact = register(datasetBytes);
  // Provider requests are semantic-digested after parsing; their retained wire
  // bytes need not use canonical member order.
  const requestBytes = encode({ zWireOrder: "first", aCanonicalOrder: "second" });
  const request = register(requestBytes),
    raw = register(encode({ response: "fixture" }));
  const requestDigest = providerDigest(JSON.parse(decoder.decode(requestBytes)));
  if (request.digest === requestDigest) throw new Error("fixture must distinguish wire and semantic request digests");
  const responseEnvelope = {
    schemaVersion: "verification-provider-response-envelope.v1" as const,
    requestDigest,
    requestArtifactId: request.artifactId,
    rawResponseArtifactId: raw.artifactId,
    rawResponseDigest: raw.digest,
  };
  const envelope = register(
    encodeCanonical(responseEnvelope),
    [request.artifactId, raw.artifactId],
    providerDigest({
      kind: "verification_provider_response_envelope.v1",
      requestDigest,
      rawResponseDigest: raw.digest,
    }),
  );
  const material = {
    schemaVersion: "verification-benchmark-provider-observation.v1",
    caseId: dataset.cases[0].caseId,
    caseDigest: dataset.cases[0].caseDigest,
    role: "luna_extractor",
    provider: "gateway",
    model: "openai/gpt-5.6-luna",
    requestDigest,
    rawResponseDigest: raw.digest,
    envelopeDigest: envelope.digest,
    output: { support: "full", qualifiers_preserved: true, unsupported_facets: [], public_rationale: "Fixture only." },
    promptTokens: 1,
    completionTokens: 1,
    actualCostMicros: 0,
    reservationCostMicros: 1,
    latencyMs: 1,
    costState: "actual",
    runDisposition: "recorded_exact_reuse",
    capturedAt: now,
    custody: {
      state: "registered",
      sourceReceiptDigest: sha256Digest("receipt"),
      recoveryInventoryDigest: null,
      recoveryWrapperArtifactId: null,
    },
  };
  const observation = register(encode({ ...material, observationDigest: digestCanonicalJson(material) }), [
    request.artifactId,
    raw.artifactId,
    envelope.artifactId,
  ]);
  const ref = (handle: VerificationArtifactHandle) => ({ artifactId: handle.artifactId, digest: handle.digest });
  const experiment = register(
    encode({
      schemaVersion: "verification-benchmark-experiment.v1",
      verificationContractVersion: "verification.v1",
      experimentId: "fixture",
      datasetManifestDigest: dataset.manifestDigest,
      runnerVersion: "verification-benchmark-runner.v1",
      randomSeed: 1,
      repetitions: 1,
      arms: diagnosticsBenchmarkArms(),
      networkPolicy: "offline",
      recordedObservationArtifacts: [ref(observation)],
    }),
  );
  const resolver = {
    authorizeArtifact: vi.fn(async () => {}),
    hydrateRegisteredArtifact: vi.fn(async ({ artifactId }: { artifactId: string }) => {
      const item = records.get(artifactId);
      if (!item) throw new Error("MISSING");
      return item;
    }),
  };
  const grant = {
    tenantId,
    dataset: ref(datasetArtifact),
    experiment: ref(experiment),
    runnerVersion: "verification-benchmark-runner.v1",
  };
  const admitted = await new RegisteredBenchmarkInputAdmission(
    new OfflineBenchmarkInputCatalog([grant]),
    resolver,
  ).load(
    {
      verificationContractVersion: "verification.v1",
      dataset: grant.dataset,
      experimentDefinition: grant.experiment,
      executionMode: "offline_recorded",
    },
    { tenantId },
  );
  resolver.authorizeArtifact.mockClear();
  resolver.hydrateRegisteredArtifact.mockClear();
  function rewriteObservation(changes: Record<string, unknown>) {
    const record = records.get(observation.artifactId)!;
    const parsed = JSON.parse(decoder.decode(record.bytes));
    Object.assign(parsed, changes);
    const { observationDigest: _ignored, ...nextMaterial } = parsed;
    parsed.observationDigest = digestCanonicalJson(nextMaterial);
    const handle = rewrite(observation, encode(parsed));
    const altered = structuredClone(admitted);
    altered.experiment.recordedObservationArtifacts[0]!.digest = handle.digest;
    return altered;
  }
  return {
    admitted,
    resolver,
    records,
    observation,
    request,
    raw,
    envelope,
    responseEnvelope,
    rewrite,
    rewriteObservation,
  };
}

describe("registered benchmark observation custody", () => {
  it("hydrates a canonical v1 envelope with exact request/raw lineage and keeps replay pending", async () => {
    const value = await fixture();
    const result = await hydrateRegisteredBenchmarkObservations({ ...value, tenantId });
    expect(result).toHaveLength(1);
    expect(result[0]?.replayRequired).toBe(true);
    expect(result[0]?.requestArtifact.artifactId).toBe(value.request.artifactId);
    expect(result[0]?.rawResponseArtifact.digest).toBe(value.raw.digest);
    expect(sha256Digest(Buffer.from(result[0]!.rawResponseBase64, "base64"))).toBe(value.raw.digest);
    expect(Object.isFrozen(result[0]?.observation.output)).toBe(true);
    expect(value.resolver.hydrateRegisteredArtifact).toHaveBeenCalledTimes(4);
  });

  it("rejects missing custody parents and modified registered bytes", async () => {
    const value = await fixture();
    value.records.get(value.observation.artifactId)!.registration = { ...value.observation, parentArtifactIds: [] };
    await expect(hydrateRegisteredBenchmarkObservations({ ...value, tenantId })).rejects.toThrow(
      "CUSTODY_PARENT_REQUIRED",
    );
    value.records.get(value.observation.artifactId)!.registration = value.observation;
    value.records.get(value.raw.artifactId)!.bytes = encode({ forged: true });
    await expect(hydrateRegisteredBenchmarkObservations({ ...value, tenantId })).rejects.toThrow(
      "ARTIFACT_BINDING_INVALID",
    );
  });

  it("rejects valid outer artifacts with a wrong envelope binding, parent order, or signature", async () => {
    const wrongBinding = await fixture();
    const envelopeRecord = wrongBinding.records.get(wrongBinding.envelope.artifactId)!;
    wrongBinding.rewrite(
      wrongBinding.envelope,
      encodeCanonical({ ...wrongBinding.responseEnvelope, requestArtifactId: wrongBinding.raw.artifactId }),
    );
    const altered = wrongBinding.rewriteObservation({ envelopeDigest: envelopeRecord.registration.digest });
    await expect(
      hydrateRegisteredBenchmarkObservations({ admitted: altered, resolver: wrongBinding.resolver, tenantId }),
    ).rejects.toThrow("ENVELOPE_BINDING_INVALID");

    const reversedParents = await fixture();
    reversedParents.rewrite(
      reversedParents.envelope,
      reversedParents.records.get(reversedParents.envelope.artifactId)!.bytes,
      { parentArtifactIds: [reversedParents.raw.artifactId, reversedParents.request.artifactId] },
    );
    await expect(hydrateRegisteredBenchmarkObservations({ ...reversedParents, tenantId })).rejects.toThrow(
      "ENVELOPE_BINDING_INVALID",
    );

    const wrongSignature = await fixture();
    wrongSignature.rewrite(
      wrongSignature.envelope,
      wrongSignature.records.get(wrongSignature.envelope.artifactId)!.bytes,
      { transformationSignature: sha256Digest("wrong-signature") },
    );
    await expect(hydrateRegisteredBenchmarkObservations({ ...wrongSignature, tenantId })).rejects.toThrow(
      "ENVELOPE_BINDING_INVALID",
    );
  });

  it("rejects a request whose retained JSON no longer has the envelope request digest", async () => {
    const value = await fixture();
    value.rewrite(value.request, encodeCanonical({ fixture: "changed" }));
    await expect(hydrateRegisteredBenchmarkObservations({ ...value, tenantId })).rejects.toThrow(
      "REQUEST_DIGEST_INVALID",
    );
  });

  it.each(["noncanonical", "unknown-field"])("rejects %s envelopes even with rebound outer digests", async (kind) => {
    const value = await fixture();
    const bytes =
      kind === "noncanonical"
        ? new TextEncoder().encode(JSON.stringify(value.responseEnvelope, null, 2))
        : encodeCanonical({ ...value.responseEnvelope, httpStatus: 200 });
    const handle = value.rewrite(value.envelope, bytes);
    const admitted = value.rewriteObservation({ envelopeDigest: handle.digest });
    await expect(
      hydrateRegisteredBenchmarkObservations({ admitted, resolver: value.resolver, tenantId }),
    ).rejects.toThrow(kind === "noncanonical" ? "ENVELOPE_CANONICAL_INVALID" : "ENVELOPE_SCHEMA_INVALID");
  });

  it("rejects a foreign tenant and cancellation before artifact access", async () => {
    const value = await fixture();
    await expect(
      hydrateRegisteredBenchmarkObservations({ ...value, tenantId: "22222222-2222-4222-8222-222222222222" }),
    ).rejects.toThrow("INPUT_BINDING_INVALID");
    const controller = new AbortController();
    controller.abort("private reason");
    await expect(
      hydrateRegisteredBenchmarkObservations({ ...value, tenantId, signal: controller.signal }),
    ).rejects.toThrow(/^BENCHMARK_CANCELLED$/);
    expect(value.resolver.authorizeArtifact).not.toHaveBeenCalled();
  });

  it.each(["self-digest", "case"])("rejects %s drift even when outer registered bytes match", async (kind) => {
    const value = await fixture();
    const record = value.records.get(value.observation.artifactId)!;
    const parsed = JSON.parse(decoder.decode(record.bytes));
    if (kind === "self-digest") parsed.observationDigest = sha256Digest("wrong");
    else {
      parsed.caseDigest = sha256Digest("wrong-case");
      const { observationDigest: _ignored, ...material } = parsed;
      parsed.observationDigest = digestCanonicalJson(material);
    }
    const handle = value.rewrite(value.observation, encode(parsed));
    const admitted = structuredClone(value.admitted);
    admitted.experiment.recordedObservationArtifacts[0]!.digest = handle.digest;
    await expect(
      hydrateRegisteredBenchmarkObservations({ admitted, resolver: value.resolver, tenantId }),
    ).rejects.toThrow("CASE_BINDING_INVALID");
  });
});
