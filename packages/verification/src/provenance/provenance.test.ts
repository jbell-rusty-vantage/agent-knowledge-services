import { validateRecordedPolicyInputsArtifact } from "./policy-inputs.js";
import type { VerificationArtifactHandle, VerificationRunManifest } from "@aiengineer/knowledge-contracts";
import { describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { digestCanonicalJson, sha256Digest } from "../canonical/index.js";
import { verifyDeterministicBundle } from "../deterministic/index.js";
import { prototypeClaimInput, prototypeMetricInput } from "../deterministic/engine-golden.fixture.js";
import {
  createEd25519Signer,
  createEd25519Verifier,
  inspectAuditBundle,
  sealAuditBundle,
  verificationManifestDigest,
} from "./seal.js";
import { auditBundleFixture, policyBytes } from "./audit-bundle.fixture.js";
import { replayAuditBundle } from "./replay.js";
import type { VerificationAuditBundle } from "./model.js";

async function sealedFixture(
  judged = false,
): Promise<ReturnType<typeof auditBundleFixture> & { audit: VerificationAuditBundle }> {
  const value = auditBundleFixture({ judged });
  const audit = await sealAuditBundle({
    tenantId: value.sourceHandle.tenantId,
    verificationBundle: value.deterministicInput.bundle,
    manifest: value.manifest,
    policyBinding: {
      policyVersion: value.deterministicInput.bundle.policyVersion,
      policyArtifact: value.policyArtifact,
      recordedPolicyInputsArtifact: value.recordedPolicyInputsArtifact,
    },
    recordedPolicyInputsBytes: value.recordedPolicyInputsBytes,
    policyDecision: value.policyDecision,
  });
  return { ...value, audit };
}

describe("audit bundle sealing and replay", () => {
  it("seals public provider usage and replays hashes, selectors, and policy binding", async () => {
    const value = await sealedFixture();
    expect((await inspectAuditBundle(value.audit)).valid).toBe(true);
    const content = value.deterministicInput.artifacts[0]!.content;
    const bytesById = new Map<string, Uint8Array>([
      [value.sourceHandle.artifactId, new TextEncoder().encode(String(content))],
      [value.policyArtifact.artifactId, policyBytes],
      [value.recordedPolicyInputsArtifact.artifactId, value.recordedPolicyInputsBytes],
    ]);
    const handlesById = new Map([
      [value.sourceHandle.artifactId, value.sourceHandle],
      [value.policyArtifact.artifactId, value.policyArtifact],
      [value.recordedPolicyInputsArtifact.artifactId, value.recordedPolicyInputsArtifact],
    ]);
    const calls: string[] = [];
    const policyReplay = vi.fn(async (input) => {
      expect(input.recordedPolicyInputs).toMatchObject({
        schemaVersion: "verification-policy-inputs.v1",
        runId: "run-1",
      });
      expect(input.recordedPolicyInputsBytes).toEqual(value.recordedPolicyInputsBytes);
      return { outcome: "pass" as const, decision: value.policyDecision };
    });
    const replay = await replayAuditBundle(value.audit, {
      runtimePrincipals: value.deterministicInput.runtimePrincipals,
      artifactResolver: {
        async authorizeArtifact(input) {
          calls.push(`authorize:${input.artifactId}`);
        },
        async hydrateRegisteredArtifact(input) {
          calls.push(`hydrate:${input.artifactId}`);
          return {
            registration: handlesById.get(input.artifactId)!,
            bytes: bytesById.get(input.artifactId)!,
          };
        },
      },
      policyReplay: { replay: policyReplay },
    });
    expect(replay.deterministicResultDigest).toBe(value.audit.deterministicResultDigest);
    expect(replay.replayedArtifactIds).toContain(value.recordedPolicyInputsArtifact.artifactId);
    expect(policyReplay).toHaveBeenCalledTimes(1);
    expect(
      calls.every(
        (entry, index) => !entry.startsWith("hydrate:") || calls[index - 1] === entry.replace("hydrate:", "authorize:"),
      ),
    ).toBe(true);
  });

  it("rejects credential and private-reasoning fields while allowing measured token diagnostics", async () => {
    for (const field of [
      "apiKey",
      "chain_of_thought",
      "hidden-reasoning",
      "providerPrivateReasoning",
      "access_token",
      "Authorization",
    ]) {
      const value = auditBundleFixture();
      value.manifest.provider!.nativeConfiguration = {
        inputTokens: 4,
        outputTokens: 2,
        tokenUsage: 6,
        nested: [{ [field]: "must-not-appear" }],
      };
      value.manifest.canonicalization.manifestDigest = verificationManifestDigest(value.manifest);
      await expect(
        sealAuditBundle({
          tenantId: value.sourceHandle.tenantId,
          verificationBundle: value.deterministicInput.bundle,
          manifest: value.manifest,
          policyBinding: {
            policyVersion: value.deterministicInput.bundle.policyVersion,
            policyArtifact: value.policyArtifact,
            recordedPolicyInputsArtifact: value.recordedPolicyInputsArtifact,
          },
          recordedPolicyInputsBytes: value.recordedPolicyInputsBytes,
          policyDecision: value.policyDecision,
        }),
      ).rejects.toThrow(/PUBLIC_MANIFEST_PRIVATE_FIELD/);
    }
  });

  it("detects complete handle substitution and cycles in both lineage representations", async () => {
    const value = auditBundleFixture();
    const signature = sha256Digest("cycle-transform");
    value.sourceHandle.parentArtifactIds = [value.policyArtifact.artifactId];
    value.sourceHandle.transformationSignature = signature;
    value.policyArtifact.parentArtifactIds = [value.sourceHandle.artifactId];
    value.policyArtifact.transformationSignature = signature;
    value.manifest.lineage = [
      {
        edgeId: "source-policy",
        fromArtifactId: value.sourceHandle.artifactId,
        toArtifactId: value.policyArtifact.artifactId,
        relation: "generated",
        activityId: "cycle",
        activityVersion: "1",
      },
      {
        edgeId: "policy-source",
        fromArtifactId: value.policyArtifact.artifactId,
        toArtifactId: value.sourceHandle.artifactId,
        relation: "generated",
        activityId: "cycle",
        activityVersion: "1",
      },
    ];
    value.manifest.canonicalization.manifestDigest = verificationManifestDigest(value.manifest);
    await expect(
      sealAuditBundle({
        tenantId: value.sourceHandle.tenantId,
        verificationBundle: value.deterministicInput.bundle,
        manifest: value.manifest,
        policyBinding: {
          policyVersion: value.deterministicInput.bundle.policyVersion,
          policyArtifact: value.policyArtifact,
          recordedPolicyInputsArtifact: value.recordedPolicyInputsArtifact,
        },
        recordedPolicyInputsBytes: value.recordedPolicyInputsBytes,
        policyDecision: value.policyDecision,
      }),
    ).rejects.toThrow(/LINEAGE_CYCLE/);

    const valid = await sealedFixture();
    const resolverHandle = {
      ...valid.sourceHandle,
      retentionClass: "rewritten",
    };
    await expect(
      replayAuditBundle(valid.audit, {
        runtimePrincipals: valid.deterministicInput.runtimePrincipals,
        artifactResolver: {
          async authorizeArtifact() {},
          async hydrateRegisteredArtifact(input) {
            return input.artifactId === valid.sourceHandle.artifactId
              ? {
                  registration: resolverHandle,
                  bytes: new TextEncoder().encode(String(valid.deterministicInput.artifacts[0]!.content)),
                }
              : input.artifactId === valid.policyArtifact.artifactId
                ? { registration: valid.policyArtifact, bytes: policyBytes }
                : {
                    registration: valid.recordedPolicyInputsArtifact,
                    bytes: valid.recordedPolicyInputsBytes,
                  };
          },
        },
        policyReplay: {
          async replay() {
            return { outcome: "pass", decision: valid.policyDecision };
          },
        },
      }),
    ).rejects.toThrow("ARTIFACT_REGISTRATION_MISMATCH");
  });

  it("returns invalid for malformed seals and verifier exceptions", async () => {
    const value = await sealedFixture();
    const malformed = structuredClone(value.audit) as VerificationAuditBundle;
    delete (malformed as unknown as { seal?: unknown }).seal;
    await expect(inspectAuditBundle(malformed)).resolves.toMatchObject({
      valid: false,
      signatureStatus: "invalid",
    });

    const cloned = structuredClone(value.audit);
    const signedShape: VerificationAuditBundle = {
      ...cloned,
      seal: {
        ...cloned.seal,
        signatureAlgorithm: "Ed25519",
        keyId: "test",
        signatureBase64: Buffer.alloc(64).toString("base64"),
      },
    };
    const verifier = {
      verify: vi.fn(async () => {
        throw new Error("verifier unavailable");
      }),
    };
    await expect(inspectAuditBundle(signedShape, verifier)).resolves.toMatchObject({
      valid: false,
      signatureStatus: "invalid",
    });
  });

  it("rejects recorded policy-input byte tampering before policy replay", async () => {
    const value = await sealedFixture();
    const policyReplay = vi.fn();
    await expect(
      replayAuditBundle(value.audit, {
        runtimePrincipals: value.deterministicInput.runtimePrincipals,
        artifactResolver: {
          async authorizeArtifact() {},
          async hydrateRegisteredArtifact(input) {
            if (input.artifactId === value.sourceHandle.artifactId)
              return {
                registration: value.sourceHandle,
                bytes: new TextEncoder().encode(String(value.deterministicInput.artifacts[0]!.content)),
              };
            if (input.artifactId === value.policyArtifact.artifactId)
              return { registration: value.policyArtifact, bytes: policyBytes };
            return {
              registration: value.recordedPolicyInputsArtifact,
              bytes: new TextEncoder().encode("tampered"),
            };
          },
        },
        policyReplay: { replay: policyReplay },
      }),
    ).rejects.toThrow("ARTIFACT_BYTE_LENGTH_MISMATCH");
    expect(policyReplay).not.toHaveBeenCalled();
  });

  it("verifies signed bundles and detects signed payload tampering", async () => {
    const value = auditBundleFixture();
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const audit = await sealAuditBundle({
      tenantId: value.sourceHandle.tenantId,
      verificationBundle: value.deterministicInput.bundle,
      manifest: value.manifest,
      policyBinding: {
        policyVersion: value.deterministicInput.bundle.policyVersion,
        policyArtifact: value.policyArtifact,
        recordedPolicyInputsArtifact: value.recordedPolicyInputsArtifact,
      },
      recordedPolicyInputsBytes: value.recordedPolicyInputsBytes,
      policyDecision: value.policyDecision,
      signer: createEd25519Signer(privatePem, "test-key"),
    });
    const verifier = createEd25519Verifier({ "test-key": publicPem });
    await expect(inspectAuditBundle(audit, verifier)).resolves.toMatchObject({
      valid: true,
      signatureStatus: "verified",
    });
    const tampered = structuredClone(audit);
    tampered.policyBinding.recordedPolicyInputsArtifact.objectKey = "tampered/key";
    await expect(inspectAuditBundle(tampered, verifier)).resolves.toMatchObject({
      valid: false,
      signatureStatus: "invalid",
    });
  });
});

describe("recorded policy input coverage", () => {
  it.each(["duplicate-assertion", "semantic-assertion", "duplicate-metric"])(
    "rejects %s even with valid artifact hashes",
    (kind) => {
      const value = auditBundleFixture(),
        bundle = structuredClone(value.deterministicInput.bundle),
        body = JSON.parse(new TextDecoder().decode(value.recordedPolicyInputsBytes));
      let expected = "POLICY_INPUT_SEMANTIC_ASSERTION_MISMATCH";
      if (kind === "duplicate-assertion") {
        bundle.assertions.push({
          ...structuredClone(bundle.assertions[0]!),
          assertionId: "claim-2",
        });
        body.assertions.push(structuredClone(body.assertions[0]));
        expected = "POLICY_INPUT_ASSERTION_COVERAGE_MISMATCH";
      } else if (kind === "semantic-assertion") {
        body.assertions[0].semantic.assertionId = "claim-2";
      } else {
        const metric = prototypeMetricInput().bundle.metricObservations[0]!;
        bundle.metricObservations = [metric, { ...structuredClone(metric), observationId: "metric-2" }];
        const row = {
          observationId: metric.observationId,
          riskClass: "medium",
          downstreamUse: ["semantic_verification"],
          criticalFactsKnown: true,
          conflictPresent: false,
        };
        body.metrics = [row, { ...row }];
        expected = "POLICY_INPUT_METRIC_COVERAGE_MISMATCH";
      }
      const bytes = new TextEncoder().encode(JSON.stringify(body));
      expect(() =>
        validateRecordedPolicyInputsArtifact({
          handle: {
            ...value.recordedPolicyInputsArtifact,
            digest: sha256Digest(bytes),
            byteLength: bytes.byteLength,
          },
          bytes,
          bundle,
          deterministicResult: value.deterministicResult,
          runId: "run-1",
          policyVersion: bundle.policyVersion,
        }),
      ).toThrow(expected);
    },
  );
});

it("requires semantic reconstruction before policy evaluation for judged inputs", async () => {
  const value = await sealedFixture(true),
    bytes = new Map([
      [value.sourceHandle.artifactId, new TextEncoder().encode(String(value.deterministicInput.artifacts[0]!.content))],
      [value.policyArtifact.artifactId, policyBytes],
      [value.recordedPolicyInputsArtifact.artifactId, value.recordedPolicyInputsBytes],
    ]);
  const handles = new Map(
    [value.sourceHandle, value.policyArtifact, value.recordedPolicyInputsArtifact].map((handle) => [
      handle.artifactId,
      handle,
    ]),
  );
  const policy = vi.fn(async () => ({
    outcome: "pass" as const,
    decision: value.policyDecision,
  }));
  const options = {
    runtimePrincipals: value.deterministicInput.runtimePrincipals,
    artifactResolver: {
      async authorizeArtifact() {},
      async hydrateRegisteredArtifact({ artifactId }: { artifactId: string }) {
        return {
          registration: handles.get(artifactId)!,
          bytes: bytes.get(artifactId)!,
        };
      },
    },
    policyReplay: { replay: policy },
  };
  await expect(replayAuditBundle(value.audit, options)).rejects.toThrow("SEMANTIC_AUDIT_REPLAY_REQUIRED");
  expect(policy).not.toHaveBeenCalled();
  const assessment = JSON.parse(new TextDecoder().decode(value.recordedPolicyInputsBytes)).assertions[0].semantic;
  await expect(
    replayAuditBundle(value.audit, {
      ...options,
      semanticReplay: {
        async replay() {
          return {
            assessments: [{ ...assessment, reasonCodes: ["FORGED"] }],
            replayedArtifactIds: [value.sourceHandle.artifactId],
          };
        },
      },
    }),
  ).rejects.toThrow("SEMANTIC_AUDIT_REPLAY_DRIFT");
  expect(policy).not.toHaveBeenCalled();
  await expect(
    replayAuditBundle(value.audit, {
      ...options,
      semanticReplay: {
        async replay() {
          return {
            assessments: [assessment],
            replayedArtifactIds: ["unlisted-artifact"],
          };
        },
      },
    }),
  ).rejects.toThrow("SEMANTIC_AUDIT_REPLAY_ARTIFACT_BINDING");
  expect(policy).not.toHaveBeenCalled();
  const replay = await replayAuditBundle(value.audit, {
    ...options,
    semanticReplay: {
      async replay(input) {
        expect(input.verifiedRepresentationBytes.get(value.sourceHandle.artifactId)).toEqual(
          bytes.get(value.sourceHandle.artifactId),
        );
        return {
          assessments: [assessment],
          replayedArtifactIds: [value.sourceHandle.artifactId],
        };
      },
    },
  });
  expect(replay.policyOutcome).toBe("pass");
  expect(policy).toHaveBeenCalledOnce();
});
