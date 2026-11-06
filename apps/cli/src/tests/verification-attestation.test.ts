import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { generateKeyPairSync } from "node:crypto";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createEd25519Signer,
  digestCanonicalJson,
  sealAuditBundle,
  sha256Digest,
  verificationManifestDigest,
  verifyDeterministicBundle,
  type VerificationArtifactHandle,
  type VerificationRunManifest,
} from "@aiengineer/knowledge-verification";
import { prototypeClaimInput } from "../../../../packages/verification/src/deterministic/engine-golden.fixture.js";
import {
  VERIFICATION_ATTESTATION_SIGNING_KEY_ENV,
  VerificationAttestationCliError,
  runVerificationAttestationExport,
  runVerificationAttestationInspect,
} from "../verification-attestation.js";

const createdAt = "2026-09-08T00:00:00.000Z";
const policyBytes = new TextEncoder().encode('{"policy":"fixture"}');
const runBuiltCli = (args: readonly string[], environment: NodeJS.ProcessEnv = {}) =>
  new Promise<{
    readonly code: number | null;
    readonly stdout: string;
    readonly stderr: string;
  }>((resolve, reject) => {
    execFile(
      process.execPath,
      [join(import.meta.dirname, "../../dist/index.js"), "verify", ...args],
      { env: environment },
      (error, stdout, stderr) => {
        if (error && (error as NodeJS.ErrnoException).code !== undefined && (error as { code?: unknown }).code !== 1)
          return reject(error);
        resolve({
          code: (error as { code?: number } | null)?.code ?? 0,
          stdout,
          stderr,
        });
      },
    );
  });

