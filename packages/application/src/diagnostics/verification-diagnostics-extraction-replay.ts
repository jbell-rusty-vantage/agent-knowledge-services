import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { canonicalizeJson, sha256Digest } from "@aiengineer/knowledge-verification";
import {
  DiagnosticsBenchmarkLiveCallCheckpointSchema,
  DiagnosticsBenchmarkLiveFailedCallCheckpointSchema,
  VerificationArtifactHandleSchema,
  type VerificationArtifactHandle,
} from "@aiengineer/knowledge-contracts";
import { verificationBenchmarkDigest } from "@aiengineer/knowledge-evaluation";
import {
  loadDiagnosticsExtractionExperiment,
  verifyDiagnosticsExtractionOutput,
} from "../verification/benchmark/verification-benchmark.js";

const decoder = new TextDecoder("utf-8", { fatal: true });
const digest = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const isDigest = (value: unknown): value is `sha256:${string}` =>
  typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);

type ReplayManifestEntry = Readonly<{
  caseId: string;
  caseDigest: `sha256:${string}`;
  provider: "interfaze" | "gateway";
  model: "interfaze-beta" | "openai/gpt-5.6-luna";
  role: "interfaze_extractor" | "luna_extractor";
  recordFile: string;
  recordSha256: `sha256:${string}`;
  recordBytes: number;
  hasFailure: boolean;
}>;

type ReplayManifest = Readonly<{
  schemaVersion: "diagnostics-extraction-offline-replay-manifest.v1";
  sourceArchive: string;
  datasetManifestDigest: `sha256:${string}`;
  entries: readonly ReplayManifestEntry[];
  fixtureDigest: `sha256:${string}`;
}>;

type RecordArtifact = Readonly<{ role: string; handle: VerificationArtifactHandle; bytesBase64: string }>;
type CheckpointRecord = Readonly<{
  schemaVersion:
    | "diagnostics-benchmark-live-call-checkpoint.v1"
    | "diagnostics-benchmark-live-failed-call-checkpoint.v1";
  caseId: string;
  caseDigest: `sha256:${string}`;
  provider: "interfaze" | "gateway";
  model: "interfaze-beta" | "openai/gpt-5.6-luna";
  role: "interfaze_extractor" | "luna_extractor";
  observation?: { output?: unknown; [key: string]: unknown };
  fieldLedger?: unknown;
  failureClass?: string;
  failureCode?: string;
  artifacts: readonly RecordArtifact[];
  [key: string]: unknown;
}>;

export type DiagnosticsExtractionReplayResult = Readonly<{
  fixtureDigest: `sha256:${string}`;
  datasetManifestDigest: `sha256:${string}`;
  replayed: readonly Readonly<{
    caseId: string;
    role: string;
    provider: string;
    fieldMechanics: boolean;
    extractedFieldCount: number;
  }>[];
  unavailable: readonly Readonly<{ caseId: string; role: string; reason: string }>[];
  missingCaseIds: readonly string[];
  missingArms: readonly Readonly<{ caseId: string; role: "interfaze_extractor" | "luna_extractor" }>[];
  externalRequests: 0;
}>;

function withoutFixtureDigest(manifest: ReplayManifest): Omit<ReplayManifest, "fixtureDigest"> {
  const { fixtureDigest: _ignored, ...material } = manifest;
  return material;
}

function parseManifest(value: unknown): ReplayManifest {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("DIAGNOSTICS_EXTRACTION_REPLAY_MANIFEST_INVALID");
  const item = value as Record<string, unknown>;
  if (
    item.schemaVersion !== "diagnostics-extraction-offline-replay-manifest.v1" ||
    typeof item.sourceArchive !== "string" ||
    !isDigest(item.datasetManifestDigest) ||
    !Array.isArray(item.entries) ||
    !isDigest(item.fixtureDigest)
  )
    throw new Error("DIAGNOSTICS_EXTRACTION_REPLAY_MANIFEST_INVALID");
  const entries = item.entries.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new Error("DIAGNOSTICS_EXTRACTION_REPLAY_ENTRY_INVALID");
    const candidate = entry as Record<string, unknown>;
    if (
      typeof candidate.caseId !== "string" ||
      !isDigest(candidate.caseDigest) ||
      !["interfaze", "gateway"].includes(String(candidate.provider)) ||
      !["interfaze-beta", "openai/gpt-5.6-luna"].includes(String(candidate.model)) ||
      !["interfaze_extractor", "luna_extractor"].includes(String(candidate.role)) ||
      typeof candidate.recordFile !== "string" ||
      candidate.recordFile.includes("\\") ||
      candidate.recordFile.startsWith("/") ||
      candidate.recordFile.includes("..") ||
      !isDigest(candidate.recordSha256) ||
      typeof candidate.recordBytes !== "number" ||
      !Number.isSafeInteger(candidate.recordBytes) ||
      candidate.recordBytes < 1 ||
      typeof candidate.hasFailure !== "boolean"
    )
      throw new Error("DIAGNOSTICS_EXTRACTION_REPLAY_ENTRY_INVALID");
    return Object.freeze(candidate as unknown as ReplayManifestEntry);
  });
  if (new Set(entries.map((entry) => entry.recordFile)).size !== entries.length)
    throw new Error("DIAGNOSTICS_EXTRACTION_REPLAY_DUPLICATE_RECORD");
  return Object.freeze({
    schemaVersion: item.schemaVersion,
    sourceArchive: item.sourceArchive,
    datasetManifestDigest: item.datasetManifestDigest,
    entries,
    fixtureDigest: item.fixtureDigest,
  });
}

