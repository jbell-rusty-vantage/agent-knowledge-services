import type { Ref } from "@aiengineer/knowledge-operation-protocol";
import type { AuthScope } from "./scope.js";

/** Host-owned reader for an explicitly supported external artifact-ref version. Undefined means not this reader. */
export interface ExternalCustodyReader {
  get(scope: AuthScope, artifact: Ref<"artifact">): Promise<Uint8Array | undefined>;
}

/** Exact byte custody for captures, representations, bodies, ledgers and raw responses. Bytes are never normalized. */
export interface CustodyStore {
  put(scope: AuthScope, bytes: Uint8Array, mediaType: string): Promise<Ref<"artifact">>;
  get(scope: AuthScope, artifact: Ref<"artifact">): Promise<Uint8Array>;
  /** Re-digest stored bytes against the ref; false means the custody copy no longer matches. */
  verify(scope: AuthScope, artifact: Ref<"artifact">): Promise<boolean>;
}
