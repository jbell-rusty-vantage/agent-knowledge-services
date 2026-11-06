import {
  type Digest,
  DigestSchema,
  IdSchema,
  InstantSchema,
  type JsonValue,
  NameSchema,
  RefSchema,
  type RefKind,
  SafeIntSchema,
  canonicalJson,
  digestCanonical,
  refOf,
} from "@aiengineer/knowledge-operation-protocol";
import { z } from "zod";
import { ShortTextSchema, UsageSchema, duplicates, identityShape } from "./common.js";

export const RUN_SCHEMA_VERSION = "research-core.verification_run.v2" as const;
export const MANIFEST_SCHEMA_VERSION = "research-core.run_manifest.v2" as const;

/**
 * `VerificationRun` (VERIFICATION.md §3). The report link is mandatory. A run never references a use decision: decision
 * snapshots reference runs, never the reverse, so run and decision digests cannot contain one another.
 */
export const VerificationRunSchema = z.strictObject({
  ...identityShape(RUN_SCHEMA_VERSION),
  task: refOf("task"),
  report: refOf("report"),
  predecessor: refOf("verification_run").nullable(),
  replayOf: refOf("verification_run").nullable(),
  operationId: IdSchema,
  missionCorrelation: z.strictObject({ missionId: IdSchema, runId: IdSchema }).nullable(),
  build: z.strictObject({ buildId: IdSchema, runtime: ShortTextSchema, dirty: z.boolean() }),
  obligationDenominator: z.array(IdSchema).min(1),
  candidateDenominator: SafeIntSchema,
  observations: z.array(refOf("observation")),
  cost: UsageSchema,
  startedAt: InstantSchema,
});
export type VerificationRun = z.infer<typeof VerificationRunSchema>;

export const FAMILIES = ["capture", "claims", "report", "observations", "adjudication", "decisions"] as const;
export type Family = (typeof FAMILIES)[number];

/** The ref kind each family may bind (its permitted schema). */
export const FAMILY_KINDS: Record<Family, RefKind> = {
  capture: "artifact",
  claims: "artifact",
  report: "report",
  observations: "artifact",
  adjudication: "adjudication",
  decisions: "use_decision",
};

/**
 * Snapshot kinds of one run lineage: the verification snapshot first; decision/admission snapshots (a reviewer
 * adjudication and its successor decision) and correction snapshots (an explicit source correction with its recheck
 * observations) append successors that reference the predecessor head and are signed the same way.
 */
export const SNAPSHOT_KINDS = [
  "verification_snapshot",
  "decision_snapshot",
  "admission_snapshot",
  "correction_snapshot",
] as const;
export type SnapshotKind = (typeof SNAPSHOT_KINDS)[number];

export const REQUIRED_FAMILIES: Record<SnapshotKind, readonly Family[]> = {
  verification_snapshot: ["capture", "claims", "report", "observations"],
  decision_snapshot: ["report", "decisions"],
  admission_snapshot: ["report", "decisions"],
  correction_snapshot: ["report", "observations"],
};

export const FamilyBindingSchema = z.strictObject({ family: z.enum(FAMILIES), ref: RefSchema });
export type FamilyBinding = z.infer<typeof FamilyBindingSchema>;

/**
 * Unsigned run manifest (design §6): immutable refs/digests to family seals. It never re-signs their bytes and never
 * holds its own digest or signature. Successors reference their predecessor; sealed history is never mutated.
 */
export const RunManifestSchema = z
  .strictObject({
    ...identityShape(MANIFEST_SCHEMA_VERSION),
    snapshot: z.enum(SNAPSHOT_KINDS),
    run: refOf("verification_run"),
    report: refOf("report"),
    predecessor: refOf("run_manifest").nullable(),
    families: z.array(FamilyBindingSchema).min(1),
    createdAt: InstantSchema,
  })
  .superRefine((manifest, context) => {
    for (const family of duplicates(manifest.families.map((binding) => binding.family))) {
      context.addIssue({ code: "custom", path: ["families"], message: `duplicate family ${family}` });
    }
    for (const binding of manifest.families) {
      if (binding.ref.kind !== FAMILY_KINDS[binding.family]) {
        context.addIssue({
          code: "custom",
          path: ["families"],
          message: `${binding.family} binds ${FAMILY_KINDS[binding.family]}, not ${binding.ref.kind}`,
        });
      }
    }
    for (const family of REQUIRED_FAMILIES[manifest.snapshot]) {
      if (!manifest.families.some((binding) => binding.family === family)) {
        context.addIssue({ code: "custom", path: ["families"], message: `missing required family ${family}` });
      }
    }
    const report = manifest.families.find((binding) => binding.family === "report");
    if (report !== undefined && report.ref.digest !== manifest.report.digest) {
      context.addIssue({
        code: "custom",
        path: ["report"],
        message: "the report family must bind the manifest report",
      });
    }
  });
export type RunManifest = z.infer<typeof RunManifestSchema>;

/** Canonical unsigned manifest bytes; the seal covers their digest. */
export function manifestBytes(manifest: RunManifest): string {
  return canonicalJson(manifest as unknown as JsonValue);
}

export function manifestDigest(manifest: RunManifest): Digest {
  return digestCanonical(manifest as unknown as JsonValue);
}

export const SEAL_ALGORITHM = "Ed25519" as const;

/**
 * Detached seal (design §6, K07): an Ed25519 signature over the canonical bytes of
 * `{manifestDigest, signer, signedAt, keyId}` (`sealSigningBytes`). It is never part of the hashed manifest payload.
 * `signature` is the 64-byte signature in unpadded base64url. Verification needs the public key pinned for `keyId`.
 */
export const SealSchema = z.strictObject({
  manifestDigest: DigestSchema,
  signer: NameSchema,
  signedAt: InstantSchema,
  algorithm: z.literal(SEAL_ALGORITHM),
  keyId: IdSchema,
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
});
export type Seal = z.infer<typeof SealSchema>;

/** The exact bytes the detached signature covers (K01 canonical JSON). */
export function sealSigningBytes(seal: Pick<Seal, "manifestDigest" | "signer" | "signedAt" | "keyId">): string {
  return canonicalJson({
    manifestDigest: seal.manifestDigest,
    signer: seal.signer,
    signedAt: seal.signedAt,
    keyId: seal.keyId,
  });
}

export const SealedRunSchema = z
  .strictObject({ manifest: RunManifestSchema, seal: SealSchema })
  .refine((sealed) => sealed.seal.manifestDigest === manifestDigest(sealed.manifest), {
    path: ["seal", "manifestDigest"],
    message: "the seal must cover the exact unsigned manifest digest",
  });
export type SealedRun = z.infer<typeof SealedRunSchema>;