function decodeArtifact(artifact: RecordArtifact): {
  readonly handle: VerificationArtifactHandle;
  readonly bytes: Uint8Array;
} {
  VerificationArtifactHandleSchema.parse(artifact.handle);
  if (typeof artifact.bytesBase64 !== "string") throw new Error("DIAGNOSTICS_EXTRACTION_REPLAY_ARTIFACT_ENCODING");
  const bytes = Buffer.from(artifact.bytesBase64, "base64");
  if (
    !artifact.handle ||
    typeof artifact.handle !== "object" ||
    !isDigest(artifact.handle.digest) ||
    artifact.handle.byteLength !== bytes.byteLength ||
    sha256Digest(bytes) !== artifact.handle.digest
  )
    throw new Error("DIAGNOSTICS_EXTRACTION_REPLAY_ARTIFACT_DIGEST_MISMATCH");
  return { handle: artifact.handle, bytes };
}

function readCanonicalJson(bytes: Uint8Array, code: string): unknown {
  const text = decoder.decode(bytes),
    value = JSON.parse(text);
  if (canonicalizeJson(value) !== text) throw new Error(code);
  return value;
}

function assertArtifactClosure(
  record: CheckpointRecord,
): Map<string, { readonly handle: VerificationArtifactHandle; readonly bytes: Uint8Array }> {
  const map = new Map<string, { readonly handle: VerificationArtifactHandle; readonly bytes: Uint8Array }>();
  const roles = new Set<string>();
  for (const artifact of record.artifacts) {
    if (roles.has(artifact.role)) throw new Error("DIAGNOSTICS_EXTRACTION_REPLAY_DUPLICATE_ARTIFACT_ROLE");
    roles.add(artifact.role);
    const loaded = decodeArtifact(artifact);
    if (map.has(loaded.handle.artifactId)) throw new Error("DIAGNOSTICS_EXTRACTION_REPLAY_DUPLICATE_ARTIFACT");
    map.set(loaded.handle.artifactId, loaded);
  }
  for (const loaded of map.values())
    for (const parent of loaded.handle.parentArtifactIds) {
      if (
        !map.has(parent) &&
        !["transmission_manifest", "provider_input", "granted_fragment"].includes(
          record.artifacts.find((item) => item.handle.artifactId === loaded.handle.artifactId)?.role ?? "",
        )
      )
        throw new Error("DIAGNOSTICS_EXTRACTION_REPLAY_PARENT_CLOSURE");
    }
  return map;
}

function assertExactParents(
  map: ReadonlyMap<string, { readonly handle: VerificationArtifactHandle; readonly bytes: Uint8Array }>,
  roleMap: ReadonlyMap<string, string>,
  role: string,
  parents: readonly string[],
) {
  const artifactId = [...roleMap.entries()].find(([, value]) => value === role)?.[0];
  if (
    !artifactId ||
    canonicalizeJson(map.get(artifactId)?.handle.parentArtifactIds ?? []) !== canonicalizeJson(parents)
  )
    throw new Error(`DIAGNOSTICS_EXTRACTION_REPLAY_${role.toUpperCase()}_LINEAGE`);
}

