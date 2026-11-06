import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { digestBytes } from "@aiengineer/knowledge-operation-protocol";
import { type AuthScope, qualifiersDigest, recordRef } from "@aiengineer/knowledge-research-core";
import { describe, expect, it } from "vitest";
import { ReportAssessmentError, ReportAssessmentService } from "./assessment.js";
import { ScriptedAuditorDiscovery } from "./auditor.js";
import { ResearchCoordinator } from "./coordinator.js";
import {
  AT,
  EVIDENCE_REPORT_SCRIPT,
  FIXTURE_SEAL_KEYS,
  fixtureAssertion,
  fixtureBody,
  fixtureFragment,
  fixtureOrigin,
  fixtureRef,
  fixtureSupportObservation,
  fixtureSupportSet,
  fixtureTask,
} from "./fixtures.js";
import { InMemoryResearchBinding } from "./in-memory.js";
import { OperationStoreError } from "./ports.js";
import { ReportKindCatalog } from "./report-kinds.js";

const TENANT = "00000000-0000-7000-8000-0000000000aa";
const BINDING = "in-memory";
const scope: AuthScope = {
  tenant: TENANT,
  application: "ai-engineer",
  binding: BINDING,
  origin: fixtureOrigin(TENANT),
  grants: ["research.write"],
};
let tick = 0;
const clock = { now: () => `2026-10-24T22:00:${String(tick++ % 60).padStart(2, "0")}Z` };
const KINDS = ReportKindCatalog.fromDirectory(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../../../catalog/research/report-kinds"),
);

async function prepared(options: { judge?: boolean } = {}) {
  const binding = new InMemoryResearchBinding("in-memory", { sealVerifier: FIXTURE_SEAL_KEYS.verifier });
  const coordinator = new ResearchCoordinator(binding, clock, KINDS, { signer: FIXTURE_SEAL_KEYS.signer });
  const origin = fixtureOrigin(TENANT);
  const { runId } = await coordinator.openRun(scope, { task: fixtureTask(TENANT, BINDING), originatingOrigin: origin });
  const fragment = fixtureFragment(TENANT, BINDING);
  const assertion = fixtureAssertion(TENANT, BINDING, origin);
  const set = fixtureSupportSet(TENANT, BINDING, assertion, fragment);
  await coordinator.registerEvidence(scope, { fragments: [fragment], assertions: [assertion], supportSets: [set] });
  const registered = await coordinator.registerReport(scope, {
    runId,
    reportId: "report-op",
    revision: 1,
    kind: KINDS.ref(scope, "evidence_report"),
    structuredBody: fixtureBody(assertion, fragment),
    assertions: [recordRef("assertion", assertion)],
    timeCoverage: { world: null, observed: { from: AT, to: AT }, knowledgeHead: null },
    supersedes: null,
  });
  if (options.judge !== false) {
    await coordinator.observe(
      scope,
      runId,
      fixtureSupportObservation({
        tenant: TENANT,
        binding: BINDING,
        id: "obs-judge",
        set,
        fragment,
        role: "judge",
        verdict: "full_support",
        qualifiersDigest: qualifiersDigest(assertion.qualifiers),
      }),
    );
  }
  const auditor = new ScriptedAuditorDiscovery(EVIDENCE_REPORT_SCRIPT);
  const service = new ReportAssessmentService({
    binding,
    coordinator,
    operations: binding.operations,
    auditor,
    clock,
    retryAfterMs: 5,
  });
  return { binding, coordinator, service, auditor, runId, registered };
}

