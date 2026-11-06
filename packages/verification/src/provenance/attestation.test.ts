import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { VerificationArtifactHandle, VerificationRunManifest } from "@aiengineer/knowledge-contracts";
import { canonicalizeJson, digestCanonicalJson, sha256Digest } from "../canonical/index.js";
import { verifyDeterministicBundle } from "../deterministic/index.js";
import { prototypeClaimInput } from "../deterministic/engine-golden.fixture.js";
import { createEd25519Signer, createEd25519Verifier, sealAuditBundle, verificationManifestDigest } from "./seal.js";
import {
  createVerificationDsseSlsaAttestation,
  inspectVerificationDsseSlsaAttestation,
  VERIFICATION_DSSE_PAYLOAD_TYPE,
  verificationDssePae,
  type VerificationDsseEnvelope,
} from "./attestation.js";
import type { VerificationAuditBundle } from "./model.js";

const createdAt = "2026-09-05T02:00:00.000Z";
const policyBytes = new TextEncoder().encode(
  '{"policy":"pass mechanically valid fixtures","version":"verification-policy-0.1.0"}',
);

function fixture(): {
  audit: VerificationAuditBundle;
  privatePem: string;
  publicPem: string;
} {
  const deterministicInput = prototypeClaimInput();
  const deterministicResult = verifyDeterministicBundle(deterministicInput);
  const sourceHandle = deterministicInput.bundle.captures[0]!.contentArtifact;
  const policyDigest = sha256Digest(policyBytes);
  const policyArtifact: VerificationArtifactHandle = {
    artifactId: "44444444-4444-4444-8444-444444444444",
    tenantId: sourceHandle.tenantId,
    digest: policyDigest,
    mediaType: "application/json",
    byteLength: policyBytes.byteLength,
    objectKey: `${sourceHandle.tenantId}/${policyDigest.slice(7, 9)}/${policyDigest.slice(7)}`,
    createdAt,
    producerActivityId: "policy-publisher",
    producerVersion: "1",
    encryptionClass: "managed",
    retentionClass: "audit",
    dataClassification: "internal",
    parentArtifactIds: [],
  };
  const recordedPolicyInputsBytes = new TextEncoder().encode(
    JSON.stringify({
      schemaVersion: "verification-policy-inputs.v1",
      policyVersion: deterministicInput.bundle.policyVersion,
      runId: "run-1",
      recordedAt: createdAt,
      deterministicResult,
      assertions: [
        {
          assertionId: "claim-1",
          riskClass: "medium",
          downstreamUse: ["semantic_verification"],
          claimScope: "source_summary",
          semantic: {
            assertionId: "claim-1",
            verdict: "pending_semantic_review",
            disposition: "review",
            evidenceSupport: "not_assessed",
            worldCorrectness: "not_assessed",
            attributionFaithfulness: "not_assessed",
            sourceAuthority: "not_assessed",
            provenanceIntegrity: "satisfied",
            judgeIdentities: [],
            supportingFragmentIds: ["fragment-evidence-1"],
            contradictingFragmentIds: [],
            unsupportedFacets: [],
            reasonCodes: [],
            crossFamilySecondJudge: false,
            rawProviderConfidences: [],
          },
          authorityStatus: "unknown",
          independentCorroboration: false,
          conflictPresent: false,
          criticalFactsKnown: true,
        },
      ],
      metrics: [],
      sourceAssessments: [],
    }),
  );
  const inputsDigest = sha256Digest(recordedPolicyInputsBytes);
  const inputsArtifact: VerificationArtifactHandle = {
    ...policyArtifact,
    artifactId: "55555555-5555-4555-8555-555555555555",
    digest: inputsDigest,
    byteLength: recordedPolicyInputsBytes.byteLength,
    objectKey: `${sourceHandle.tenantId}/${inputsDigest.slice(7, 9)}/${inputsDigest.slice(7)}`,
    producerActivityId: "policy-input-recorder",
  };
  const manifest: VerificationRunManifest = {
    verificationContractVersion: "verification.v1",
    manifestId: "manifest-1",
    runId: "run-1",
    versions: {
      policy: deterministicInput.bundle.policyVersion,
      schema: "verification.v1",
      normalizer: "text.v1",
    },
    code: { gitSha: "fixture-sha", dirty: false },
    runtime: {
      platform: "test",
      deploymentId: deterministicInput.bundle.verifier.deploymentId,
    },
    provider: {
      endpointIdentity: "fixture-provider",
      model: "fixture-model",
      nativeConfiguration: {
        tokenUsage: 34,
        inputTokens: 21,
        outputTokens: 13,
      },
      pricingSnapshotArtifactId: policyArtifact.artifactId,
    },
    inputArtifacts: [sourceHandle, policyArtifact, inputsArtifact],
    outputArtifacts: [],
    stages: [
      {
        name: "deterministic",
        status: "succeeded",
        startedAt: createdAt,
        endedAt: createdAt,
      },
    ],
    calls: [],
    toolPolicy: [],
    networkPolicy: "disabled",
    deterministicResult,
    judgments: [],
    policyOutcome: "pass",
    resultDigest: digestCanonicalJson(deterministicResult),
    lineage: [],
    canonicalization: {
      algorithm: "RFC8785",
      implementationVersion: "knowledge-verification.v1",
      manifestDigest: sha256Digest(""),
    },
    startedAt: createdAt,
    completedAt: createdAt,
  };
  manifest.canonicalization.manifestDigest = verificationManifestDigest(manifest);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const signer = createEd25519Signer(privatePem, "audit-key");
  const pending = sealAuditBundle({
    tenantId: sourceHandle.tenantId,
    verificationBundle: deterministicInput.bundle,
    manifest,
    policyBinding: {
      policyVersion: deterministicInput.bundle.policyVersion,
      policyArtifact,
      recordedPolicyInputsArtifact: inputsArtifact,
    },
    recordedPolicyInputsBytes,
    policyDecision: { outcome: "pass" },
    signer,
  });
  return {
    audit: pending as unknown as VerificationAuditBundle,
    privatePem,
    publicPem,
  };
}

