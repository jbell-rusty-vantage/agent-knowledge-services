import type { JsonValue } from "@aiengineer/knowledge-operation-protocol";
import {
  type FamilyContent,
  type SealVerifier,
  type SealedRun,
  type VerificationObservation,
  VerificationObservationSchema,
  manifestDigest,
  verifyFamilies,
} from "@aiengineer/knowledge-research-core";
import { z } from "zod";

/**
 * Sealed-lineage verification shared by every binding (design §6, K07): each manifest's seal must verify against the
 * digest RECOMPUTED from the stored manifest bytes under a pinned key, successors must chain to their predecessor's
 * digest, and every referenced family must re-digest to its binding. Any failure refuses the whole load.
 */
export class SealVerificationError extends Error {
  readonly code: "SEAL_INVALID" | "FAMILY_TAMPERED" | "LINEAGE_MISMATCH";
  constructor(code: SealVerificationError["code"], message: string) {
    super(`${code}: ${message}`);
    this.name = "SealVerificationError";
    this.code = code;
  }
}

export function verifySealedLineage(
  lineage: readonly SealedRun[],
  verifier: SealVerifier,
  contents: (sealed: SealedRun, index: number) => readonly FamilyContent[],
): void {
  let previous: string | null = null;
  lineage.forEach((sealed, index) => {
    const recomputed = manifestDigest(sealed.manifest);
    const verdict = verifier.verify(sealed.seal, recomputed);
    if (!verdict.ok) throw new SealVerificationError("SEAL_INVALID", `manifest ${index + 1}: ${verdict.reason}`);
    if ((sealed.manifest.predecessor?.digest ?? null) !== previous) {
      throw new SealVerificationError("LINEAGE_MISMATCH", `manifest ${index + 1} does not chain to its predecessor`);
    }
    const families = verifyFamilies(sealed.manifest, contents(sealed, index));
    if (!families.ok) {
      throw new SealVerificationError(
        families.code === "MISSING_FAMILY" ? "FAMILY_TAMPERED" : families.code,
        `manifest ${index + 1}: ${families.families.join(", ")}`,
      );
    }
    previous = recomputed;
  });
}

/** The observations family of a correction snapshot: the invalidation and the recheck observations it appended. */
export const CORRECTION_RECHECK_SCHEMA_VERSION = "research-core.correction_recheck.v1" as const;
export const CorrectionRecheckSchema = z.strictObject({
  schemaVersion: z.literal(CORRECTION_RECHECK_SCHEMA_VERSION),
  invalidationId: z.string().min(1).max(200),
  epoch: z.int().min(1),
  corrected: z.strictObject({ kind: z.enum(["fragment", "capture"]), id: z.string().min(1).max(200) }),
  reason: z.string().min(1).max(500),
  observations: z.array(z.unknown()),
});
export type CorrectionRecheck = Omit<z.infer<typeof CorrectionRecheckSchema>, "observations"> & {
  readonly observations: readonly VerificationObservation[];
};

export function correctionRecheckBytes(recheck: CorrectionRecheck): string {
  return JSON.stringify(recheck);
}

export function parseCorrectionRecheck(bytes: Uint8Array): CorrectionRecheck {
  const parsed = CorrectionRecheckSchema.parse(JSON.parse(Buffer.from(bytes).toString("utf8")));
  return { ...parsed, observations: parsed.observations.map((value) => VerificationObservationSchema.parse(value)) };
}

/** Family content for the default families of a manifest from custody bytes and stored records. */
export function familyContent(
  family: FamilyContent["family"],
  content: { bytes: Uint8Array } | { record: JsonValue },
): FamilyContent {
  return "bytes" in content
    ? { family, kind: "bytes", bytes: content.bytes }
    : { family, kind: "record", value: content.record };
}