describe("async report.assess operation (design §4)", () => {
  it("returns a K01 handle, is idempotent by request id and refuses the same request id with other input", async () => {
    const { service, runId, registered } = await prepared();
    const handle = await service.start(scope, { runId, reportRef: registered.report, requestId: "req-1" });
    expect(handle).toMatchObject({
      protocolVersion: "ks.knowledge_operation.v2",
      tenant: TENANT,
      application: "ai-engineer",
      binding: BINDING,
    });
    expect(await service.start(scope, { runId, reportRef: registered.report, requestId: "req-1" })).toEqual(handle);
    const status = await service.status(scope, handle);
    // Bounded polling hint: the configured 5 ms is clamped to K01's 100 ms floor.
    expect(status).toMatchObject({ state: "queued", revision: 1, retryAfterMs: 100, cancelRequestId: null });
    await expect(
      service.start(scope, {
        runId,
        reportRef: { ...registered.report, digest: digestBytes("other revision") },
        requestId: "req-1",
      }),
    ).rejects.toMatchObject({ code: "REPORT_MISMATCH" });
    await expect(service.status({ ...scope, tenant: "00000000-0000-7000-8000-0000000000bb" }, handle)).rejects.toThrow(
      ReportAssessmentError,
    );
  });

  it("runs audit + aggregation to a terminal domain outcome with a monotonic revision; rerun is a no-op", async () => {
    const held = await prepared({ judge: false });
    const handle = await held.service.start(scope, {
      runId: held.runId,
      reportRef: held.registered.report,
      requestId: "req-held",
    });
    const terminal = await held.service.run(scope, handle);
    // No judge observation: missing evidence is not a contradiction -> held (a domain outcome, not a failure).
    expect(terminal).toMatchObject({ state: "held", revision: 3, retryAfterMs: null, error: null });
    expect(held.binding.assessments.get(`assessment-${handle.operationId}`)?.record).toMatchObject({
      outcome: "held",
      runId: held.runId,
      report: held.registered.report,
      kind: held.registered.revision.kind,
    });
    expect(terminal.resultRef?.kind).toBe("artifact");
    expect(await held.service.run(scope, handle)).toEqual(terminal);
    expect(held.auditor.calls).toHaveLength(1);
    const done = await prepared();
    const ok = await done.service.run(
      scope,
      await done.service.start(scope, { runId: done.runId, reportRef: done.registered.report, requestId: "req-ok" }),
    );
    expect(ok).toMatchObject({ state: "partial", revision: 3 });
    const result = JSON.parse(
      Buffer.from(await done.binding.custody.get(scope, ok.resultRef as never)).toString("utf8"),
    ) as { aggregate: { complete: boolean }; census: { status: string } };
    expect(result).toMatchObject({ aggregate: { complete: true }, census: { status: "assessed" } });
  });

  it("refuses illegal transitions and stale revisions (compare-and-set)", async () => {
    const { binding, service, runId, registered } = await prepared();
    const handle = await service.start(scope, { runId, reportRef: registered.report, requestId: "req-cas" });
    const store = binding.operations;
    await expect(
      store.transition(scope, { operationId: handle.operationId, expectedRevision: 1, to: "succeeded", at: AT }),
    ).rejects.toMatchObject({ code: "ILLEGAL_TRANSITION" });
    await store.transition(scope, { operationId: handle.operationId, expectedRevision: 1, to: "running", at: AT });
    await expect(
      store.transition(scope, { operationId: handle.operationId, expectedRevision: 1, to: "running", at: AT }),
    ).rejects.toBeInstanceOf(OperationStoreError);
    await expect(
      store.transition(scope, { operationId: handle.operationId, expectedRevision: 2, to: "waiting_review", at: AT }),
    ).rejects.toThrow(); // waiting_review must name its pending review
  });

  it("cancels idempotently by request id: queued cancels at once, repeats change nothing", async () => {
    const { service, runId, registered, auditor } = await prepared();
    const handle = await service.start(scope, { runId, reportRef: registered.report, requestId: "req-c1" });
    const cancelled = await service.cancel(scope, handle, "cancel-1");
    expect(cancelled).toMatchObject({
      state: "cancelled",
      revision: 2,
      cancelRequestId: "cancel-1",
      retryAfterMs: null,
    });
    expect(await service.cancel(scope, handle, "cancel-1")).toEqual(cancelled);
    expect(await service.cancel(scope, handle, "cancel-2")).toEqual(cancelled);
    expect(await service.run(scope, handle)).toEqual(cancelled);
    expect(auditor.calls).toHaveLength(0);
  });

  it("cancel during waiting_review moves to cancelling, then the runner stops new work and settles cancelled", async () => {
    const { binding, service, runId, registered, auditor } = await prepared();
    const handle = await service.start(scope, { runId, reportRef: registered.report, requestId: "req-review" });
    const store = binding.operations;
    await store.transition(scope, { operationId: handle.operationId, expectedRevision: 1, to: "running", at: AT });
    const review = fixtureRef("adjudication", "adj-1", TENANT, BINDING, "research-core.adjudication.v1");
    await store.transition(scope, {
      operationId: handle.operationId,
      expectedRevision: 2,
      to: "waiting_review",
      at: AT,
      pendingReviewRef: review,
    });
    expect(await service.run(scope, handle)).toMatchObject({ state: "waiting_review", pendingReviewRef: review });
    const cancelling = await service.cancel(scope, handle, "cancel-review");
    expect(cancelling).toMatchObject({ state: "cancelling", revision: 4, cancelRequestId: "cancel-review" });
    expect(cancelling.retryAfterMs).not.toBeNull();
    expect(await service.cancel(scope, handle, "cancel-again")).toEqual(cancelling);
    const settled = await service.run(scope, handle);
    expect(settled).toMatchObject({ state: "cancelled", revision: 5, cancelRequestId: "cancel-review" });
    expect(auditor.calls).toHaveLength(0);
  });

  it("a post-freeze body edit rejects the assessment with a typed exact-revision error", async () => {
    const { binding, service, runId, registered } = await prepared();
    const key = `${TENANT}/${registered.revision.body.id}`;
    const stored = binding.custody.artifacts.get(key);
    if (stored === undefined) throw new Error("fixture");
    binding.custody.artifacts.set(key, { ...stored, bytes: new TextEncoder().encode("edited") });
    const handle = await service.start(scope, { runId, reportRef: registered.report, requestId: "req-edit" });
    const status = await service.run(scope, handle);
    expect(status.state).toBe("rejected");
    expect(status.error).toMatchObject({ code: "EXACT_REVISION_UNAVAILABLE", domainOutcome: true, retryable: false });
  });
});
