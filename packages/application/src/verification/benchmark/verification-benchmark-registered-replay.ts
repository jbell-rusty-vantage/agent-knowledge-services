import {
  DiagnosticsBenchmarkExtractionOutputSchema,
  DiagnosticsBenchmarkLiveFailedCallCheckpointSchema,
  DiagnosticsBenchmarkLiveCallCheckpointSchema,
  UuidSchema,
  VerificationArtifactHandleSchema,
  type DiagnosticsBenchmarkProviderObservation,
  type VerificationArtifactHandle,
} from "@aiengineer/knowledge-contracts";
import { deepFreeze } from "@aiengineer/knowledge-core";
import {
  canonicalizeJson,
  providerDigest,
  sha256Digest,
  type TrustedArtifactResolver,
} from "@aiengineer/knowledge-verification";
import { verificationBenchmarkDigest } from "@aiengineer/knowledge-evaluation";
import { assertFrozenVerificationBenchmarkDataset } from "@aiengineer/knowledge-evaluation";
import {
  assertDiagnosticsExtractionWireRequest,
  createDiagnosticsFieldLedgerArtifact,
  createDiagnosticsExtractionProviderInput,
  verifyDiagnosticsExtractionOutput,
} from "./verification-benchmark.js";
import type { AdmittedOfflineBenchmarkInputs } from "./verification-benchmark-inputs.js";
import { hydrateRegisteredBenchmarkObservations } from "./verification-benchmark-observations.js";
import type { AdmittedRegisteredBenchmarkProfile } from "./verification-benchmark-registered-profile.js";
import { replayDiagnosticsCapturedResponse } from "./verification-benchmark-response-replay.js";

type ArtifactReference = { readonly artifactId: string; readonly digest: string };
export interface RegisteredBenchmarkReplayCheckpointReference extends ArtifactReference {
  readonly runIdentityDigest: string;
}
export interface RegisteredBenchmarkReplayGrant {
  readonly tenantId: string;
  readonly dataset: ArtifactReference;
  readonly experiment: ArtifactReference;
  readonly checkpoints: readonly RegisteredBenchmarkReplayCheckpointReference[];
}

export interface RegisteredBenchmarkReplayObservation {
  readonly checkpoint: Readonly<{
    artifactId: string;
    digest: string;
    checkpointDigest: string;
    runIdentityDigest: string;
  }>;
  readonly caseId: string;
  readonly role: DiagnosticsBenchmarkProviderObservation["role"];
  readonly observation: DiagnosticsBenchmarkProviderObservation;
  readonly replay: Readonly<{ memoryFetches: 1; externalRequests: 0 }>;
  readonly fieldMechanics: Readonly<{
    schemaValid: boolean;
    fieldMechanics: boolean;
    requestedFieldCount: number;
    extractedFieldCount: number;
  }> | null;
  /** Source locators are not replay authority; current projections must be prepared separately. */
  readonly requiresCurrentProjectionPreparation: true;
}

export interface RegisteredBenchmarkReplayFailure {
  readonly checkpoint: Readonly<{
    artifactId: string;
    digest: string;
    checkpointDigest: string;
    runIdentityDigest: string;
  }>;
  readonly caseId: string;
  readonly role: DiagnosticsBenchmarkProviderObservation["role"];
  readonly provider: DiagnosticsBenchmarkProviderObservation["provider"];
  readonly model: DiagnosticsBenchmarkProviderObservation["model"];
  readonly sourceBinding: ReturnType<typeof DiagnosticsBenchmarkLiveFailedCallCheckpointSchema.parse>["sourceBinding"];
  readonly failure: Readonly<{
    failureClass: "provider" | "schema";
    failureCode:
      | "PROVIDER_HTTP_FAILURE_CAPTURED"
      | "PROVIDER_OUTPUT_SCHEMA_INVALID_CAPTURED"
      | "EXTRACTION_FIELD_MATRIX_INVALID_CAPTURED";
    adapterFailureCode: string | null;
    providerHttpStatus: number;
    automaticRetry: false;
  }>;
  readonly historical: Readonly<{
    attemptId: string;
    accounting: ReturnType<typeof DiagnosticsBenchmarkLiveFailedCallCheckpointSchema.parse>["accounting"];
    latencyMs: number;
    completedAt: string;
  }>;
  readonly replay: Readonly<{ memoryFetches: 1; externalRequests: 0 }>;
  /** Source locators are not replay authority; current projections must be prepared separately. */
  readonly requiresCurrentProjectionPreparation: true;
}

