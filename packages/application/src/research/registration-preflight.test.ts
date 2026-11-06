import type { AuthScope } from "@aiengineer/knowledge-research-core";
import { recordRef } from "@aiengineer/knowledge-research-core";
import { describe, expect, it } from "vitest";
import { fixtureAssertion, fixtureFragment, fixtureOrigin } from "./fixtures.js";
import { InMemoryResearchBinding } from "./in-memory.js";

/**
 * OVE-169 W1 D19 (review B2): the registration preflight reads each record id and digest before the first write. The
 * PostgreSQL binding runs the same rule over the component (store-backed in the host conformance suite).
 */
const TENANT = "7f3e2d1c-0b9a-4876-9543-210fedcba987";
const BINDING = "aiengineer-postgres";
const scope = { tenant: TENANT, binding: BINDING } as unknown as AuthScope;

describe("registration record preflight", () => {
  it("names a held id with other bytes and held bytes under another id; identical records pass", async () => {
    const binding = new InMemoryResearchBinding();
    const fragment = fixtureFragment(TENANT, BINDING);
    const assertion = fixtureAssertion(TENANT, BINDING, fixtureOrigin(TENANT));
    await binding.putFragment(scope, fragment);
    await binding.putAssertion(scope, assertion);
    const other = fixtureAssertion(TENANT, BINDING, { ...fixtureOrigin(TENANT), invocationId: "inv-other" });
    const renamed = { ...fragment, id: `${fragment.id}-copy` };
    expect(
      await binding.recordCollisions(scope, [
        { kind: "fragment", id: fragment.id, digest: recordRef("fragment", fragment).digest },
        { kind: "assertion", id: other.id, digest: recordRef("assertion", other).digest },
        { kind: "fragment", id: renamed.id, digest: recordRef("fragment", fragment).digest },
        { kind: "support_set", id: "ss-new", digest: recordRef("fragment", renamed).digest },
      ]),
    ).toEqual([
      { reason: "record_id_conflict", record: "assertion", id: assertion.id },
      { reason: "record_digest_exists", record: "fragment", id: fragment.id },
    ]);
  });
});
