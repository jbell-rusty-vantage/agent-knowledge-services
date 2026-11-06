import type { Ref } from "@aiengineer/knowledge-operation-protocol";
import type { EvidenceFragment } from "../records/fragment.js";
import type { AuthScope } from "./scope.js";

/** Immutable evidence fragments. Reads are exact by ref (digest included); a missing exact revision is an error. */
export interface EvidenceStore {
  put(scope: AuthScope, fragment: EvidenceFragment): Promise<Ref<"fragment">>;
  get(scope: AuthScope, fragment: Ref<"fragment">): Promise<EvidenceFragment>;
  /** Fragments selected from one capture, for invalidation closure on capture correction. */
  listByCapture(scope: AuthScope, capture: Ref<"artifact">): Promise<readonly Ref<"fragment">[]>;
}