export type RegisteredBenchmarkReplayOutcome =
  | Readonly<{ outcome: "observed"; observation: RegisteredBenchmarkReplayObservation }>
  | Readonly<{ outcome: "failed"; failure: RegisteredBenchmarkReplayFailure }>;

export interface RegisteredBenchmarkReplayResult {
  readonly outcomes: readonly RegisteredBenchmarkReplayOutcome[];
}

const maximumCheckpoints = 512,
  maximumArtifactBytes = 8 * 1024 * 1024,
  maximumTotalBytes = 32 * 1024 * 1024;

/** Runtime-owned authorization for replayable successful checkpoints only. */
export class RegisteredBenchmarkReplayCatalog {
  readonly #grants: ReadonlyMap<string, RegisteredBenchmarkReplayGrant>;
  constructor(grants: readonly RegisteredBenchmarkReplayGrant[]) {
    if (grants.length > 256) throw new Error("BENCHMARK_REPLAY_GRANT_BOUND_EXCEEDED");
    const values = new Map<string, RegisteredBenchmarkReplayGrant>();
    for (const raw of grants) {
      const grant = parseGrant(raw),
        key = pairKey(grant.tenantId, grant.dataset, grant.experiment);
      if (values.has(key)) throw new Error("BENCHMARK_REPLAY_DUPLICATE_TRUSTED_GRANT");
      values.set(key, grant);
    }
    this.#grants = values;
    Object.freeze(this);
  }
  resolve(tenantId: string, dataset: ArtifactReference, experiment: ArtifactReference): RegisteredBenchmarkReplayGrant {
    const grant = this.#grants.get(pairKey(tenantId, dataset, experiment));
    if (!grant) throw new Error("BENCHMARK_REPLAY_TRUSTED_GRANT_REQUIRED");
    return grant;
  }
}

/** Replays authenticated checkpoints through memory-only provider adapters. */
export class RegisteredBenchmarkReplayAdmission {
  constructor(
    private readonly catalog: RegisteredBenchmarkReplayCatalog,
    private readonly resolver: TrustedArtifactResolver,
  ) {}

  async load(
    admitted: AdmittedOfflineBenchmarkInputs,
    profile: AdmittedRegisteredBenchmarkProfile,
    tenantValue: unknown,
    signal?: AbortSignal,
  ): Promise<readonly RegisteredBenchmarkReplayObservation[]> {
    const result = await this.loadWithFailures(admitted, profile, tenantValue, signal);
    if (result.outcomes.some((item) => item.outcome === "failed"))
      throw new Error("BENCHMARK_REPLAY_FAILURE_AWARE_LOAD_REQUIRED");
    return deepFreeze(
      result.outcomes.map((item) => {
        if (item.outcome !== "observed") throw new Error("BENCHMARK_REPLAY_FAILURE_AWARE_LOAD_REQUIRED");
        return item.observation;
      }),
    ) as readonly RegisteredBenchmarkReplayObservation[];
  }