async function signedAudit(privatePem: string) {
  const deterministicInput = prototypeClaimInput();
  const deterministicResult = verifyDeterministicBundle(deterministicInput);
  const source = deterministicInput.bundle.captures[0]!.contentArtifact;
  const policyArtifact: VerificationArtifactHandle = {
    artifactId: "44444444-4444-4444-8444-444444444444",
    tenantId: source.tenantId,
    digest: sha256Digest(policyBytes),
    mediaType: "application/json",
    byteLength: policyBytes.byteLength,
    objectKey: "fixture/policy",
    createdAt,
    producerActivityId: "fixture",
    producerVersion: "1",
    encryptionClass: "managed",
    retentionClass: "audit",
    dataClassification: "internal",
    parentArtifactIds: [],
  };
  const recordedBytes = new TextEncoder().encode(
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
            sourceAuthority: "unknown",
            provenanceIntegrity: "satisfied",
            judgeIdentities: [],
            supportingFragmentIds: [],
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
  const recordedArtifact: VerificationArtifactHandle = {
    ...policyArtifact,
    artifactId: "55555555-5555-4555-8555-555555555555",
    digest: sha256Digest(recordedBytes),
    byteLength: recordedBytes.byteLength,
    objectKey: "fixture/recorded",
    producerActivityId: "recorder",
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
    code: { gitSha: "fixture", dirty: false },
    runtime: {
      platform: "test",
      deploymentId: deterministicInput.bundle.verifier.deploymentId,
    },
    provider: {
      endpointIdentity: "fixture",
      model: "fixture",
      nativeConfiguration: { tokenUsage: 1 },
      pricingSnapshotArtifactId: policyArtifact.artifactId,
    },
    inputArtifacts: [source, policyArtifact, recordedArtifact],
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
    policyOutcome: "review",
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
  return sealAuditBundle({
    tenantId: source.tenantId,
    verificationBundle: deterministicInput.bundle,
    manifest,
    policyBinding: {
      policyVersion: deterministicInput.bundle.policyVersion,
      policyArtifact,
      recordedPolicyInputsArtifact: recordedArtifact,
    },
    recordedPolicyInputsBytes: recordedBytes,
    policyDecision: { outcome: "review" },
    signer: createEd25519Signer(privatePem, "audit-key"),
  });
}

describe("offline verification attestation CLI", () => {
  it("exports an immutable envelope then inspects it without network or private-key output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "attestation-cli-"));
    const auditKey = generateKeyPairSync("ed25519"),
      attestationKey = generateKeyPairSync("ed25519");
    const auditPrivate = auditKey.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const attestationPrivate = attestationKey.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const audit = await signedAudit(auditPrivate);
    const publicKeys = {
      "audit-key": auditKey.publicKey.export({ type: "spki", format: "pem" }).toString(),
      "attestation-key": attestationKey.publicKey.export({ type: "spki", format: "pem" }).toString(),
    };
    const auditPath = join(directory, "signed-audit.json"),
      keysPath = join(directory, "keys.json"),
      bindingPath = join(directory, "binding.json"),
      outputPath = join(directory, "signed-audit.dsse.json");
    try {
      await Promise.all([
        writeFile(auditPath, JSON.stringify(audit)),
        writeFile(keysPath, JSON.stringify(publicKeys)),
        writeFile(
          bindingPath,
          JSON.stringify({
            builderId:
              "urn:aiengineer:verification:deployment:" + encodeURIComponent(audit.manifest.runtime.deploymentId),
            keyId: "attestation-key",
          }),
        ),
      ]);
      const exported = await runVerificationAttestationExport(
        [
          "attestation",
          "export",
          "--audit-bundle",
          auditPath,
          "--trusted-public-keys",
          keysPath,
          "--trusted-binding",
          bindingPath,
          "--output",
          outputPath,
        ],
        { [VERIFICATION_ATTESTATION_SIGNING_KEY_ENV]: attestationPrivate },
      );
      expect(exported).toMatchObject({
        exitCode: 0,
        output: {
          subjectDigest: audit.seal.payloadDigest,
          signerKeyId: "attestation-key",
        },
      });
      expect(JSON.stringify(exported)).not.toContain(attestationPrivate);
      const inspected = await runVerificationAttestationInspect([
        "attestation",
        "inspect",
        "--audit-bundle",
        auditPath,
        "--trusted-public-keys",
        keysPath,
        "--trusted-binding",
        bindingPath,
        "--attestation",
        outputPath,
      ]);
      expect(inspected).toMatchObject({
        exitCode: 0,
        output: { verified: true, signerKeyId: "attestation-key" },
      });
      const built = await runBuiltCli([
        "attestation",
        "inspect",
        "--audit-bundle",
        auditPath,
        "--trusted-public-keys",
        keysPath,
        "--trusted-binding",
        bindingPath,
        "--attestation",
        outputPath,
      ]);
      expect(built).toMatchObject({ code: 0, stderr: "" });
      expect(JSON.parse(built.stdout)).toMatchObject({
        verified: true,
        signerKeyId: "attestation-key",
      });
      const builtOutput = join(directory, "built.dsse.json");
      const builtExport = await runBuiltCli(
        [
          "attestation",
          "export",
          "--audit-bundle",
          auditPath,
          "--trusted-public-keys",
          keysPath,
          "--trusted-binding",
          bindingPath,
          "--output",
          builtOutput,
        ],
        { [VERIFICATION_ATTESTATION_SIGNING_KEY_ENV]: attestationPrivate },
      );
      expect(builtExport).toMatchObject({ code: 0, stderr: "" });
      expect(builtExport.stdout).not.toContain(attestationPrivate);
      const wrongKey = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
      const wrongOutput = join(directory, "wrong-key.dsse.json");
      await expect(
        runVerificationAttestationExport(
          [
            "attestation",
            "export",
            "--audit-bundle",
            auditPath,
            "--trusted-public-keys",
            keysPath,
            "--trusted-binding",
            bindingPath,
            "--output",
            wrongOutput,
          ],
          { [VERIFICATION_ATTESTATION_SIGNING_KEY_ENV]: wrongKey },
        ),
      ).rejects.toMatchObject({ code: "ATTESTATION_SIGNING_KEY_UNTRUSTED" });
      await expect(readFile(wrongOutput)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        runVerificationAttestationExport(
          [
            "attestation",
            "export",
            "--audit-bundle",
            auditPath,
            "--trusted-public-keys",
            keysPath,
            "--trusted-binding",
            bindingPath,
            "--output",
            outputPath,
          ],
          { [VERIFICATION_ATTESTATION_SIGNING_KEY_ENV]: attestationPrivate },
        ),
      ).rejects.toMatchObject({ code: "ATTESTATION_OUTPUT_EXISTS" });
      const tampered = JSON.parse(await readFile(outputPath, "utf8")) as {
        payload: string;
      };
      tampered.payload = tampered.payload.slice(0, -2) + "AA";
      await writeFile(join(directory, "tampered.json"), JSON.stringify(tampered));
      const rejected = await runVerificationAttestationInspect([
        "attestation",
        "inspect",
        "--audit-bundle",
        auditPath,
        "--trusted-public-keys",
        keysPath,
        "--trusted-binding",
        bindingPath,
        "--attestation",
        join(directory, "tampered.json"),
      ]);
      expect(rejected).toMatchObject({
        exitCode: 1,
        output: { verified: false },
      });
      const oversized = join(directory, "oversized.json");
      await writeFile(oversized, Buffer.alloc(96 * 1024 + 1));
      await expect(
        runVerificationAttestationInspect([
          "attestation",
          "inspect",
          "--audit-bundle",
          auditPath,
          "--trusted-public-keys",
          keysPath,
          "--trusted-binding",
          bindingPath,
          "--attestation",
          oversized,
        ]),
      ).rejects.toMatchObject({ code: "ATTESTATION_INPUT_SIZE_INVALID" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("rejects missing, unknown, duplicate, and forbidden signing-key arguments with fixed codes", async () => {
    await expect(runVerificationAttestationExport(["attestation", "export"])).rejects.toMatchObject({
      code: "ATTESTATION_ARGUMENT_REQUIRED",
    });
    await expect(runVerificationAttestationInspect(["attestation", "inspect", "--unknown", "x"])).rejects.toMatchObject(
      { code: "ATTESTATION_ARGUMENT_UNKNOWN" },
    );
    await expect(
      runVerificationAttestationInspect(["attestation", "inspect", "--audit-bundle", "a", "--audit-bundle", "b"]),
    ).rejects.toMatchObject({ code: "ATTESTATION_ARGUMENT_DUPLICATE" });
    expect(new VerificationAttestationCliError("ATTESTATION_SIGNING_KEY_REQUIRED").code).toBe(
      "ATTESTATION_SIGNING_KEY_REQUIRED",
    );
  });
});
