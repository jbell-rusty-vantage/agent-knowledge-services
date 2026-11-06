import {
  DiagnosticsBenchmarkProviderObservationSchema,
  UuidSchema,
  VerificationArtifactHandleSchema,
  type VerificationArtifactHandle,
} from "@aiengineer/knowledge-contracts";
import { deepFreeze } from "@aiengineer/knowledge-core";
import { assertFrozenVerificationBenchmarkDataset } from "@aiengineer/knowledge-evaluation";
import {
  canonicalizeJson,
  digestCanonicalJson,
  providerDigest,
  sha256Digest,
  type TrustedArtifactResolver,
} from "@aiengineer/knowledge-verification";
import type { AdmittedOfflineBenchmarkInputs } from "./verification-benchmark-inputs.js";

const roles = {
  luna_extractor: { provider: "gateway", model: "openai/gpt-5.6-luna" },
  interfaze_extractor: { provider: "interfaze", model: "interfaze-beta" },
  haiku_judge: { provider: "gateway", model: "anthropic/claude-haiku-4.5" },
} as const;

const responseEnvelopeKeys = [
  "rawResponseArtifactId",
  "rawResponseDigest",
  "requestArtifactId",
  "requestDigest",
  "schemaVersion",
] as const;
type ResponseEnvelope = Readonly<{
  schemaVersion: "verification-provider-response-envelope.v1";
  requestDigest: string;
  requestArtifactId: string;
  rawResponseArtifactId: string;
  rawResponseDigest: string;
}>;

function parseCanonicalResponseEnvelope(bytes: Uint8Array): ResponseEnvelope {
  let text: string;
  let parsed: unknown;
  try {
    text = new TextDecoder("utf8", { fatal: true }).decode(bytes);
    parsed = JSON.parse(text);
  } catch {
    throw new Error("BENCHMARK_OBSERVATION_ENVELOPE_JSON_INVALID");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("BENCHMARK_OBSERVATION_ENVELOPE_SCHEMA_INVALID");
  const envelope = parsed as Record<string, unknown>;
  const keys = Object.keys(envelope).sort();
  if (
    keys.length !== responseEnvelopeKeys.length ||
    keys.some((key, index) => key !== responseEnvelopeKeys[index]) ||
    envelope.schemaVersion !== "verification-provider-response-envelope.v1" ||
    typeof envelope.requestDigest !== "string" ||
    typeof envelope.requestArtifactId !== "string" ||
    typeof envelope.rawResponseArtifactId !== "string" ||
    typeof envelope.rawResponseDigest !== "string"
  )
    throw new Error("BENCHMARK_OBSERVATION_ENVELOPE_SCHEMA_INVALID");
  let canonical: string;
  try {
    canonical = canonicalizeJson(envelope);
  } catch {
    throw new Error("BENCHMARK_OBSERVATION_ENVELOPE_SCHEMA_INVALID");
  }
  if (canonical !== text) throw new Error("BENCHMARK_OBSERVATION_ENVELOPE_CANONICAL_INVALID");
  return envelope as ResponseEnvelope;
}

function requestDigest(bytes: Uint8Array): `sha256:${string}` {
  try {
    return providerDigest(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)));
  } catch {
    throw new Error("BENCHMARK_OBSERVATION_REQUEST_JSON_INVALID");
  }
}