  async loadWithFailures(
    admitted: AdmittedOfflineBenchmarkInputs,
    profile: AdmittedRegisteredBenchmarkProfile,
    tenantValue: unknown,
    signal?: AbortSignal,
  ): Promise<RegisteredBenchmarkReplayResult> {
    const tenantId = parseTenant(tenantValue);
    assertActive(signal);
    const pair = admittedPair(admitted, tenantId);
    if (
      profile.authority.datasetManifestDigest !== admitted.dataset.manifestDigest ||
      profile.sealedExperiment.datasetManifestDigest !== admitted.dataset.manifestDigest
    )
      throw new Error("BENCHMARK_REPLAY_PROFILE_ADMITTED_BINDING_INVALID");
    const grant = this.catalog.resolve(tenantId, pair.dataset, pair.experiment);
    const artifactCache = new Map<
      string,
      { readonly handle: VerificationArtifactHandle; readonly bytes: Uint8Array }
    >();
    let totalBytes = 0;
    const hydrateHandle = async (expected: VerificationArtifactHandle) => {
      assertActive(signal);
      const cached = artifactCache.get(expected.artifactId);
      if (cached) {
        if (!sameHandle(cached.handle, expected)) throw new Error("BENCHMARK_REPLAY_ARTIFACT_HANDLE_MISMATCH");
        return cached;
      }
      await this.resolver.authorizeArtifact({
        tenantId,
        artifactId: expected.artifactId,
        purpose: "verification_admission",
      });
      assertActive(signal);
      const hydrated = await this.resolver.hydrateRegisteredArtifact({ tenantId, artifactId: expected.artifactId });
      assertActive(signal);
      const handle = VerificationArtifactHandleSchema.parse(hydrated.registration);
      if (
        !sameHandle(handle, expected) ||
        handle.tenantId !== tenantId ||
        hydrated.bytes.byteLength > maximumArtifactBytes ||
        handle.byteLength !== hydrated.bytes.byteLength ||
        sha256Digest(hydrated.bytes) !== handle.digest
      )
        throw new Error("BENCHMARK_REPLAY_ARTIFACT_REGISTRATION_MISMATCH");
      totalBytes += hydrated.bytes.byteLength;
      if (totalBytes > maximumTotalBytes) throw new Error("BENCHMARK_REPLAY_TOTAL_BYTE_BOUND_EXCEEDED");
      const result = { handle, bytes: hydrated.bytes.slice() };
      artifactCache.set(handle.artifactId, result);
      return result;
    };
    const hydrateReference = async (reference: ArtifactReference) => {
      const expected = await this.#hydrateReference(tenantId, reference, signal);
      totalBytes += expected.bytes.byteLength;
      if (totalBytes > maximumTotalBytes) throw new Error("BENCHMARK_REPLAY_TOTAL_BYTE_BOUND_EXCEEDED");
      return expected;
    };
    type SuccessfulCheckpoint = ReturnType<typeof DiagnosticsBenchmarkLiveCallCheckpointSchema.parse>;
    type FailedCheckpoint = ReturnType<typeof DiagnosticsBenchmarkLiveFailedCallCheckpointSchema.parse>;
    type HydratedCheckpoint = {
      reference: RegisteredBenchmarkReplayCheckpointReference;
      checkpointHandle: VerificationArtifactHandle;
      parsed: SuccessfulCheckpoint | FailedCheckpoint;
      artifacts: ReadonlyMap<string, { readonly handle: VerificationArtifactHandle; readonly bytes: Uint8Array }>;
    };
    const checkpoints: HydratedCheckpoint[] = [];
    const uniqueCaseRoles = new Set<string>();
    const sourceBindingsByCase = new Map<string, string>();
    for (const reference of grant.checkpoints) {
      const checkpoint = await hydrateReference(reference);
      let parsed: SuccessfulCheckpoint | FailedCheckpoint;
      try {
        const raw = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(checkpoint.bytes)) as {
          schemaVersion?: unknown;
        };
        if (raw?.schemaVersion === "diagnostics-benchmark-live-call-checkpoint.v1") {
          parsed = DiagnosticsBenchmarkLiveCallCheckpointSchema.parse(raw);
        } else if (raw?.schemaVersion === "diagnostics-benchmark-live-failed-call-checkpoint.v1") {
          parsed = DiagnosticsBenchmarkLiveFailedCallCheckpointSchema.parse(raw);
        } else throw new Error();
      } catch {
        throw new Error("BENCHMARK_REPLAY_CHECKPOINT_SCHEMA_INVALID");
      }
      const { checkpointDigest: _ignored, ...checkpointMaterial } = parsed;
      if (
        parsed.checkpointDigest !== verificationBenchmarkDigest(checkpointMaterial) ||
        parsed.runIdentityDigest !== reference.runIdentityDigest ||
        parsed.datasetManifestDigest !== profile.authority.datasetManifestDigest ||
        parsed.experimentManifestDigest !== profile.authority.experimentManifestDigest
      )
        throw new Error("BENCHMARK_REPLAY_CHECKPOINT_BINDING_INVALID");
      if (
        parsed.schemaVersion === "diagnostics-benchmark-live-failed-call-checkpoint.v1" &&
        (parsed.failureCode === "PROVIDER_HTTP_FAILURE_CAPTURED") !== (parsed.failureClass === "provider")
      )
        throw new Error("BENCHMARK_REPLAY_FAILED_CHECKPOINT_ATTRIBUTION_INVALID");
      const testCase = admitted.dataset.cases.find((item) => item.caseId === parsed.caseId);
      const plan = profile.sealedExperiment.providerCallPlan.find((item) => item.role === parsed.role);
      const observationPacked = parsed.artifacts.find((item) => item.role === "observation");
      if (
        !testCase ||
        testCase.caseDigest !== parsed.caseDigest ||
        !plan ||
        plan.provider !== parsed.provider ||
        plan.model !== parsed.model ||
        (parsed.schemaVersion === "diagnostics-benchmark-live-call-checkpoint.v1" &&
          (!observationPacked ||
            !admitted.experiment.recordedObservationArtifacts.some(
              (item) =>
                item.artifactId === observationPacked.handle.artifactId &&
                item.digest === observationPacked.handle.digest,
            ))) ||
        (parsed.schemaVersion === "diagnostics-benchmark-live-failed-call-checkpoint.v1" &&
          observationPacked !== undefined)
      )
        throw new Error("BENCHMARK_REPLAY_CHECKPOINT_ADMITTED_BINDING_INVALID");
      if (
        parsed.schemaVersion === "diagnostics-benchmark-live-call-checkpoint.v1" &&
        (parsed.observation.caseId !== parsed.caseId || parsed.observation.caseDigest !== parsed.caseDigest)
      )
        throw new Error("BENCHMARK_REPLAY_CHECKPOINT_BINDING_INVALID");
      const sourceInput = await hydrateHandle(parsed.sourceBinding.inputManifestArtifact);
      if (sourceInput.handle.artifactId !== testCase.inputManifestArtifactId)
        throw new Error("BENCHMARK_REPLAY_SOURCE_INPUT_BINDING_INVALID");
      const key = `${parsed.caseId}:${parsed.role}`;
      if (uniqueCaseRoles.has(key)) throw new Error("BENCHMARK_REPLAY_CHECKPOINT_DUPLICATE_CASE_ROLE");
      uniqueCaseRoles.add(key);
      const sourceBinding = canonicalizeJson(parsed.sourceBinding),
        priorSourceBinding = sourceBindingsByCase.get(parsed.caseId);
      if (priorSourceBinding !== undefined && priorSourceBinding !== sourceBinding)
        throw new Error("BENCHMARK_REPLAY_SOURCE_BINDING_CROSS_CHECKPOINT_MISMATCH");
      sourceBindingsByCase.set(parsed.caseId, sourceBinding);
      const artifacts = new Map<string, { readonly handle: VerificationArtifactHandle; readonly bytes: Uint8Array }>();
      for (const packed of parsed.artifacts) {
        const actual = await hydrateHandle(packed.handle);
        const bytes = Buffer.from(packed.bytesBase64, "base64");
        if (
          bytes.toString("base64") !== packed.bytesBase64 ||
          bytes.byteLength !== actual.bytes.byteLength ||
          !bytes.equals(Buffer.from(actual.bytes))
        )
          throw new Error("BENCHMARK_REPLAY_PACKED_ARTIFACT_BYTES_MISMATCH");
        artifacts.set(packed.role, actual);
      }
      checkpoints.push({ reference, checkpointHandle: checkpoint.handle, parsed, artifacts });
    }
    const custody = await hydrateRegisteredBenchmarkObservations({
      admitted,
      tenantId,
      resolver: this.resolver,
      ...(signal === undefined ? {} : { signal }),
    });
    const custodyByArtifact = new Map(custody.map((item) => [item.observationArtifact.artifactId, item]));
    const outcomes: RegisteredBenchmarkReplayOutcome[] = [];
    for (const checkpoint of checkpoints) {
      assertActive(signal);
      const parsed = checkpoint.parsed,
        testCase = admitted.dataset.cases.find((item) => item.caseId === parsed.caseId)!;
      const required = (role: string) => {
        const value = checkpoint.artifacts.get(role);
        if (!value) throw new Error("BENCHMARK_REPLAY_CHECKPOINT_ARTIFACT_REQUIRED");
        return value;
      };
      const request = required("request"),
        raw = required("raw_response"),
        responseEnvelope = required("response_envelope");
      assertDiagnosticsExtractionWireRequest(testCase, profile.authority, request.bytes, {
        provider: parsed.provider,
        model: parsed.model,
      });
      if (parsed.schemaVersion === "diagnostics-benchmark-live-failed-call-checkpoint.v1") {
        const envelope = assertResponseEnvelope(request, raw, responseEnvelope);
        const replay = await replayDiagnosticsCapturedResponse({
          testCase,
          authority: profile.authority,
          role: parsed.role,
          rawResponseBytes: raw.bytes,
          httpStatus: parsed.providerHttpStatus,
        });
        assertActive(signal);
        if (replay.memoryFetches !== 1 || replay.externalRequests !== 0)
          throw new Error("BENCHMARK_REPLAY_FAILED_ADAPTER_REPLAY_INVALID");
        if (
          !replay.accepted &&
          (checkpoint.artifacts.has("provider_precontext") || checkpoint.artifacts.has("precontext_envelope"))
        )
          throw new Error("BENCHMARK_REPLAY_FAILED_PRECONTEXT_REPLAY_UNSUPPORTED");
        if (parsed.failureCode === "PROVIDER_HTTP_FAILURE_CAPTURED") {
          if (
            replay.accepted ||
            replay.failureCode !== "PROVIDER_HTTP_FAILURE" ||
            parsed.adapterFailureCode !== replay.failureCode
          )
            throw new Error("BENCHMARK_REPLAY_FAILED_ADAPTER_REPLAY_INVALID");
        } else if (parsed.failureCode === "PROVIDER_OUTPUT_SCHEMA_INVALID_CAPTURED") {
          if (
            replay.accepted ||
            parsed.adapterFailureCode !== replay.failureCode ||
            !["PROVIDER_RESPONSE_INVALID", "PROVIDER_RESPONSE_SCHEMA_INVALID", "PROVIDER_RESPONSE_TOO_LARGE"].includes(
              replay.failureCode,
            )
          )
            throw new Error("BENCHMARK_REPLAY_FAILED_ADAPTER_REPLAY_INVALID");
        } else {
          if (!replay.accepted || parsed.adapterFailureCode !== null || parsed.role === "haiku_judge")
            throw new Error("BENCHMARK_REPLAY_FAILED_MATRIX_REPLAY_INVALID");
          let rejected = false;
          try {
            verifyDiagnosticsExtractionOutput({
              testCase,
              authority: profile.authority,
              output: DiagnosticsBenchmarkExtractionOutputSchema.parse(replay.output),
              fragmentArtifact: required("granted_fragment").handle,
              fragmentBytes: required("granted_fragment").bytes,
            });
          } catch (error) {
            rejected = error instanceof Error && error.message === "BENCHMARK_EXTRACTION_FIELD_MATRIX_INVALID";
          }
          if (!rejected) throw new Error("BENCHMARK_REPLAY_FAILED_MATRIX_REPLAY_INVALID");
        }
        assertPrecontext(checkpoint.artifacts, replay.accepted ? replay.precontextBytes : null, envelope.requestDigest);
        if (
          parsed.accounting.requestArtifactId !== request.handle.artifactId ||
          parsed.accounting.responseArtifactId !== responseEnvelope.handle.artifactId
        )
          throw new Error("BENCHMARK_REPLAY_ACCOUNTING_ARTIFACT_BINDING_INVALID");
        const failure: RegisteredBenchmarkReplayFailure = {
          checkpoint: {
            artifactId: checkpoint.checkpointHandle.artifactId,
            digest: checkpoint.checkpointHandle.digest,
            checkpointDigest: parsed.checkpointDigest,
            runIdentityDigest: parsed.runIdentityDigest,
          },
          caseId: parsed.caseId,
          role: parsed.role,
          provider: parsed.provider,
          model: parsed.model,
          sourceBinding: parsed.sourceBinding,
          failure: {
            failureClass: parsed.failureClass,
            failureCode: parsed.failureCode,
            adapterFailureCode: parsed.adapterFailureCode,
            providerHttpStatus: parsed.providerHttpStatus,
            automaticRetry: false,
          },
          historical: {
            attemptId: parsed.attemptId,
            accounting: parsed.accounting,
            latencyMs: parsed.latencyMs,
            completedAt: parsed.completedAt,
          },
          replay: { memoryFetches: 1, externalRequests: 0 },
          requiresCurrentProjectionPreparation: true,
        };
        outcomes.push({ outcome: "failed", failure });
        continue;
      }
      const observationArtifact = required("observation"),
        custodyObservation = custodyByArtifact.get(observationArtifact.handle.artifactId);
      if (
        !custodyObservation ||
        !sameHandle(custodyObservation.observationArtifact, observationArtifact.handle) ||
        canonicalizeJson(parsed.observation) !==
          new TextDecoder("utf8", { fatal: true }).decode(observationArtifact.bytes) ||
        canonicalizeJson(custodyObservation.observation) !== canonicalizeJson(parsed.observation)
      )
        throw new Error("BENCHMARK_REPLAY_OBSERVATION_CUSTODY_INVALID");
      if (
        !sameHandle(request.handle, custodyObservation.requestArtifact) ||
        !sameHandle(raw.handle, custodyObservation.rawResponseArtifact) ||
        !sameHandle(responseEnvelope.handle, custodyObservation.responseEnvelopeArtifact)
      )
        throw new Error("BENCHMARK_REPLAY_PACKED_CUSTODY_CHAIN_MISMATCH");
      const replay = await replayDiagnosticsCapturedResponse({
        testCase,
        authority: profile.authority,
        role: parsed.role,
        rawResponseBytes: raw.bytes,
        httpStatus: parsed.providerHttpStatus,
      });
      assertActive(signal);
      if (
        !replay.accepted ||
        replay.memoryFetches !== 1 ||
        replay.externalRequests !== 0 ||
        canonicalizeJson(replay.output) !== canonicalizeJson(parsed.observation.output)
      )
        throw new Error("BENCHMARK_REPLAY_ADAPTER_OUTPUT_MISMATCH");
      assertPrecontext(checkpoint.artifacts, replay.precontextBytes, parsed.observation.requestDigest);
      let fieldMechanics: RegisteredBenchmarkReplayObservation["fieldMechanics"] = null;
      if (parsed.role !== "haiku_judge") {
        const recomputed = verifyDiagnosticsExtractionOutput({
          testCase,
          authority: profile.authority,
          output: DiagnosticsBenchmarkExtractionOutputSchema.parse(parsed.observation.output),
          fragmentArtifact: required("granted_fragment").handle,
          fragmentBytes: required("granted_fragment").bytes,
        });
        const ledger = createDiagnosticsFieldLedgerArtifact({
          runIdentityDigest: parsed.runIdentityDigest as `sha256:${string}`,
          caseDigest: parsed.caseDigest as `sha256:${string}`,
          role: parsed.role,
          observationArtifactId: observationArtifact.handle.artifactId,
          fieldResult: recomputed,
        });
        if (
          parsed.fieldLedger === null ||
          canonicalizeJson(recomputed) !== canonicalizeJson(parsed.fieldLedger) ||
          !Buffer.from(required("field_ledger").bytes).equals(
            Buffer.from(new TextEncoder().encode(canonicalizeJson(ledger))),
          )
        )
          throw new Error("BENCHMARK_REPLAY_FIELD_MECHANICS_INVALID");
        fieldMechanics = {
          schemaValid: recomputed.schemaValid,
          fieldMechanics: recomputed.fieldMechanics,
          requestedFieldCount: recomputed.requestedFieldCount,
          extractedFieldCount: recomputed.extractedFieldCount,
        };
      }
      if (
        !responseEnvelope.handle.artifactId ||
        parsed.accounting.requestArtifactId !== request.handle.artifactId ||
        parsed.accounting.responseArtifactId !== responseEnvelope.handle.artifactId
      )
        throw new Error("BENCHMARK_REPLAY_ACCOUNTING_ARTIFACT_BINDING_INVALID");
      const observation: RegisteredBenchmarkReplayObservation = {
        checkpoint: {
          artifactId: checkpoint.checkpointHandle.artifactId,
          digest: checkpoint.checkpointHandle.digest,
          checkpointDigest: parsed.checkpointDigest,
          runIdentityDigest: parsed.runIdentityDigest,
        },
        caseId: parsed.caseId,
        role: parsed.role,
        observation: parsed.observation,
        replay: { memoryFetches: 1, externalRequests: 0 },
        fieldMechanics,
        requiresCurrentProjectionPreparation: true,
      };
      outcomes.push({ outcome: "observed", observation });
    }
    assertActive(signal);
    return deepFreeze({ outcomes }) as RegisteredBenchmarkReplayResult;
  }

  async #hydrateReference(
    tenantId: string,
    reference: ArtifactReference,
    signal?: AbortSignal,
  ): Promise<{ readonly handle: VerificationArtifactHandle; readonly bytes: Uint8Array }> {
    assertActive(signal);
    await this.resolver.authorizeArtifact({
      tenantId,
      artifactId: reference.artifactId,
      purpose: "verification_admission",
    });
    assertActive(signal);
    const hydrated = await this.resolver.hydrateRegisteredArtifact({ tenantId, artifactId: reference.artifactId });
    assertActive(signal);
    const handle = VerificationArtifactHandleSchema.parse(hydrated.registration);
    if (
      handle.tenantId !== tenantId ||
      handle.artifactId !== reference.artifactId ||
      handle.digest !== reference.digest ||
      hydrated.bytes.byteLength > maximumArtifactBytes ||
      handle.byteLength !== hydrated.bytes.byteLength ||
      sha256Digest(hydrated.bytes) !== handle.digest
    )
      throw new Error("BENCHMARK_REPLAY_CHECKPOINT_REGISTRATION_MISMATCH");
    return { handle, bytes: hydrated.bytes.slice() };
  }
}