async function signedEnvelope(
  signer: { sign(payload: Uint8Array): Promise<string>; keyId: string },
  statement: unknown,
): Promise<VerificationDsseEnvelope> {
  const payload = new TextEncoder().encode(canonicalizeJson(statement));
  return {
    payloadType: VERIFICATION_DSSE_PAYLOAD_TYPE,
    payload: Buffer.from(payload).toString("base64"),
    signatures: [
      {
        keyid: signer.keyId,
        sig: await signer.sign(verificationDssePae(VERIFICATION_DSSE_PAYLOAD_TYPE, payload)),
      },
    ],
  };
}

async function signedFixture() {
  const raw = fixture();
  const audit = (await raw.audit) as unknown as VerificationAuditBundle;
  const auditVerifier = createEd25519Verifier({ "audit-key": raw.publicPem });
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const attestationPrivatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const attestationPublicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const signer = createEd25519Signer(attestationPrivatePem, "attestation-key");
  const builderId = `urn:aiengineer:verification:deployment:${encodeURIComponent(audit.manifest.runtime.deploymentId)}`;
  return {
    audit,
    auditVerifier,
    signer,
    attestationVerifier: createEd25519Verifier({
      "attestation-key": attestationPublicPem,
    }),
    binding: { builderId, keyId: "attestation-key" },
  };
}