/** Hydrates custody only. Returned outputs still require recorded adapter replay. */
export async function hydrateRegisteredBenchmarkObservations(input: {
  admitted: AdmittedOfflineBenchmarkInputs;
  tenantId: string;
  resolver: TrustedArtifactResolver;
  signal?: AbortSignal;
}) {
  const tenantId = UuidSchema.parse(input.tenantId);
  const { admitted } = input;
  if (
    admitted.grant.tenantId !== tenantId ||
    admitted.datasetArtifact.tenantId !== tenantId ||
    admitted.experimentArtifact.tenantId !== tenantId ||
    admitted.request.dataset.artifactId !== admitted.datasetArtifact.artifactId ||
    admitted.request.dataset.digest !== admitted.datasetArtifact.digest ||
    admitted.request.experimentDefinition.artifactId !== admitted.experimentArtifact.artifactId ||
    admitted.request.experimentDefinition.digest !== admitted.experimentArtifact.digest ||
    admitted.grant.dataset.artifactId !== admitted.datasetArtifact.artifactId ||
    admitted.grant.dataset.digest !== admitted.datasetArtifact.digest ||
    admitted.grant.experiment.artifactId !== admitted.experimentArtifact.artifactId ||
    admitted.grant.experiment.digest !== admitted.experimentArtifact.digest ||
    admitted.experiment.datasetManifestDigest !== admitted.dataset.manifestDigest ||
    admitted.experiment.networkPolicy !== "offline"
  )
    throw new Error("BENCHMARK_OBSERVATION_INPUT_BINDING_INVALID");
  assertFrozenVerificationBenchmarkDataset(admitted.dataset);
  const active = () => {
    if (input.signal?.aborted) throw new Error("BENCHMARK_CANCELLED");
  };
  const cache = new Map<string, { handle: VerificationArtifactHandle; bytes: Uint8Array }>();
  let totalBytes = 0;
  async function hydrate(artifactId: string) {
    active();
    const cached = cache.get(artifactId);
    if (cached) return cached;
    if (cache.size >= 2_048) throw new Error("BENCHMARK_OBSERVATION_ARTIFACT_BOUND_EXCEEDED");
    await input.resolver.authorizeArtifact({ tenantId, artifactId, purpose: "verification_admission" });
    active();
    const hydrated = await input.resolver.hydrateRegisteredArtifact({ tenantId, artifactId });
    active();
    const handle = VerificationArtifactHandleSchema.parse(hydrated.registration);
    if (
      handle.tenantId !== tenantId ||
      handle.artifactId !== artifactId ||
      hydrated.bytes.byteLength > 1_048_576 ||
      handle.byteLength !== hydrated.bytes.byteLength ||
      sha256Digest(hydrated.bytes) !== handle.digest
    )
      throw new Error("BENCHMARK_OBSERVATION_ARTIFACT_BINDING_INVALID");
    totalBytes += hydrated.bytes.byteLength;
    if (totalBytes > 32 * 1_048_576) throw new Error("BENCHMARK_OBSERVATION_BYTE_BOUND_EXCEEDED");
    const value = { handle, bytes: hydrated.bytes.slice() };
    cache.set(artifactId, value);
    return value;
  }
  const results = [];
  const caseRoles = new Set<string>();
  if (admitted.experiment.recordedObservationArtifacts.length > 512)
    throw new Error("BENCHMARK_OBSERVATION_COUNT_BOUND_EXCEEDED");
  for (const reference of admitted.experiment.recordedObservationArtifacts) {
    const record = await hydrate(reference.artifactId);
    if (record.handle.digest !== reference.digest) throw new Error("BENCHMARK_OBSERVATION_REFERENCE_DIGEST_MISMATCH");
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(record.bytes));
    } catch {
      throw new Error("BENCHMARK_OBSERVATION_JSON_INVALID");
    }
    const observation = DiagnosticsBenchmarkProviderObservationSchema.parse(parsed);
    const { observationDigest, ...material } = observation;
    const testCase = admitted.dataset.cases.find((item) => item.caseId === observation.caseId);
    const profile = roles[observation.role];
    const key = `${observation.caseId}:${observation.role}`;
    if (
      digestCanonicalJson(material) !== observationDigest ||
      !testCase ||
      testCase.caseDigest !== observation.caseDigest ||
      observation.provider !== profile.provider ||
      observation.model !== profile.model ||
      caseRoles.has(key)
    )
      throw new Error("BENCHMARK_OBSERVATION_CASE_BINDING_INVALID");
    caseRoles.add(key);
    if (
      record.handle.parentArtifactIds.length > 16 ||
      new Set(record.handle.parentArtifactIds).size !== record.handle.parentArtifactIds.length
    )
      throw new Error("BENCHMARK_OBSERVATION_PARENT_BOUND_INVALID");
    const parents: Array<Awaited<ReturnType<typeof hydrate>>> = [];
    for (const parentId of record.handle.parentArtifactIds) parents.push(await hydrate(parentId));
    const retainedByDigest = (digest: string) => {
      const matches = parents.filter((parent) => parent.handle.digest === digest);
      if (matches.length !== 1) throw new Error("BENCHMARK_OBSERVATION_CUSTODY_PARENT_REQUIRED");
      return matches[0]!;
    };
    const retainedById = (artifactId: string) => {
      const matches = parents.filter((parent) => parent.handle.artifactId === artifactId);
      if (matches.length !== 1) throw new Error("BENCHMARK_OBSERVATION_CUSTODY_PARENT_REQUIRED");
      return matches[0]!;
    };
    const envelope = retainedByDigest(observation.envelopeDigest);
    const responseEnvelope = parseCanonicalResponseEnvelope(envelope.bytes);
    const request = retainedById(responseEnvelope.requestArtifactId);
    const raw = retainedById(responseEnvelope.rawResponseArtifactId);
    if (
      request.handle.artifactId === raw.handle.artifactId ||
      responseEnvelope.requestDigest !== observation.requestDigest ||
      responseEnvelope.rawResponseDigest !== observation.rawResponseDigest ||
      raw.handle.digest !== responseEnvelope.rawResponseDigest ||
      envelope.handle.parentArtifactIds.length !== 2 ||
      envelope.handle.parentArtifactIds[0] !== request.handle.artifactId ||
      envelope.handle.parentArtifactIds[1] !== raw.handle.artifactId ||
      envelope.handle.transformationSignature !==
        providerDigest({
          kind: "verification_provider_response_envelope.v1",
          requestDigest: responseEnvelope.requestDigest,
          rawResponseDigest: responseEnvelope.rawResponseDigest,
        })
    )
      throw new Error("BENCHMARK_OBSERVATION_ENVELOPE_BINDING_INVALID");
    if (requestDigest(request.bytes) !== responseEnvelope.requestDigest)
      throw new Error("BENCHMARK_OBSERVATION_REQUEST_DIGEST_INVALID");
    if (raw.bytes.byteLength > 160_000) throw new Error("BENCHMARK_OBSERVATION_RESPONSE_BOUND_EXCEEDED");
    results.push({
      observation,
      observationArtifact: record.handle,
      requestArtifact: request.handle,
      rawResponseArtifact: raw.handle,
      responseEnvelopeArtifact: envelope.handle,
      requestBase64: Buffer.from(request.bytes).toString("base64"),
      rawResponseBase64: Buffer.from(raw.bytes).toString("base64"),
      responseEnvelopeBase64: Buffer.from(envelope.bytes).toString("base64"),
      replayRequired: true as const,
    });
  }
  active();
  return deepFreeze(results);
}
