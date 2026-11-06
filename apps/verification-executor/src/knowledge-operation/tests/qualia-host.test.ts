import test from "node:test";
import assert from "node:assert/strict";
import { digestBytes, type Origin, type Ref } from "@aiengineer/knowledge-operation-protocol";
import { prepareQualiaReport, type AuthoredReport } from "./qualia-report.js";
import { assertSeparateEvaluator } from "./qualia-host.js";

const origin: Origin = {
  kind: "mission_invocation",
  installationId: "01a103c0-9a9e-7a95-961b-29dda83c842b",
  applicationId: "biotech",
  tenantId: "a6be1117-e0cc-4d6a-9e52-8bc28f310888",
  issuer: "mission-control",
  subject: "test-producer",
  mission: {
    missionId: "test",
    runId: "test-run",
    activationId: null,
    operationId: "producer",
    operationAttempt: 1,
    executionGeneration: 1,
    lane: "deep_agents",
  },
  recoveryAuthorityRef: null,
  invocationId: "test-invocation",
  authenticatedAt: "2026-10-30T00:00:00Z",
};
const put = async (bytes: Uint8Array): Promise<Ref<"artifact">> => ({
  kind: "artifact",
  id: `artifact-${digestBytes(bytes).slice(7, 30)}`,
  version: "artifact.v1",
  digest: digestBytes(bytes),
  tenant: origin.tenantId,
  binding: "biotech-graph",
});
const authored: AuthoredReport = {
  id: "synthetic-test-report",
  title: "Synthetic unit test",
  summary: "Schema verification only",
  claims: [
    {
      id: "claim",
      statement: "The synthetic source reports cellulose.",
      sourceUrl: "https://fixtures.bks.test/source",
      quote: "Synthetic cellulose appears on this test page.",
      qualifiers: { negation: false, entity: "synthetic-product", outcome: "ingredient label" },
    },
  ],
  limitations: ["Synthetic unit test only."],
};
test("source-report package preserves actual captured byte digests and unknown scientific qualifiers", async () => {
  const text = "Synthetic cellulose appears on this test page.";
  const source = {
    url: authored.claims[0]!.sourceUrl,
    text,
    ref: await put(Buffer.from(text)),
    retrievedAt: "2026-10-30T00:00:00Z",
  };
  const registration = await prepareQualiaReport({ authored, sources: [source], origin, put });
  assert.equal(registration.fragments[0]!.selectedDigest, digestBytes(text));
  assert.equal(registration.assertions[0]!.qualifiers.profile, "scientific.v2");
  assert.equal(registration.assertions[0]!.qualifiers.population, null);
  assert.equal(
    registration.task.obligations.reduce((n, o) => n + o.weight, 0),
    10000,
  );
  assert.equal(registration.task.audience, "internal");
});
test("unretained source or quote fails before registration", async () => {
  await assert.rejects(prepareQualiaReport({ authored, sources: [], origin, put }), /unavailable/);
  const text = "Different retained bytes";
  await assert.rejects(
    prepareQualiaReport({
      authored,
      sources: [
        {
          url: authored.claims[0]!.sourceUrl,
          text,
          ref: await put(Buffer.from(text)),
          retrievedAt: "2026-10-30T00:00:00Z",
        },
      ],
      origin,
      put,
    }),
    /does not uniquely resolve/,
  );
});
test("evaluator must have a separate subject and operation and an allowed actual model", () => {
  assert.throws(
    () =>
      assertSeparateEvaluator(origin, {
        origin,
        model: "gpt-6.1-sol",
        evaluate: async () => {
          throw new Error("must not run");
        },
      }),
    /own authenticated/,
  );
  assert.doesNotThrow(() =>
    assertSeparateEvaluator(origin, {
      origin: { ...origin, subject: "test-judge", mission: { ...origin.mission!, operationId: "judge" } },
      model: "gpt-6.1-terra",
      evaluate: async () => {
        throw new Error("must not run");
      },
    }),
  );
});
