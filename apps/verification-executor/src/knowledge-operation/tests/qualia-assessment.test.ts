import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { ReportKindCatalog, ScriptedAuditorDiscovery } from "@aiengineer/knowledge-application";
import { createInMemoryBackend } from "@aiengineer/knowledge-host/knowledge-operation";
import { sameRef, type Origin } from "@aiengineer/knowledge-operation-protocol";
import { recordRef } from "@aiengineer/knowledge-research-core";
import { supportObservation } from "@aiengineer/knowledge-research-core/testing";
import { prepareQualiaReport } from "./qualia-report.js";
import { qualiaAssessmentPreview } from "./qualia-assessment.js";
import { replayQualiaAssessment } from "./qualia-assessment-replay.js";

async function fixture(compound = false) {
  const origin: Origin = {
    kind: "standalone",
    installationId: "01a103c0-9a9e-7a95-961b-29dda83c842b",
    applicationId: "biotech",
    tenantId: "synthetic-assessment",
    issuer: "synthetic-host",
    subject: "synthetic-producer",
    mission: null,
    recoveryAuthorityRef: null,
    invocationId: "synthetic-invocation",
    authenticatedAt: "2026-10-30T00:00:00Z",
  };
  const kinds = ReportKindCatalog.fromDirectory(
    resolve(import.meta.dirname, "../../../../../catalog/research/report-kinds"),
  );
  const backend = createInMemoryBackend({ application: "biotech", binding: "biotech-graph", kinds, auditor: null });
  const research = backend.research();
  const scope = {
    tenant: origin.tenantId,
    application: origin.applicationId,
    binding: "biotech-graph",
    origin,
    grants: [],
  };
  const put = (bytes: Uint8Array, mediaType: string) => research.binding.custody.put(scope, bytes, mediaType);
  const text = "The synthetic study reports a biomarker increase. No symptom improvement was reported.";
  const statement = compound ? text : "The synthetic study reports a biomarker increase.";
  const registration = await prepareQualiaReport({
    authored: {
      id: "synthetic-preview",
      title: "Synthetic offline preview test",
      summary: "No actual study or model invocation.",
      claims: [
        {
          id: "biomarker",
          statement,
          sourceUrl: "https://fixtures.bks.test/preview",
          quote: text,
          qualifiers: { negation: false },
        },
      ],
      limitations: ["Synthetic test only."],
    },
    sources: [
      {
        url: "https://fixtures.bks.test/preview",
        text,
        ref: await put(Buffer.from(text), "text/plain"),
        retrievedAt: "2026-10-30T00:00:00Z",
      },
    ],
    origin,
    put,
  });
  const { runId } = await research.coordinator.openRun(scope, { task: registration.task, originatingOrigin: origin });
  await research.coordinator.registerEvidence(scope, registration);
  const registered = await research.coordinator.registerReport(scope, {
    ...registration.report,
    runId,
    kind: kinds.ref(scope, "evidence_report"),
    assertions: registration.assertions.map((assertion) => recordRef("assertion", assertion)),
  });
  const set = registration.supportSets[0]!,
    assertion = registration.assertions[0]!;
  const observation = supportObservation({
    id: "synthetic-preview-judge",
    set,
    target: assertion,
    verdict: "full_support",
  });
  if (observation.property !== "support") throw new Error("Expected synthetic support observation");
  const evidence = registration.fragments.map((fragment) => recordRef("fragment", fragment));
  await research.coordinator.observe(scope, runId, {
    ...observation,
    tenant: scope.tenant,
    binding: scope.binding,
    method: { ...observation.method, tenant: scope.tenant, binding: scope.binding },
    evidence,
    outcome: { ...observation.outcome, citedFragments: evidence },
  });
  // Scripted double is confined to this offline synthetic test; no live observer is replaced.
  const auditor = new ScriptedAuditorDiscovery({
    entries: [
      { quote: "The synthetic study reports a biomarker increase.", assertionLogicalId: assertion.logicalId },
      ...(compound ? [{ quote: "No symptom improvement was reported.", assertionLogicalId: assertion.logicalId }] : []),
    ],
    recall: { label: "unmeasured", reason: "Offline synthetic fixture only." },
  });
  await research.coordinator.auditReport(scope, { runId, auditor });
  return {
    input: {
      report: registered.report,
      scope,
      research: {
        ...research,
        locator: {
          runOf: async (_scope: typeof scope, report: typeof registered.report) =>
            sameRef(report, registered.report) ? runId : null,
        },
      },
    },
    runId,
    backend,
  };
}

