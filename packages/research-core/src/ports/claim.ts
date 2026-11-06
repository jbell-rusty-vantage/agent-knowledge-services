import type { Ref } from "@aiengineer/knowledge-operation-protocol";
import type { AssertionVersion } from "../records/assertion.js";
import type { AssertionOccurrence } from "../records/occurrence.js";
import type { SupportSet } from "../records/support.js";
import type { AuthScope } from "./scope.js";

/** Assertion versions, support sets and occurrences. Append-only: a change is a new version with a new digest. */
export interface ClaimStore {
  putAssertion(scope: AuthScope, assertion: AssertionVersion): Promise<Ref<"assertion">>;
  getAssertion(scope: AuthScope, assertion: Ref<"assertion">): Promise<AssertionVersion>;
  putSupportSet(scope: AuthScope, set: SupportSet): Promise<Ref<"support_set">>;
  listSupportSets(scope: AuthScope, assertion: Ref<"assertion">): Promise<readonly SupportSet[]>;
  putOccurrence(scope: AuthScope, occurrence: AssertionOccurrence): Promise<Ref<"occurrence">>;
  listOccurrences(scope: AuthScope, body: Ref<"artifact">): Promise<readonly AssertionOccurrence[]>;
}