function assertCheckpointIdentity(
  record: CheckpointRecord,
  entry: ReplayManifestEntry,
  authority: { datasetManifestDigest: string; experimentManifestDigest: string },
  runIdentityDigest: string | undefined,
) {
  const schema =
    record.schemaVersion === "diagnostics-benchmark-live-call-checkpoint.v1"
      ? DiagnosticsBenchmarkLiveCallCheckpointSchema
      : DiagnosticsBenchmarkLiveFailedCallCheckpointSchema;
  const parsed = schema.safeParse(record);
  if (!parsed.success) throw new Error("DIAGNOSTICS_EXTRACTION_REPLAY_CHECKPOINT_SCHEMA");
  const { checkpointDigest: _ignored, ...material } = record;
  if (
    record.checkpointDigest !== verificationBenchmarkDigest(material) ||
    record.datasetManifestDigest !== authority.datasetManifestDigest ||
    record.experimentManifestDigest !== authority.experimentManifestDigest ||
    (runIdentityDigest !== undefined && record.runIdentityDigest !== runIdentityDigest)
  )
    throw new Error("DIAGNOSTICS_EXTRACTION_REPLAY_CHECKPOINT_IDENTITY");
  if (entry.hasFailure !== (record.schemaVersion === "diagnostics-benchmark-live-failed-call-checkpoint.v1"))
    throw new Error("DIAGNOSTICS_EXTRACTION_REPLAY_FAILURE_STATE");
}

function requiredArtifact(
  record: CheckpointRecord,
  map: ReadonlyMap<string, { readonly handle: VerificationArtifactHandle; readonly bytes: Uint8Array }>,
  role: string,
) {
  const declared = record.artifacts.find((artifact) => artifact.role === role);
  if (!declared) throw new Error(`DIAGNOSTICS_EXTRACTION_REPLAY_${role.toUpperCase()}_MISSING`);
  const loaded = map.get(declared.handle.artifactId);
  if (!loaded) throw new Error("DIAGNOSTICS_EXTRACTION_REPLAY_ARTIFACT_CLOSURE");
  return loaded;
}

