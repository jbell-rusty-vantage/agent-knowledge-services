import {
  VerificationArtifactHandleSchema,
  VerificationReportGateArtifactSchema,
  VerificationReportLedgerSchema,
  type DeterministicVerificationResult,
  type VerificationArtifactHandle,
} from "@aiengineer/knowledge-contracts";
import { canonicalizeJson, digestCanonicalJson, sha256Digest } from "../canonical/index.js";
import {
  verifyDeterministicBundle,
  type DeterministicVerificationOptions,
  type RuntimePrincipalBinding,
} from "../deterministic/index.js";
import { REPORT_RESULT_SCHEMA_VERSION } from "../versions.js";
import type { EvidenceSelectorResolver } from "../evidence-selection/index.js";
import { applyReportWideMechanicalGates, verifyReportWideFromLedger } from "../report/report-wide.js";
import { inspectAuditBundle } from "./seal.js";
import type {
  AuditBundleSignatureVerifier,
  TrustedArtifactResolver,
  VerificationAuditBundle,
  VerificationPolicyReplayPort,
  VerificationSemanticReplayPort,
  VerificationReplayResult,
} from "./model.js";
import { validateRecordedPolicyInputsArtifact } from "./policy-inputs.js";

async function hydrate(
  resolver: TrustedArtifactResolver,
  tenantId: string,
  expectedInput: unknown,
  purpose: "verification_replay" | "policy_replay",
): Promise<{ artifactId: string; bytes: Uint8Array }> {
  const expected = VerificationArtifactHandleSchema.parse(expectedInput);
  await resolver.authorizeArtifact({
    tenantId,
    artifactId: expected.artifactId,
    purpose,
  });
  const hydrated = await resolver.hydrateRegisteredArtifact({
    tenantId,
    artifactId: expected.artifactId,
  });
  const registered = VerificationArtifactHandleSchema.parse(hydrated.registration);
  if (registered.tenantId !== tenantId || digestCanonicalJson(registered) !== digestCanonicalJson(expected)) {
    throw new Error("ARTIFACT_REGISTRATION_MISMATCH");
  }
  if (hydrated.bytes.byteLength !== expected.byteLength) throw new Error("ARTIFACT_BYTE_LENGTH_MISMATCH");
  if (sha256Digest(hydrated.bytes) !== expected.digest) throw new Error("ARTIFACT_DIGEST_MISMATCH");
  return { artifactId: expected.artifactId, bytes: hydrated.bytes };
}

const decoder = new TextDecoder("utf-8", { fatal: true });

function decodeCanonical(bytes: Uint8Array, code: string): unknown {
  try {
    const raw = decoder.decode(bytes);
    const parsed = JSON.parse(raw) as unknown;
    if (canonicalizeJson(parsed) !== raw) throw new Error(code);
    return parsed;
  } catch (error) {
    if (error instanceof Error && error.message === code) throw error;
    throw new Error(code);
  }
}

