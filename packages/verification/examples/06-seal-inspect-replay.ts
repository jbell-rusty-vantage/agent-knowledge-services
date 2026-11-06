import { generateKeyPairSync } from "node:crypto";
import {
  createEd25519Signer,
  createEd25519Verifier,
  inspectAuditBundle,
  replayAuditBundle,
  sealAuditBundle,
  type TrustedArtifactResolver,
  type VerificationArtifactHandle,
  type VerificationPolicyReplayPort,
} from "../src/index.js";
import { auditBundleFixture, policyBytes } from "../src/provenance/audit-bundle.fixture.js";
import { CONTENT, passingInput } from "./bundle-fixture.js";

/**
 * Stage 5 — provenance. A run is sealed into an audit bundle (RFC 8785 payload
 * digest plus a detached Ed25519 signature), inspected offline, then replayed:
 * every artifact is re-authorized and re-hydrated from trusted custody, the
 * deterministic engine is re-run, and the recorded policy inputs are handed to
 * the policy replay port. Nothing in the bundle is trusted without recompute.
 */
function inMemoryKeys() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

function inMemoryResolver(entries: readonly (readonly [VerificationArtifactHandle, Uint8Array])[]) {
  const calls: string[] = [];
  const byId = new Map(entries.map(([handle, bytes]) => [handle.artifactId, { handle, bytes }]));
  const resolver: TrustedArtifactResolver = {
    async authorizeArtifact(input) {
      calls.push(`authorize:${input.artifactId}`);
    },
    async hydrateRegisteredArtifact(input) {
      calls.push(`hydrate:${input.artifactId}`);
      const entry = byId.get(input.artifactId);
      if (!entry) throw new Error(`UNKNOWN_ARTIFACT:${input.artifactId}`);
      return { registration: entry.handle, bytes: entry.bytes };
    },
  };
  return { resolver, calls };
}

export async function sealInspectReplayExample() {
  const run = auditBundleFixture({ deterministicInput: passingInput() });
  const keys = inMemoryKeys();
  const keyId = "example-key";

  const audit = await sealAuditBundle({
    tenantId: run.sourceHandle.tenantId,
    verificationBundle: run.deterministicInput.bundle,
    manifest: run.manifest,
    policyBinding: {
      policyVersion: run.deterministicInput.bundle.policyVersion,
      policyArtifact: run.policyArtifact,
      recordedPolicyInputsArtifact: run.recordedPolicyInputsArtifact,
    },
    recordedPolicyInputsBytes: run.recordedPolicyInputsBytes,
    policyDecision: run.policyDecision,
    signer: createEd25519Signer(keys.privatePem, keyId),
  });

  const verifier = createEd25519Verifier({ [keyId]: keys.publicPem });
  const inspection = await inspectAuditBundle(audit, verifier);

  const custody = inMemoryResolver([
    [run.sourceHandle, new TextEncoder().encode(CONTENT)],
    [run.policyArtifact, policyBytes],
    [run.recordedPolicyInputsArtifact, run.recordedPolicyInputsBytes],
  ]);
  let policyReplays = 0;
  const policyReplay: VerificationPolicyReplayPort = {
    async replay() {
      policyReplays += 1;
      return { outcome: "pass", decision: run.policyDecision };
    },
  };
  const replay = await replayAuditBundle(audit, {
    runtimePrincipals: run.deterministicInput.runtimePrincipals,
    artifactResolver: custody.resolver,
    policyReplay,
    signatureVerifier: verifier,
  });

  return {
    seal: {
      payloadDigest: audit.seal.payloadDigest,
      signatureAlgorithm: audit.seal.signatureAlgorithm,
      keyId: audit.seal.keyId,
    },
    inspection: {
      valid: inspection.valid,
      signatureStatus: inspection.signatureStatus,
      errors: inspection.errors,
    },
    replay: {
      deterministicResultDigest: replay.deterministicResultDigest,
      matchesSealedDigest: replay.deterministicResultDigest === audit.deterministicResultDigest,
      policyOutcome: replay.policyOutcome,
      replayedArtifactIds: replay.replayedArtifactIds,
      policyReplays,
      custodyCalls: custody.calls,
    },
  };
}