export async function replayDiagnosticsExtractionFixture(input: {
  readonly directory: string;
  readonly catalogDirectory: string;
  readonly expectedFixtureDigest: `sha256:${string}`;
}): Promise<DiagnosticsExtractionReplayResult> {
  const root = await realpath(input.directory),
    manifestPath = resolve(root, "manifest.json");
  const manifestStat = await lstat(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || (await realpath(manifestPath)) !== manifestPath)
    throw new Error("DIAGNOSTICS_EXTRACTION_REPLAY_MANIFEST_PATH_INVALID");
  const manifest = parseManifest(JSON.parse(decoder.decode(await readFile(manifestPath))));
  if (
    manifest.fixtureDigest !== input.expectedFixtureDigest ||
    manifest.fixtureDigest !== digest(new TextEncoder().encode(canonicalizeJson(withoutFixtureDigest(manifest))))
  )
    throw new Error("DIAGNOSTICS_EXTRACTION_REPLAY_FIXTURE_SEAL_MISMATCH");
  const { dataset, authority } = await loadDiagnosticsExtractionExperiment(input.catalogDirectory);
  if (manifest.datasetManifestDigest !== authority.datasetManifestDigest)
    throw new Error("DIAGNOSTICS_EXTRACTION_REPLAY_DATASET_SEAL_MISMATCH");
  const caseMap = new Map(dataset.cases.map((testCase) => [testCase.caseId, testCase]));
  const replayed: Array<{
    caseId: string;
    role: string;
    provider: string;
    fieldMechanics: boolean;
    extractedFieldCount: number;
  }> = [];
  const unavailable: Array<{ caseId: string; role: string; reason: string }> = [];
  const seen = new Set<string>();
  let runIdentityDigest: string | undefined;
  for (const entry of manifest.entries) {
    const testCase = caseMap.get(entry.caseId);
    if (!testCase || testCase.caseDigest !== entry.caseDigest)
      throw new Error("DIAGNOSTICS_EXTRACTION_REPLAY_CASE_BINDING");
    const recordPath = resolve(root, entry.recordFile),
      rel = relative(root, recordPath);
    if (rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("DIAGNOSTICS_EXTRACTION_REPLAY_PATH_ESCAPE");
    const recordRealPath = await realpath(recordPath);
    const realRel = relative(root, recordRealPath);
    if (realRel === ".." || realRel.startsWith(`..${sep}`) || !(await lstat(recordRealPath)).isFile())
      throw new Error("DIAGNOSTICS_EXTRACTION_REPLAY_PATH_ESCAPE");
    const recordBytes = await readFile(recordRealPath);
    if (recordBytes.byteLength !== entry.recordBytes || digest(recordBytes) !== entry.recordSha256)
      throw new Error("DIAGNOSTICS_EXTRACTION_REPLAY_RECORD_DIGEST_MISMATCH");
    const record = JSON.parse(decoder.decode(recordBytes)) as CheckpointRecord;
    if (
      !(
        [
          "diagnostics-benchmark-live-call-checkpoint.v1",
          "diagnostics-benchmark-live-failed-call-checkpoint.v1",
        ] as string[]
      ).includes(record.schemaVersion) ||
      record.caseId !== entry.caseId ||
      record.caseDigest !== entry.caseDigest ||
      record.provider !== entry.provider ||
      record.model !== entry.model ||
      record.role !== entry.role
    )
      throw new Error("DIAGNOSTICS_EXTRACTION_REPLAY_RECORD_BINDING");
    assertCheckpointIdentity(record, entry, authority, runIdentityDigest);
    runIdentityDigest ??= String(record.runIdentityDigest);
    const key = `${record.role}:${record.caseId}`;
    if (seen.has(key)) throw new Error("DIAGNOSTICS_EXTRACTION_REPLAY_DUPLICATE_CASE_ARM");
    seen.add(key);
    if (entry.hasFailure) {
      unavailable.push({
        caseId: record.caseId,
        role: record.role,
        reason: record.failureCode ?? record.failureClass ?? "RECORDED_PROVIDER_FAILURE",
      });
      continue;
    }
    const artifacts = assertArtifactClosure(record),
      roleMap = new Map(record.artifacts.map((artifact) => [artifact.handle.artifactId, artifact.role] as const));
    const transmission = requiredArtifact(record, artifacts, "transmission_manifest");
    const providerInput = requiredArtifact(record, artifacts, "provider_input");
    const fragment = requiredArtifact(record, artifacts, "granted_fragment");
    const request = requiredArtifact(record, artifacts, "request");
    const rawResponse = requiredArtifact(record, artifacts, "raw_response");
    const envelope = requiredArtifact(record, artifacts, "response_envelope");
    const observation = requiredArtifact(record, artifacts, "observation");
    const fieldLedger = requiredArtifact(record, artifacts, "field_ledger");
    assertExactParents(artifacts, roleMap, "request", [
      transmission.handle.artifactId,
      providerInput.handle.artifactId,
      fragment.handle.artifactId,
    ]);
    assertExactParents(artifacts, roleMap, "response_envelope", [
      request.handle.artifactId,
      rawResponse.handle.artifactId,
    ]);
    assertExactParents(artifacts, roleMap, "observation", [
      request.handle.artifactId,
      rawResponse.handle.artifactId,
      envelope.handle.artifactId,
    ]);
    assertExactParents(artifacts, roleMap, "field_ledger", [fragment.handle.artifactId, observation.handle.artifactId]);
    if (
      fragment.handle.digest !== sha256Digest(fragment.bytes) ||
      decoder.decode(fragment.bytes) !== testCase.evidence[0]!.excerpt
    )
      throw new Error("DIAGNOSTICS_EXTRACTION_REPLAY_SOURCE_CUSTODY");
    const transmissionBody = readCanonicalJson(
      transmission.bytes,
      "DIAGNOSTICS_EXTRACTION_REPLAY_TRANSMISSION_ENCODING",
    ) as Record<string, unknown>;
    const evidence = testCase.evidence[0]!;
    const sourceBinding = record.sourceBinding as { inputManifestArtifact?: { artifactId?: string } };
    if (
      transmissionBody.caseId !== record.caseId ||
      transmissionBody.caseDigest !== record.caseDigest ||
      transmissionBody.role !== record.role ||
      transmissionBody.provider !== record.provider ||
      transmissionBody.model !== record.model ||
      transmissionBody.datasetManifestDigest !== authority.datasetManifestDigest ||
      transmissionBody.captureId !== evidence.captureId ||
      transmissionBody.selectedContentDigest !== evidence.selectedContentDigest ||
      sourceBinding.inputManifestArtifact?.artifactId !== testCase.inputManifestArtifactId
    )
      throw new Error("DIAGNOSTICS_EXTRACTION_REPLAY_SOURCE_BINDING");
    const providerInputBody = readCanonicalJson(
      providerInput.bytes,
      "DIAGNOSTICS_EXTRACTION_REPLAY_PROVIDER_INPUT_ENCODING",
    ) as Record<string, unknown>;
    if (
      providerInputBody.fragment !== evidence.excerpt ||
      !Array.isArray(providerInputBody.requestedFields) ||
      providerInputBody.requestedFields.length < 1 ||
      providerInputBody.requestedFields.some(
        (item) => !item || typeof item !== "object" || typeof (item as Record<string, unknown>).fieldKey !== "string",
      )
    )
      throw new Error("DIAGNOSTICS_EXTRACTION_REPLAY_PROVIDER_INPUT_BINDING");
    const requestBody = readCanonicalJson(request.bytes, "DIAGNOSTICS_EXTRACTION_REPLAY_REQUEST_ENCODING") as Record<
      string,
      unknown
    >;
    if (
      request.handle.digest !== record.observation?.requestDigest ||
      rawResponse.handle.digest !== record.observation?.rawResponseDigest ||
      envelope.handle.digest !== record.observation?.envelopeDigest ||
      requestBody.model !== record.model
    )
      throw new Error("DIAGNOSTICS_EXTRACTION_REPLAY_OBSERVATION_CHAIN");
    const observationBody = readCanonicalJson(
      observation.bytes,
      "DIAGNOSTICS_EXTRACTION_REPLAY_OBSERVATION_ENCODING",
    ) as { output?: unknown; caseId?: string; role?: string };
    if (
      observationBody.caseId !== record.caseId ||
      observationBody.role !== record.role ||
      !record.observation?.output ||
      canonicalizeJson(record.observation.output) !== canonicalizeJson(observationBody.output)
    )
      throw new Error("DIAGNOSTICS_EXTRACTION_REPLAY_OBSERVATION_BINDING");
    const fieldResult = verifyDiagnosticsExtractionOutput({
      testCase,
      authority,
      output: observationBody.output as never,
      fragmentArtifact: fragment.handle,
      fragmentBytes: fragment.bytes,
    });
    const fieldLedgerBody = readCanonicalJson(
      fieldLedger.bytes,
      "DIAGNOSTICS_EXTRACTION_REPLAY_FIELD_LEDGER_ENCODING",
    ) as {
      caseDigest?: string;
      role?: string;
      observationArtifactId?: string;
      fieldResult?: {
        fieldResults?: readonly {
          status?: string;
          evidenceBinding?: {
            captureId?: string;
            expectedSelectedContentDigest?: string;
            selector?: unknown;
            fragmentArtifact?: VerificationArtifactHandle;
          };
        }[];
      };
    };
    if (
      fieldLedgerBody.caseDigest !== record.caseDigest ||
      fieldLedgerBody.role !== record.role ||
      fieldLedgerBody.observationArtifactId !== observation.handle.artifactId ||
      canonicalizeJson(fieldLedgerBody.fieldResult) !== canonicalizeJson(fieldResult)
    )
      throw new Error("DIAGNOSTICS_EXTRACTION_REPLAY_FIELD_LEDGER_DRIFT");
    for (const item of fieldLedgerBody.fieldResult?.fieldResults ?? []) {
      const binding = item.evidenceBinding;
      if (!binding) continue;
      if (
        binding.captureId !== evidence.captureId ||
        binding.expectedSelectedContentDigest === undefined ||
        !isDigest(binding.expectedSelectedContentDigest) ||
        !binding.selector ||
        binding.fragmentArtifact?.artifactId !== fragment.handle.artifactId ||
        binding.fragmentArtifact.digest !== fragment.handle.digest ||
        binding.fragmentArtifact.byteLength !== fragment.handle.byteLength
      )
        throw new Error("DIAGNOSTICS_EXTRACTION_REPLAY_FIELD_SOURCE_BINDING");
    }
    replayed.push({
      caseId: record.caseId,
      role: record.role,
      provider: record.provider,
      fieldMechanics: fieldResult.fieldMechanics,
      extractedFieldCount: fieldResult.extractedFieldCount,
    });
  }
  const missingArms = dataset.cases.flatMap((item) =>
    (["interfaze_extractor", "luna_extractor"] as const)
      .filter((role) => !seen.has(`${role}:${item.caseId}`))
      .map((role) => ({ caseId: item.caseId, role })),
  );
  return Object.freeze({
    fixtureDigest: manifest.fixtureDigest,
    datasetManifestDigest: manifest.datasetManifestDigest,
    replayed: Object.freeze(replayed),
    unavailable: Object.freeze(unavailable),
    missingCaseIds: Object.freeze(
      dataset.cases
        .map((item) => item.caseId)
        .filter((caseId) => missingArms.some((missing) => missing.caseId === caseId)),
    ),
    missingArms: Object.freeze(missingArms),
    externalRequests: 0,
  });
}