type HydratedArtifact = { readonly handle: VerificationArtifactHandle; readonly bytes: Uint8Array };

function assertResponseEnvelope(
  request: HydratedArtifact,
  raw: HydratedArtifact,
  responseEnvelope: HydratedArtifact,
): { readonly requestDigest: string } {
  let text: string, parsed: unknown;
  try {
    text = new TextDecoder("utf8", { fatal: true }).decode(responseEnvelope.bytes);
    parsed = JSON.parse(text);
  } catch {
    throw new Error("BENCHMARK_REPLAY_RESPONSE_ENVELOPE_JSON_INVALID");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("BENCHMARK_REPLAY_RESPONSE_ENVELOPE_SCHEMA_INVALID");
  const value = parsed as Record<string, unknown>,
    keys = Object.keys(value).sort();
  const expected = [
    "rawResponseArtifactId",
    "rawResponseDigest",
    "requestArtifactId",
    "requestDigest",
    "schemaVersion",
  ];
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index]) ||
    value.schemaVersion !== "verification-provider-response-envelope.v1" ||
    typeof value.requestDigest !== "string" ||
    value.requestArtifactId !== request.handle.artifactId ||
    value.rawResponseArtifactId !== raw.handle.artifactId ||
    value.rawResponseDigest !== raw.handle.digest ||
    canonicalizeJson(value) !== text ||
    request.handle.artifactId === raw.handle.artifactId ||
    responseEnvelope.handle.parentArtifactIds.length !== 2 ||
    responseEnvelope.handle.parentArtifactIds[0] !== request.handle.artifactId ||
    responseEnvelope.handle.parentArtifactIds[1] !== raw.handle.artifactId ||
    responseEnvelope.handle.transformationSignature !==
      providerDigest({
        kind: "verification_provider_response_envelope.v1",
        requestDigest: value.requestDigest,
        rawResponseDigest: raw.handle.digest,
      })
  )
    throw new Error("BENCHMARK_REPLAY_RESPONSE_ENVELOPE_BINDING_INVALID");
  let actualRequestDigest: string;
  try {
    actualRequestDigest = providerDigest(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(request.bytes)));
  } catch {
    throw new Error("BENCHMARK_REPLAY_REQUEST_JSON_INVALID");
  }
  if (actualRequestDigest !== value.requestDigest || raw.bytes.byteLength > 160_000)
    throw new Error("BENCHMARK_REPLAY_RESPONSE_ENVELOPE_BINDING_INVALID");
  return { requestDigest: value.requestDigest };
}

