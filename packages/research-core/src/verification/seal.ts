import type { Digest } from "@aiengineer/knowledge-operation-protocol";
import {
  type RunManifest,
  RunManifestSchema,
  type Seal,
  type SealedRun,
  SealedRunSchema,
  manifestDigest,
} from "../records/run.js";

export type SealResult =
  | { readonly ok: true; readonly head: Digest; readonly sealed: SealedRun }
  | { readonly ok: false; readonly code: "HEAD_MISMATCH"; readonly head: Digest | null }
  | {
      readonly ok: false;
      readonly code: "LINEAGE_MISMATCH" | "SEAL_DIGEST_MISMATCH" | "INVALID_MANIFEST";
      readonly reason: string;
    };

/**
 * Seal transition modeled purely as compare-and-set (design §6): only the writer whose `expectedHead` equals the
 * committed head succeeds, and the new head is the unsigned manifest digest. The store adapter performs the same
 * comparison under its transaction; concurrent writers with the same expected head get one success.
 * The detached seal covers the manifest digest and never enters the hashed payload.
 */
export function sealRun(input: {
  readonly draft: RunManifest;
  readonly expectedHead: Digest | null;
  readonly currentHead: Digest | null;
  readonly seal: Seal;
}): SealResult {
  const parsed = RunManifestSchema.safeParse(input.draft);
  if (!parsed.success) {
    return { ok: false, code: "INVALID_MANIFEST", reason: parsed.error.issues[0]?.message ?? "invalid manifest" };
  }
  if (input.currentHead !== input.expectedHead) return { ok: false, code: "HEAD_MISMATCH", head: input.currentHead };
  const predecessor = parsed.data.predecessor?.digest ?? null;
  if (predecessor !== input.expectedHead) {
    return { ok: false, code: "LINEAGE_MISMATCH", reason: "the draft's predecessor must be the expected head" };
  }
  const digest = manifestDigest(parsed.data);
  if (input.seal.manifestDigest !== digest) {
    return { ok: false, code: "SEAL_DIGEST_MISMATCH", reason: "the seal does not cover this manifest digest" };
  }
  return { ok: true, head: digest, sealed: SealedRunSchema.parse({ manifest: parsed.data, seal: input.seal }) };
}