async function replayReportGate(
  bundle: VerificationAuditBundle,
  resolver: TrustedArtifactResolver,
  baseResult: DeterministicVerificationResult,
): Promise<{
  deterministicResult: DeterministicVerificationResult;
  replayedArtifactIds: readonly string[];
}> {
  const isReport =
    bundle.verificationBundle.assertions.length > 0 &&
    bundle.verificationBundle.assertions.every((assertion) => assertion.kind === "report_assertion");
  const gateDigest = bundle.manifest.gateDigest;
  if (!gateDigest) {
    if (isReport) throw new Error("REPORT_REPLAY_GATE_REQUIRED");
    return { deterministicResult: baseResult, replayedArtifactIds: [] };
  }
  if (!isReport) throw new Error("REPORT_REPLAY_GATE_UNRECOGNIZED");

  const gateMatches = bundle.manifest.outputArtifacts.filter((artifact) => artifact.digest === gateDigest);
  const resultMatches = bundle.manifest.outputArtifacts.filter(
    (artifact) => artifact.digest === bundle.manifest.resultDigest,
  );
  if (gateMatches.length !== 1 || resultMatches.length !== 1) throw new Error("REPORT_REPLAY_GATE_BINDING_INVALID");
  const gate = gateMatches[0]!;
  const resultArtifact = resultMatches[0]!;
  if (
    gate.artifactId === resultArtifact.artifactId ||
    gate.mediaType !== "application/vnd.aiengineer.verification-report-result+json"
  ) {
    throw new Error("REPORT_REPLAY_GATE_BINDING_INVALID");
  }
  const parentIds = [...new Set(gate.parentArtifactIds)];
  if (parentIds.length !== 3 || !parentIds.includes(resultArtifact.artifactId))
    throw new Error("REPORT_REPLAY_GATE_BINDING_INVALID");
  const indexed = new Map<string, VerificationArtifactHandle>();
  for (const artifact of [...bundle.manifest.inputArtifacts, ...bundle.manifest.outputArtifacts]) {
    const prior = indexed.get(artifact.artifactId);
    if (prior && digestCanonicalJson(prior) !== digestCanonicalJson(artifact))
      throw new Error("REPORT_REPLAY_ARTIFACT_IDENTITY_CONFLICT");
    indexed.set(artifact.artifactId, artifact);
  }
  const retainedInputs = parentIds
    .filter((artifactId) => artifactId !== resultArtifact.artifactId)
    .map((artifactId) => indexed.get(artifactId));
  if (
    retainedInputs.length !== 2 ||
    retainedInputs.some(
      (artifact) =>
        !artifact ||
        !bundle.manifest.inputArtifacts.some((input) => digestCanonicalJson(input) === digestCanonicalJson(artifact)),
    )
  ) {
    throw new Error("REPORT_REPLAY_GATE_BINDING_INVALID");
  }

  const gateHydrated = await hydrate(resolver, bundle.tenantId, gate, "verification_replay");
  const hydratedInputs = [];
  for (const artifact of retainedInputs as VerificationArtifactHandle[]) {
    hydratedInputs.push({
      artifact,
      hydrated: await hydrate(resolver, bundle.tenantId, artifact, "verification_replay"),
    });
  }
  const ledgerCandidates = hydratedInputs.flatMap((item) => {
    try {
      const parsed = VerificationReportLedgerSchema.safeParse(
        decodeCanonical(item.hydrated.bytes, "REPORT_REPLAY_LEDGER_INVALID"),
      );
      return parsed.success ? [{ ...item, ledger: parsed.data }] : [];
    } catch {
      return [];
    }
  });
  if (ledgerCandidates.length !== 1) throw new Error("REPORT_REPLAY_LEDGER_INVALID");
  const ledgerCandidate = ledgerCandidates[0]!;
  const reportCandidate = hydratedInputs.find(
    (item) => item.artifact.artifactId !== ledgerCandidate.artifact.artifactId,
  );
  if (
    !reportCandidate ||
    digestCanonicalJson(ledgerCandidate.ledger.reportArtifact) !== digestCanonicalJson(reportCandidate.artifact) ||
    digestCanonicalJson(ledgerCandidate.ledger.bundle) !== digestCanonicalJson(bundle.verificationBundle)
  ) {
    throw new Error("REPORT_REPLAY_LEDGER_BINDING_MISMATCH");
  }
  let reportText: string;
  try {
    reportText = decoder.decode(reportCandidate.hydrated.bytes);
  } catch {
    throw new Error("REPORT_REPLAY_REPORT_INVALID");
  }
  const reportWide = verifyReportWideFromLedger(reportText, ledgerCandidate.ledger, baseResult);
  const deterministicResult = applyReportWideMechanicalGates(baseResult, reportWide);
  const expectedGate = VerificationReportGateArtifactSchema.parse({
    schemaVersion: REPORT_RESULT_SCHEMA_VERSION,
    coverageScope: "producer_declared_assertions_only",
    deterministicResultDigest: digestCanonicalJson(deterministicResult),
    reportWide,
  });
  const storedGate = VerificationReportGateArtifactSchema.parse(
    decodeCanonical(gateHydrated.bytes, "REPORT_REPLAY_GATE_INVALID"),
  );
  if (
    digestCanonicalJson(storedGate) !== digestCanonicalJson(expectedGate) ||
    storedGate.deterministicResultDigest !== resultArtifact.digest
  ) {
    throw new Error("REPORT_REPLAY_GATE_DRIFT");
  }
  return {
    deterministicResult,
    replayedArtifactIds: [gate.artifactId, ...hydratedInputs.map((item) => item.artifact.artifactId)],
  };
}