function assertPrecontext(
  artifacts: ReadonlyMap<string, HydratedArtifact>,
  replayed: Uint8Array | null | undefined,
  requestDigest: string,
): void {
  const precontext = artifacts.get("provider_precontext"),
    envelope = artifacts.get("precontext_envelope"),
    responseEnvelope = artifacts.get("response_envelope");
  if (replayed !== undefined && (replayed === null) !== (!precontext && !envelope))
    throw new Error("BENCHMARK_REPLAY_PRECONTEXT_PRESENCE_INVALID");
  if (!precontext && !envelope) return;
  if (
    !precontext ||
    !envelope ||
    !responseEnvelope ||
    (replayed !== undefined && (replayed === null || !Buffer.from(replayed).equals(Buffer.from(precontext.bytes))))
  )
    throw new Error("BENCHMARK_REPLAY_PRECONTEXT_BYTES_INVALID");
  let parsed: unknown;
  try {
    const text = new TextDecoder("utf8", { fatal: true }).decode(envelope.bytes);
    parsed = JSON.parse(text);
    if (canonicalizeJson(parsed) !== text) throw new Error();
  } catch {
    throw new Error("BENCHMARK_REPLAY_PRECONTEXT_ENVELOPE_INVALID");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("BENCHMARK_REPLAY_PRECONTEXT_ENVELOPE_INVALID");
  const value = parsed as Record<string, unknown>,
    keys = Object.keys(value).sort(),
    expected = [
      "precontextArtifactId",
      "precontextDigest",
      "requestDigest",
      "responseEnvelopeArtifactId",
      "schemaVersion",
    ];
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index]) ||
    value.schemaVersion !== "verification-provider-precontext-envelope.v1" ||
    value.requestDigest !== requestDigest ||
    value.responseEnvelopeArtifactId !== responseEnvelope.handle.artifactId ||
    value.precontextArtifactId !== precontext.handle.artifactId ||
    value.precontextDigest !== precontext.handle.digest ||
    envelope.handle.parentArtifactIds.length !== 2 ||
    envelope.handle.parentArtifactIds[0] !== responseEnvelope.handle.artifactId ||
    envelope.handle.parentArtifactIds[1] !== precontext.handle.artifactId ||
    envelope.handle.transformationSignature !==
      providerDigest({
        kind: "verification_provider_precontext_envelope.v1",
        requestDigest,
        precontextDigest: precontext.handle.digest,
      })
  )
    throw new Error("BENCHMARK_REPLAY_PRECONTEXT_ENVELOPE_INVALID");
}

