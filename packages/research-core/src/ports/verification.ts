import type { Digest, Ref } from "@aiengineer/knowledge-operation-protocol";
import type { VerificationObservation } from "../records/observation.js";
import type { RunManifest, SealedRun, VerificationRun } from "../records/run.js";
import type { AuthScope } from "./scope.js";

/** A draft is the unsigned manifest; the sealing authority behind the store produces the detached seal. */
export type RunManifestDraft = RunManifest;

/**
 * `VerificationStore` (design §4): one run, one sealing authority. `seal` is compare-and-set on the lineage head
 * (`expectedHead` null for a genesis manifest) and fails with `HEAD_MISMATCH` for every concurrent loser.
 */
export interface VerificationStore {
  load(scope: AuthScope, run: Ref<"verification_run">): Promise<SealedRun>;
  putRun(scope: AuthScope, run: VerificationRun): Promise<Ref<"verification_run">>;
  append(scope: AuthScope, observation: VerificationObservation): Promise<void>;
  seal(scope: AuthScope, draft: RunManifestDraft, expectedHead: Digest | null): Promise<SealedRun>;
  head(scope: AuthScope, run: Ref<"verification_run">): Promise<Digest | null>;
}