describe("optional DSSE/SLSA audit-bundle attestation", () => {
  it("does not expose verifier diagnostics in public inspection failures", async () => {
    const value = await signedFixture();
    const created = await createVerificationDsseSlsaAttestation({
      auditBundle: value.audit,
      auditBundleVerifier: value.auditVerifier,
      signer: value.signer,
      trustedBinding: value.binding,
    });
    const result = await inspectVerificationDsseSlsaAttestation({
      auditBundle: value.audit,
      auditBundleVerifier: value.auditVerifier,
      envelope: created.envelope,
      expectedBinding: value.binding,
      attestationVerifier: {
        async verify() {
          throw new Error("private-key-canary-do-not-publish");
        },
      },
    });
    expect(result).toEqual({
      verified: false,
      reason: "DSSE_INSPECTION_INVALID",
    });
  });
  it("creates and verifies a DSSE PAE signed standard statement from a signed audit bundle", async () => {
    const value = await signedFixture();
    const created = await createVerificationDsseSlsaAttestation({
      auditBundle: value.audit,
      auditBundleVerifier: value.auditVerifier,
      signer: value.signer,
      trustedBinding: value.binding,
    });
    expect(created.envelope.payloadType).toBe(VERIFICATION_DSSE_PAYLOAD_TYPE);
    expect(created.statement.subject[0]!.digest.sha256).toBe(value.audit.seal.payloadDigest.slice(7));
    expect(created.statement.predicate.buildDefinition.resolvedDependencies).toHaveLength(
      value.audit.manifest.inputArtifacts.length,
    );
    expect(
      await value.attestationVerifier.verify({
        keyId: "attestation-key",
        payload: verificationDssePae(created.envelope.payloadType, Buffer.from(created.envelope.payload, "base64")),
        signatureBase64: created.envelope.signatures[0]!.sig,
      }),
    ).toBe(true);
    await expect(
      inspectVerificationDsseSlsaAttestation({
        auditBundle: value.audit,
        auditBundleVerifier: value.auditVerifier,
        envelope: created.envelope,
        attestationVerifier: value.attestationVerifier,
        expectedBinding: value.binding,
      }),
    ).resolves.toMatchObject({
      verified: true,
      subjectDigest: value.audit.seal.payloadDigest,
      builderId: value.binding.builderId,
    });
  });

  it("accepts URL-safe base64 but rejects PAE, payload-type, subject, dependency, and private-field tampering", async () => {
    const value = await signedFixture();
    const created = await createVerificationDsseSlsaAttestation({
      auditBundle: value.audit,
      auditBundleVerifier: value.auditVerifier,
      signer: value.signer,
      trustedBinding: value.binding,
    });
    const urlSafe: VerificationDsseEnvelope = {
      ...created.envelope,
      payload: Buffer.from(created.envelope.payload, "base64").toString("base64url"),
    };
    await expect(
      inspectVerificationDsseSlsaAttestation({
        auditBundle: value.audit,
        auditBundleVerifier: value.auditVerifier,
        envelope: urlSafe,
        attestationVerifier: value.attestationVerifier,
        expectedBinding: value.binding,
      }),
    ).resolves.toMatchObject({ verified: true });
    const altered = structuredClone(created.envelope) as unknown as {
      payloadType: string;
      payload: string;
      signatures: { keyid: string; sig: string }[];
    };
    altered.payloadType = "application/json";
    await expect(
      inspectVerificationDsseSlsaAttestation({
        auditBundle: value.audit,
        auditBundleVerifier: value.auditVerifier,
        envelope: altered,
        attestationVerifier: value.attestationVerifier,
        expectedBinding: value.binding,
      }),
    ).resolves.toMatchObject({ verified: false });
    const oversizedObject = { ...created.envelope, extra: "x".repeat(70_000) };
    await expect(
      inspectVerificationDsseSlsaAttestation({
        auditBundle: value.audit,
        auditBundleVerifier: value.auditVerifier,
        envelope: oversizedObject,
        attestationVerifier: value.attestationVerifier,
        expectedBinding: value.binding,
      }),
    ).resolves.toMatchObject({
      verified: false,
      reason: "DSSE_ENVELOPE_SIZE_INVALID",
    });
    const statement = JSON.parse(Buffer.from(created.envelope.payload, "base64").toString("utf8"));
    statement.subject[0].digest.sha256 = "0".repeat(64);
    const tamperedPayload = Buffer.from(JSON.stringify(statement)).toString("base64");
    const tampered = { ...created.envelope, payload: tamperedPayload };
    await expect(
      inspectVerificationDsseSlsaAttestation({
        auditBundle: value.audit,
        auditBundleVerifier: value.auditVerifier,
        envelope: tampered,
        attestationVerifier: value.attestationVerifier,
        expectedBinding: value.binding,
      }),
    ).resolves.toMatchObject({ verified: false });
    statement.subject[0].digest.sha256 = value.audit.seal.payloadDigest.slice(7);
    statement.predicate.buildDefinition.resolvedDependencies[0].digest.sha256 = "1".repeat(64);
    const dependencyTamper = {
      ...created.envelope,
      payload: Buffer.from(JSON.stringify(statement)).toString("base64"),
    };
    await expect(
      inspectVerificationDsseSlsaAttestation({
        auditBundle: value.audit,
        auditBundleVerifier: value.auditVerifier,
        envelope: dependencyTamper,
        attestationVerifier: value.attestationVerifier,
        expectedBinding: value.binding,
      }),
    ).resolves.toMatchObject({ verified: false });
    statement.predicate.buildDefinition.resolvedDependencies = [];
    statement.privateReasoning = "nope";
    const privateTamper = await signedEnvelope(value.signer, statement);
    await expect(
      inspectVerificationDsseSlsaAttestation({
        auditBundle: value.audit,
        auditBundleVerifier: value.auditVerifier,
        envelope: privateTamper,
        attestationVerifier: value.attestationVerifier,
        expectedBinding: value.binding,
      }),
    ).resolves.toMatchObject({
      verified: false,
      reason: "DSSE_STATEMENT_FIELDS_INVALID",
    });
    const predicateTamperStatement = structuredClone(created.statement) as {
      predicateType: string;
    };
    predicateTamperStatement.predicateType = "https://slsa.dev/provenance/v0.2";
    await expect(
      inspectVerificationDsseSlsaAttestation({
        auditBundle: value.audit,
        auditBundleVerifier: value.auditVerifier,
        envelope: await signedEnvelope(value.signer, predicateTamperStatement),
        attestationVerifier: value.attestationVerifier,
        expectedBinding: value.binding,
      }),
    ).resolves.toMatchObject({
      verified: false,
      reason: "DSSE_STATEMENT_BINDING_MISMATCH",
    });
    const builderTamperStatement = structuredClone(created.statement) as {
      predicate: { runDetails: { builder: { id: string } } };
    };
    builderTamperStatement.predicate.runDetails.builder.id = "urn:aiengineer:verification:deployment:forged";
    await expect(
      inspectVerificationDsseSlsaAttestation({
        auditBundle: value.audit,
        auditBundleVerifier: value.auditVerifier,
        envelope: await signedEnvelope(value.signer, builderTamperStatement),
        attestationVerifier: value.attestationVerifier,
        expectedBinding: value.binding,
      }),
    ).resolves.toMatchObject({
      verified: false,
      reason: "DSSE_STATEMENT_BINDING_MISMATCH",
    });
    const signatureTamper = structuredClone(created.envelope) as unknown as {
      payloadType: string;
      payload: string;
      signatures: [{ keyid: string; sig: string }];
    };
    signatureTamper.signatures[0].sig = Buffer.alloc(64, 1).toString("base64");
    await expect(
      inspectVerificationDsseSlsaAttestation({
        auditBundle: value.audit,
        auditBundleVerifier: value.auditVerifier,
        envelope: signatureTamper,
        attestationVerifier: value.attestationVerifier,
        expectedBinding: value.binding,
      }),
    ).resolves.toMatchObject({
      verified: false,
      reason: "DSSE_SIGNATURE_INVALID",
    });
  });

  it("rejects unsigned/changed audit bundles and an untrusted signer-builder binding", async () => {
    const value = await signedFixture();
    const created = await createVerificationDsseSlsaAttestation({
      auditBundle: value.audit,
      auditBundleVerifier: value.auditVerifier,
      signer: value.signer,
      trustedBinding: value.binding,
    });
    await expect(
      createVerificationDsseSlsaAttestation({
        auditBundle: {
          ...value.audit,
          seal: { payloadDigest: value.audit.seal.payloadDigest },
        },
        auditBundleVerifier: value.auditVerifier,
        signer: value.signer,
        trustedBinding: value.binding,
      }),
    ).rejects.toThrow("DSSE_AUDIT_BUNDLE_SIGNATURE_REQUIRED");
    await expect(
      inspectVerificationDsseSlsaAttestation({
        auditBundle: value.audit,
        auditBundleVerifier: value.auditVerifier,
        envelope: created.envelope,
        attestationVerifier: value.attestationVerifier,
        expectedBinding: { ...value.binding, keyId: "other-key" },
      }),
    ).resolves.toMatchObject({
      verified: false,
      reason: "DSSE_TRUSTED_BINDING_MISMATCH",
    });
    const changedBundle = structuredClone(value.audit);
    changedBundle.manifest.runtime.deploymentId = "other";
    await expect(
      inspectVerificationDsseSlsaAttestation({
        auditBundle: changedBundle,
        auditBundleVerifier: value.auditVerifier,
        envelope: created.envelope,
        attestationVerifier: value.attestationVerifier,
        expectedBinding: value.binding,
      }),
    ).resolves.toMatchObject({
      verified: false,
      reason: "DSSE_AUDIT_BUNDLE_SIGNATURE_REQUIRED",
    });
  });
});
