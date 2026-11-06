import assert from "node:assert/strict";
import test from "node:test";
import type { Origin } from "@aiengineer/knowledge-operation-protocol";
import { AIENG_USE, AiengIntentRefused, buildAiengIntent, type AiengNativeInput } from "./aieng-intent.js";
import type { FrozenQualiaReport } from "./qualia-frozen.js";

const origin: Origin = {
  kind: "standalone",
  installationId: "0192a4f0-0000-7000-8000-0000000a1e11",
  applicationId: "ai-engineer",
  tenantId: "9287e246-224b-5814-bc00-44bb5396e0c5",
  issuer: "test-host",
  subject: "test-producer",
  mission: null,
  recoveryAuthorityRef: null,
  invocationId: "test-invocation",
  authenticatedAt: "2026-10-31T00:00:00Z",
};
const verdict = (value: string) => ({ outcome: { verdict: value } }) as never;
const frozen = {
  reportRevisionId: "aieng-r1",
  bodyDigest: "sha256:body",
  ledgerDigest: "sha256:ledger",
  structuredBodyDigest: "sha256:structured",
  assertions: [
    {
      id: "a-supported",
      proposition: "The README lists a Sub-agents feature.",
      qualifiers: { profile: "engineering.v2", entity: "Deep Agents", negation: false, runtime: null },
      judgments: [verdict("full_support")],
    },
    {
      id: "a-qualified",
      proposition: "A qualified statement.",
      qualifiers: { profile: "engineering.v2", negation: false },
      judgments: [verdict("qualified_support")],
    },
  ],
} as unknown as FrozenQualiaReport;
const base = () => ({
  frozen,
  verificationRunId: "0195f0a0-0000-7000-8000-000000000001",
  asOf: "2026-10-31",
  context: { tenantId: origin.tenantId, attemptId: "0195f0a0-0000-7000-8000-000000000002" },
  snapshot: { snapshotId: "snap", snapshotDigest: "sha256:snap", knowledgeSeq: 0 },
  effectKey: "aieng-r1:native",
  origin,
});
const authored = (overrides: Partial<AiengNativeInput> = {}): AiengNativeInput => ({
  intentId: "intent-1",
  subjects: [
    { ref: "lib", mode: "new", kind: "library", displayName: "Deep Agents", evidence: [{ claimId: "a-supported" }] },
  ],
  proposals: [
    {
      proposalId: "lib-github",
      kind: "entity.identifier",
      subjectRef: "lib",
      scheme: "github",
      value: "langchain-ai/deepagents",
      evidence: [{ claimId: "a-supported" }],
    },
  ],
  claims: [{ assertionId: "a-supported", claimType: "capability" }],
  ...overrides,
});

test("binds every evidence ref to the one verification run and copies frozen claim text", () => {
  const { intent, reportBinding } = buildAiengIntent({ ...base(), authored: authored() });
  const runId = base().verificationRunId;
  assert.deepEqual(intent.evidence.verificationRuns, [{ runId }]);
  assert.equal(intent.evidence.claims[0]?.statement, "The README lists a Sub-agents feature.");
  assert.deepEqual(intent.evidence.claims[0]?.qualifiers, ["entity=Deep Agents", "negation=false"]);
  for (const proposal of intent.proposals) for (const ref of proposal.evidence) assert.equal(ref.runId, runId);
  assert.deepEqual(
    intent.proposals.map((p) => p.kind),
    ["entity.identifier", "claim.materialize"],
  );
  assert.deepEqual(intent.declaredUse, AIENG_USE);
  assert.equal(intent.exactUse.effectKey, "aieng-r1:native");
  assert.deepEqual(reportBinding.claimIds, ["a-supported"]);
});

test("refuses host-owned proposals, ineligible assertions and unselected citations", () => {
  const cases: AiengNativeInput[] = [
    authored({
      proposals: [{ proposalId: "pub", kind: "report.publish", title: "t", asOf: "2026", evidence: [] }],
    }),
    authored({ claims: [{ assertionId: "a-qualified" }] }),
    authored({
      subjects: [
        {
          ref: "lib",
          mode: "new",
          kind: "library",
          displayName: "Deep Agents",
          evidence: [{ claimId: "a-qualified" }],
        },
      ],
    }),
  ];
  for (const input of cases)
    assert.throws(
      () => buildAiengIntent({ ...base(), authored: input }),
      (error: unknown) => error instanceof AiengIntentRefused && error.code === "NATIVE_INPUT_INVALID",
    );
});
