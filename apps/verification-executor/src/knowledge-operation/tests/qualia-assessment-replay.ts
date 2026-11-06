import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ReportKindCatalog, SourceAuthorityCatalog, type DiscoveryResult } from "@aiengineer/knowledge-application";
import { createInMemoryBackend } from "@aiengineer/knowledge-host/knowledge-operation";
import { EvaluationContextSchema, digestCanonical, sameRef, type Ref } from "@aiengineer/knowledge-operation-protocol";
import { VerificationObservationSchema, recordRef } from "@aiengineer/knowledge-research-core";
import type { prepareQualiaReport } from "./qualia-report.js";
import { qualiaAssessmentPreview } from "./qualia-assessment.js";

/** Recompute canonical assessment from real retained model payloads in an isolated memory store. No receipt/admission replay. */
export async function replayQualiaAssessment(runDirectory: string) {
  const rows = (await readFile(resolve(runDirectory, "ks-host.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { kind: string; value: unknown });
  const prepared = rows.filter((row) => row.kind === "prepared_registration").at(-1)?.value as
    | Awaited<ReturnType<typeof prepareQualiaReport>>
    | undefined;
  assert.ok(prepared, "Actual prepared report is required");
  const context = rows
    .filter((row) => row.kind === "evaluation_request")
    .map((row) => EvaluationContextSchema.parse((row.value as { context: unknown }).context))
    .filter((value) => value.role === "auditor")
    .at(-1);
  assert.ok(context, "Actual auditor context is required");
  const submissions = rows
    .filter((row) => row.kind === "actual_model_submission")
    .map(
      (row) =>
        row.value as {
          role: string;
          answer: unknown;
          payload: { report: Ref<"report">; observations: unknown[]; census: DiscoveryResult | null };
        },
    )
    .filter((value) => sameRef(value.payload.report, context.report));
  const judge = submissions.find((value) => value.role === "judge"),
    auditor = submissions.find((value) => value.role === "auditor");
  assert.ok(judge && auditor?.payload.census, "Both actual independent model payloads are required");
  const kinds = ReportKindCatalog.fromDirectory(
    resolve(import.meta.dirname, "../../../../../catalog/research/report-kinds"),
  );
  const authority = SourceAuthorityCatalog.fromDirectory(
    resolve(import.meta.dirname, "../../../../../catalog/research/source-authority"),
  );
  const backend = createInMemoryBackend({
    application: "biotech",
    binding: "biotech-graph",
    kinds,
    authority,
    auditor: null,
  });
  const research = backend.research();
  const origin = prepared.assertions[0]!.producer;
  const scope = {
    tenant: context.report.tenant,
    application: "biotech",
    binding: context.report.binding,
    origin,
    grants: [],
  };
  const { runId } = await research.coordinator.openRun(scope, { task: prepared.task, originatingOrigin: origin });
  await research.coordinator.registerEvidence(scope, prepared);
  const registered = await research.coordinator.registerReport(scope, {
    ...prepared.report,
    runId,
    kind: kinds.ref(scope, prepared.report.kind),
    assertions: prepared.assertions.map((assertion) => recordRef("assertion", assertion)),
  });
  assert.ok(
    sameRef(registered.report, context.report),
    "Recomputed revision must match the complete actual registered report ref",
  );
  assert.equal(registered.frozen.text, context.body.text);
  assert.equal(registered.frozen.bodyDigest, context.body.digest);
  const observations = judge.payload.observations.map((value) => VerificationObservationSchema.parse(value));
  for (const observation of observations) {
    await research.coordinator.observe(scope, runId, observation);
  }
  const census = auditor.payload.census;
  assert.ok(census.rawResponse);
  // Original rawResponse refs remain unchanged. Raw model JSON whitespace is not retained here; no replacement custody bytes are fabricated.
  // Reuses actual model discoveries verbatim; only the memory-store census observation is recomputed, never represented as a live receipt.
  await research.coordinator.auditReport(scope, { runId, auditor: { discover: async () => census } });
  const before = await research.binding.loadRunContext(scope, runId);
  const preview = await qualiaAssessmentPreview({
    report: context.report,
    scope,
    research: {
      ...research,
      locator: { runOf: async (_scope, report) => (sameRef(report, context.report) ? runId : null) },
    },
  });
  const after = await research.binding.loadRunContext(scope, runId);
  assert.equal(
    digestCanonical(JSON.parse(JSON.stringify(before))),
    digestCanonical(JSON.parse(JSON.stringify(after))),
    "Preview must not change the run or observations",
  );
  assert.equal(after.head, null);
  return {
    preview,
    proof: {
      schema: "qualia-assessment-offline-replay.v1",
      actualReport: context.report,
      originalModelPayloadsPreserved: true,
      rawResponseBytesReconstructed: false,
      canonicalCensusRecomputedOffline: true,
      reportRefExactlyMatched: true,
      previewChangedRun: false,
      admitted: false,
      qualified: false,
      graphWritten: false,
      holds: preview.assessment.census.status === "assessed" ? preview.assessment.census.holds : [],
      heldRequired: preview.assessment.aggregate.heldRequired,
      complete: preview.assessment.aggregate.complete,
      repairFeedback: preview.repairFeedback,
    },
  };
}
