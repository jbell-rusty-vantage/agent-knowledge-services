import { type Digest, type JsonValue, digestBytes, digestCanonical } from "@aiengineer/knowledge-operation-protocol";
import { describe, expect, it } from "vitest";
import { recordRef } from "../digest.js";
import {
  MANIFEST_SCHEMA_VERSION,
  RUN_SCHEMA_VERSION,
  type RunManifest,
  RunManifestSchema,
  type Seal,
  type VerificationRun,
  manifestDigest,
} from "../records/run.js";
import { AT, BINDING, TENANT, ref } from "../test-support.js";
import { checkLineageAcyclic, verifyFamilies } from "./manifest.js";
import { checkRunLink } from "./run.js";
import { sealRun } from "./seal.js";

const reportRef = ref("report", "report-1");
const claims = { assertions: ["a-1", "a-2"] } satisfies JsonValue;
const captureBytes = "raw capture bytes é";

const run: VerificationRun = {
  schemaVersion: RUN_SCHEMA_VERSION,
  id: "run-1",
  tenant: TENANT,
  binding: BINDING,
  task: ref("task", "task-1"),
  report: reportRef,
  predecessor: null,
  replayOf: null,
  operationId: "op-1",
  missionCorrelation: null,
  build: { buildId: "build-1", runtime: "node-24", dirty: false },
  obligationDenominator: ["o-1"],
  candidateDenominator: 4,
  observations: [],
  cost: { providerCalls: 2, tokens: 900, costUsd: "0.02" },
  startedAt: AT,
};

const digests = { capture: digestBytes(captureBytes), claims: digestCanonical(claims) };

async function manifest(overrides: Partial<RunManifest> = {}): Promise<RunManifest> {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    id: "manifest-1",
    tenant: TENANT,
    binding: BINDING,
    snapshot: "verification_snapshot",
    run: recordRef("verification_run", run),
    report: reportRef,
    predecessor: null,
    families: [
      { family: "capture", ref: ref("artifact", "capture-1", { digest: digests.capture }) },
      { family: "claims", ref: ref("artifact", "claims-1", { digest: digests.claims }) },
      { family: "report", ref: reportRef },
      { family: "observations", ref: ref("artifact", "obs-1") },
    ],
    createdAt: AT,
    ...overrides,
  };
}

const seal = (digest: Digest, signer = "ks-sealer"): Seal => ({
  manifestDigest: digest,
  signer,
  signedAt: AT,
  algorithm: "Ed25519",
  keyId: `key-${signer}`,
  // Pure CAS tests: signature bytes are verified by the K07 verifier in the application/binding, not by sealRun.
  signature: "A".repeat(86),
});