export async function replayAuditBundle(
  bundle: VerificationAuditBundle,
  options: {
    readonly artifactResolver: TrustedArtifactResolver;
    readonly runtimePrincipals: RuntimePrincipalBinding;
    readonly policyReplay: VerificationPolicyReplayPort;
    readonly semanticReplay?: VerificationSemanticReplayPort;
    readonly selectorResolvers?: readonly EvidenceSelectorResolver[];
    readonly isProjectionLineageAdmitted?: DeterministicVerificationOptions["isProjectionLineageAdmitted"];
    readonly signatureVerifier?: AuditBundleSignatureVerifier;
  },
): Promise<VerificationReplayResult> {
  const inspection = await inspectAuditBundle(bundle, options.signatureVerifier);
  if (!inspection.valid) throw new Error(`AUDIT_BUNDLE_INVALID:${inspection.errors.join(",")}`);
  const required = new Map<string, unknown>();
  for (const capture of bundle.verificationBundle.captures) {
    required.set(capture.contentArtifact.artifactId, capture.contentArtifact);
    if (capture.canonicalProjectionArtifact)
      required.set(capture.canonicalProjectionArtifact.artifactId, capture.canonicalProjectionArtifact);
  }
  const artifactBytes = new Map<string, Uint8Array>();
  for (const expected of required.values()) {
    const item = await hydrate(options.artifactResolver, bundle.tenantId, expected, "verification_replay");
    artifactBytes.set(item.artifactId, item.bytes);
  }
  const policy = await hydrate(
    options.artifactResolver,
    bundle.tenantId,
    bundle.policyBinding.policyArtifact,
    "policy_replay",
  );
  const recordedPolicyInputs = await hydrate(
    options.artifactResolver,
    bundle.tenantId,
    bundle.policyBinding.recordedPolicyInputsArtifact,
    "policy_replay",
  );
  const baseDeterministicResult = verifyDeterministicBundle(
    {
      bundle: bundle.verificationBundle,
      artifacts: [...artifactBytes].map(([artifactId, content]) => ({
        artifactId,
        content,
      })),
      runtimePrincipals: options.runtimePrincipals,
    },
    {
      ...(options.selectorResolvers ? { selectorResolvers: options.selectorResolvers } : {}),
      ...(options.isProjectionLineageAdmitted
        ? { isProjectionLineageAdmitted: options.isProjectionLineageAdmitted }
        : {}),
    },
  );
  const reportReplay = await replayReportGate(bundle, options.artifactResolver, baseDeterministicResult);
  const deterministicResult = reportReplay.deterministicResult;
  const deterministicResultDigest = digestCanonicalJson(deterministicResult);
  if (
    deterministicResultDigest !== bundle.deterministicResultDigest ||
    deterministicResultDigest !== digestCanonicalJson(bundle.manifest.deterministicResult)
  ) {
    throw new Error("DETERMINISTIC_REPLAY_DRIFT");
  }
  const parsedPolicyInputs = validateRecordedPolicyInputsArtifact({
    handle: bundle.policyBinding.recordedPolicyInputsArtifact,
    bytes: recordedPolicyInputs.bytes,
    bundle: bundle.verificationBundle,
    deterministicResult,
    runId: bundle.manifest.runId,
    policyVersion: bundle.policyBinding.policyVersion,
  });
  const judged = parsedPolicyInputs.assertions.filter(
    (item) =>
      item.semantic.judgeIdentities.length > 0 ||
      !["pending_semantic_review", "unverifiable"].includes(item.semantic.verdict),
  );
  let semanticArtifactIds: readonly string[] = [];
  if (judged.length > 0) {
    if (!options.semanticReplay) throw new Error("SEMANTIC_AUDIT_REPLAY_REQUIRED");
    const expectedAssessments = judged
      .map((item) => structuredClone(item.semantic))
      .sort((a, b) => a.assertionId.localeCompare(b.assertionId));
    const reconstructed = await options.semanticReplay.replay({
      auditBundle: structuredClone(bundle),
      deterministicResult: structuredClone(deterministicResult),
      recordedPolicyInputs: structuredClone(parsedPolicyInputs),
      verifiedRepresentationBytes: new Map([...artifactBytes].map(([id, bytes]) => [id, bytes.slice()])),
    });
    const actualAssessments = [...reconstructed.assessments].sort((a, b) => a.assertionId.localeCompare(b.assertionId));
    if (canonicalizeJson(actualAssessments) !== canonicalizeJson(expectedAssessments))
      throw new Error("SEMANTIC_AUDIT_REPLAY_DRIFT");
    const indexed = new Set(
      [...bundle.manifest.inputArtifacts, ...bundle.manifest.outputArtifacts].map((item) => item.artifactId),
    );
    if (
      !reconstructed.replayedArtifactIds.length ||
      reconstructed.replayedArtifactIds.some((id) => !indexed.has(id)) ||
      new Set(reconstructed.replayedArtifactIds).size !== reconstructed.replayedArtifactIds.length
    )
      throw new Error("SEMANTIC_AUDIT_REPLAY_ARTIFACT_BINDING");
    semanticArtifactIds = [...reconstructed.replayedArtifactIds];
  }
  const policyResult = await options.policyReplay.replay({
    tenantId: bundle.tenantId,
    policyVersion: bundle.policyBinding.policyVersion,
    policyArtifact: bundle.policyBinding.policyArtifact,
    policyBytes: policy.bytes,
    recordedPolicyInputsArtifact: bundle.policyBinding.recordedPolicyInputsArtifact,
    recordedPolicyInputsBytes: recordedPolicyInputs.bytes,
    recordedPolicyInputs: parsedPolicyInputs,
    verificationBundle: bundle.verificationBundle,
    deterministicResult,
  });
  const policyDecisionDigest = digestCanonicalJson(policyResult.decision);
  if (policyResult.outcome !== bundle.manifest.policyOutcome || policyDecisionDigest !== bundle.policyDecisionDigest) {
    throw new Error("POLICY_REPLAY_DRIFT");
  }
  return {
    inspection,
    deterministicResult,
    deterministicResultDigest,
    policyOutcome: policyResult.outcome,
    policyDecisionDigest,
    replayedArtifactIds: [
      ...new Set([
        ...artifactBytes.keys(),
        ...reportReplay.replayedArtifactIds,
        ...semanticArtifactIds,
        policy.artifactId,
        recordedPolicyInputs.artifactId,
      ]),
    ].sort(),
  };
}