test("preview exposes genuine canonical pass/hold and exact actual differences without sealing or deciding", async () => {
  for (const compound of [false, true]) {
    const { input, runId } = await fixture(compound);
    const before = await input.research.binding.loadRunContext(input.scope, runId);
    const result = await qualiaAssessmentPreview(input);
    const after = await input.research.binding.loadRunContext(input.scope, runId);
    assert.deepEqual(after, before);
    assert.equal(after.head, null);
    assert.equal(result.admitted, false);
    assert.equal(result.qualified, false);
    assert.equal(result.dispatched, false);
    assert.equal(result.assessment.census.status, "assessed");
    if (result.assessment.census.status !== "assessed") throw new Error("Expected canonical census");
    assert.deepEqual(result.assessment.census.holds, compound ? ["unexplained_auditor_only", "screening_flag"] : []);
    assert.deepEqual(
      result.repairFeedback.unexplainedAuditorOnly.map((item) => item.quote),
      compound ? ["No symptom improvement was reported."] : [],
    );
    assert.equal(result.assessment.aggregate.complete, !compound, JSON.stringify(result.assessment.aggregate));
  }
});

for (const change of [
  "unknown",
  "digest",
  "scope",
  "locator",
  "assessment",
  "custody",
  "inventory-scope",
  "inventory-digest",
  "unknown-auditor-occurrence",
] as const) {
  test(`preview refuses ${change} exact-report/custody mismatch`, async () => {
    const { input } = await fixture(true);
    if (change === "unknown") input.report = { ...input.report, id: "unknown-report" };
    if (change === "digest") input.report = { ...input.report, digest: `sha256:${"f".repeat(64)}` };
    if (change === "scope") input.report = { ...input.report, tenant: "foreign" };
    if (change === "locator") input.research.locator.runOf = async () => "unknown-run";
    if (change === "assessment") {
      const assess = input.research.coordinator.assessReport.bind(input.research.coordinator);
      input.research.coordinator.assessReport = async (...args) => {
        const result = await assess(...args);
        return { ...result, report: { ...result.report, digest: `sha256:${"f".repeat(64)}` } };
      };
    }
    if (change === "custody") input.research.binding.custody.get = async () => Buffer.from("tampered");
    if (change === "inventory-scope" || change === "inventory-digest" || change === "unknown-auditor-occurrence") {
      const assess = input.research.coordinator.assessReport.bind(input.research.coordinator);
      input.research.coordinator.assessReport = async (...args) => {
        const result = structuredClone(await assess(...args));
        if (result.census.status !== "assessed") throw new Error("Expected actual test census");
        if (change === "inventory-scope") result.census.outcome.auditorInventory.tenant = "foreign";
        if (change === "inventory-digest") result.census.outcome.auditorInventory.digest = `sha256:${"f".repeat(64)}`;
        if (change === "unknown-auditor-occurrence")
          result.census.outcome.reconciliation.unexplainedAuditorOnly.push("unknown-actual-occurrence");
        return result;
      };
    }
    await assert.rejects(qualiaAssessmentPreview(input));
  });
}

const actualRun =
  process.env.QUALIA_ASSESSMENT_REPLAY ??
  resolve(import.meta.dirname, "../../../../../../mission-control/.scratch/qualia-stagegraph-2026-10-30/ecosystem-07");
test("retained real ecosystem-07 auditor payload reproduces the canonical compound-claim hold", {
  skip: !existsSync(resolve(actualRun, "ks-host.jsonl")),
}, async () => {
  const { preview, proof } = await replayQualiaAssessment(actualRun);
  assert.equal(proof.actualReport.id, "qualia48ab49ae-r2-r1");
  assert.deepEqual(proof.holds, ["unexplained_auditor_only", "screening_flag"]);
  assert.equal(proof.heldRequired.length, 8);
  assert.equal(preview.repairFeedback.unexplainedAuditorOnly.length, 12);
  assert.equal(preview.repairFeedback.screening.length, 5);
  assert.equal(proof.complete, false);
  assert.equal(proof.previewChangedRun, false);
  assert.ok(
    preview.repairFeedback.unexplainedAuditorOnly.some(
      (item) => item.quote === "Male aging symptoms did not significantly improve",
    ),
  );
});