function sameHandle(left: VerificationArtifactHandle, right: VerificationArtifactHandle): boolean {
  return canonicalizeJson(left) === canonicalizeJson(right);
}
function parseTenant(value: unknown): string {
  const parsed = UuidSchema.safeParse(value);
  if (!parsed.success) throw new Error("BENCHMARK_REPLAY_CONTEXT_TENANT_INVALID");
  return parsed.data;
}
function pairKey(tenantId: string, dataset: ArtifactReference, experiment: ArtifactReference): string {
  return `${tenantId}:${dataset.artifactId}:${dataset.digest}:${experiment.artifactId}:${experiment.digest}`;
}
function assertActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("BENCHMARK_CANCELLED");
}
function artifactReference(value: unknown, code: string): ArtifactReference {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof (value as Record<string, unknown>).artifactId !== "string" ||
    typeof (value as Record<string, unknown>).digest !== "string"
  )
    throw new Error(`BENCHMARK_REPLAY_${code}_INVALID`);
  const id = UuidSchema.safeParse((value as { artifactId: string }).artifactId),
    digest = (value as { digest: string }).digest;
  if (!id.success || !/^sha256:[a-f0-9]{64}$/u.test(digest)) throw new Error(`BENCHMARK_REPLAY_${code}_INVALID`);
  return { artifactId: id.data, digest };
}
function parseGrant(value: RegisteredBenchmarkReplayGrant): RegisteredBenchmarkReplayGrant {
  const tenantId = parseTenant(value?.tenantId),
    dataset = artifactReference(value?.dataset, "GRANT_DATASET"),
    experiment = artifactReference(value?.experiment, "GRANT_EXPERIMENT");
  if (!Array.isArray(value?.checkpoints) || value.checkpoints.length > maximumCheckpoints)
    throw new Error("BENCHMARK_REPLAY_TRUSTED_GRANT_INVALID");
  const ids = new Set<string>(),
    checkpoints = value.checkpoints.map((raw) => {
      const reference = artifactReference(raw, "GRANT_CHECKPOINT");
      if (
        typeof raw.runIdentityDigest !== "string" ||
        !/^sha256:[a-f0-9]{64}$/u.test(raw.runIdentityDigest) ||
        ids.has(reference.artifactId)
      )
        throw new Error("BENCHMARK_REPLAY_TRUSTED_GRANT_INVALID");
      ids.add(reference.artifactId);
      return Object.freeze({ ...reference, runIdentityDigest: raw.runIdentityDigest });
    });
  return Object.freeze({
    tenantId,
    dataset: Object.freeze(dataset),
    experiment: Object.freeze(experiment),
    checkpoints: Object.freeze(checkpoints),
  });
}
function admittedPair(
  admitted: AdmittedOfflineBenchmarkInputs,
  tenantId: string,
): { dataset: ArtifactReference; experiment: ArtifactReference } {
  try {
    assertFrozenVerificationBenchmarkDataset(admitted.dataset);
  } catch {
    throw new Error("BENCHMARK_REPLAY_ADMITTED_BINDING_INVALID");
  }
  const dataset = artifactReference(admitted?.datasetArtifact, "ADMITTED_DATASET"),
    experiment = artifactReference(admitted?.experimentArtifact, "ADMITTED_EXPERIMENT");
  if (
    admitted.grant.tenantId !== tenantId ||
    admitted.datasetArtifact.tenantId !== tenantId ||
    admitted.experimentArtifact.tenantId !== tenantId ||
    admitted.request.dataset.artifactId !== dataset.artifactId ||
    admitted.request.dataset.digest !== dataset.digest ||
    admitted.request.experimentDefinition.artifactId !== experiment.artifactId ||
    admitted.request.experimentDefinition.digest !== experiment.digest ||
    admitted.grant.dataset.artifactId !== dataset.artifactId ||
    admitted.grant.dataset.digest !== dataset.digest ||
    admitted.grant.experiment.artifactId !== experiment.artifactId ||
    admitted.grant.experiment.digest !== experiment.digest ||
    admitted.experiment.datasetManifestDigest !== admitted.dataset.manifestDigest ||
    admitted.experiment.networkPolicy !== "offline"
  )
    throw new Error("BENCHMARK_REPLAY_ADMITTED_BINDING_INVALID");
  return { dataset, experiment };
}