describe("run manifest, sealing and lineage (design §6, §9 run-manifest seam)", () => {
  it("lets exactly one of two concurrent seals with the same expected head commit", async () => {
    let head: Digest | null = null;
    const first = await manifest({ id: "manifest-a" });
    const second = await manifest({ id: "manifest-b" });
    const attempts = [first, second].map((draft) => ({ draft, expectedHead: head }));
    const results = attempts.map(({ draft, expectedHead }) => {
      const result = sealRun({ draft, expectedHead, currentHead: head, seal: seal(manifestDigest(draft)) });
      if (result.ok) head = result.head;
      return result;
    });
    expect(results.map((result) => result.ok)).toEqual([true, false]);
    expect(results[1]).toMatchObject({ ok: false, code: "HEAD_MISMATCH", head: manifestDigest(first) });
  });

  it("requires a successor to name the expected head as predecessor", async () => {
    const genesis = await manifest();
    const head = manifestDigest(genesis);
    const successor = await manifest({
      id: "manifest-2",
      predecessor: { ...recordRef("run_manifest", genesis) },
    });
    expect(
      sealRun({ draft: successor, expectedHead: head, currentHead: head, seal: seal(manifestDigest(successor)) }).ok,
    ).toBe(true);
    const orphan = await manifest({ id: "manifest-3" });
    expect(
      sealRun({ draft: orphan, expectedHead: head, currentHead: head, seal: seal(manifestDigest(orphan)) }),
    ).toMatchObject({
      ok: false,
      code: "LINEAGE_MISMATCH",
    });
  });

  it("keeps the detached seal out of the hashed payload and refuses a seal over other bytes", async () => {
    const draft = await manifest();
    const a = sealRun({ draft, expectedHead: null, currentHead: null, seal: seal(manifestDigest(draft), "signer-a") });
    const b = sealRun({ draft, expectedHead: null, currentHead: null, seal: seal(manifestDigest(draft), "signer-b") });
    expect(a.ok && b.ok && a.head === b.head).toBe(true);
    expect(JSON.stringify(draft)).not.toContain("signer-a");
    const other = await manifest({ createdAt: "2026-10-24T21:00:00Z" });
    expect(sealRun({ draft, expectedHead: null, currentHead: null, seal: seal(manifestDigest(other)) })).toMatchObject({
      ok: false,
      code: "SEAL_DIGEST_MISMATCH",
    });
  });

  it("detects family tampering and missing families", async () => {
    const draft = await manifest();
    const families = [
      { family: "capture", kind: "bytes", bytes: captureBytes },
      { family: "claims", kind: "record", value: claims },
      { family: "report", kind: "record", value: { stand_in: true } },
      { family: "observations", kind: "record", value: { kind: "artifact", id: "obs-1" } },
    ] as const;
    const tamperedReport = verifyFamilies(draft, families);
    expect(tamperedReport).toEqual({ ok: false, code: "FAMILY_TAMPERED", families: ["report"] });
    const altered = verifyFamilies(draft, [
      { family: "capture", kind: "bytes", bytes: `${captureBytes} ` },
      { family: "claims", kind: "record", value: claims },
      { family: "report", kind: "record", value: { kind: "report", id: "report-1" } },
      { family: "observations", kind: "record", value: { kind: "artifact", id: "obs-1" } },
    ]);
    expect(altered).toEqual({ ok: false, code: "FAMILY_TAMPERED", families: ["capture"] });
    expect(verifyFamilies(draft, families.slice(0, 2))).toMatchObject({ ok: false, code: "MISSING_FAMILY" });
  });

  it("refuses a lineage cycle by logical identity", async () => {
    const m1 = await manifest({ id: "m-1" });
    const m2 = await manifest({ id: "m-2", predecessor: recordRef("run_manifest", m1) });
    const forged = await manifest({ id: "m-1", predecessor: recordRef("run_manifest", m2) });
    expect(checkLineageAcyclic([m1, m2])).toEqual({ ok: true });
    const result = checkLineageAcyclic([forged, m2]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.cycle[0]).toBe(result.cycle[result.cycle.length - 1]);
  });

  it("enforces the mandatory report/run link and required families", async () => {
    const draft = await manifest();
    expect(checkRunLink(draft, run)).toEqual({ ok: true });
    expect(checkRunLink(draft, { ...run, report: ref("report", "report-2") })).toMatchObject({
      ok: false,
      code: "RUN_LINK_MISMATCH",
    });
    expect(checkRunLink({ ...draft, report: ref("report", "report-2") }, run)).toMatchObject({
      ok: false,
      code: "REPORT_LINK_MISMATCH",
    });
    expect(RunManifestSchema.safeParse({ ...draft, report: ref("report", "report-2") }).success).toBe(false);
    expect(
      RunManifestSchema.safeParse({ ...draft, families: draft.families.filter((f) => f.family !== "report") }).success,
    ).toBe(false);
    expect(
      RunManifestSchema.safeParse({
        ...draft,
        families: [...draft.families, { family: "decisions", ref: ref("verification_run", "run-x") }],
      }).success,
    ).toBe(false);
  });
});
