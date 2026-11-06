import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { type Ref, digestBytes, sameRef } from "@aiengineer/knowledge-operation-protocol";
import {
  AssertionVersionSchema,
  EvidenceFragmentSchema,
  ReportRevisionSchema,
  SupportSetSchema,
  VerificationObservationSchema,
  buildLedger,
  recordRef,
  renderReport,
} from "@aiengineer/knowledge-research-core";
import type { CapturedSource } from "./qualia-captures.js";
import {
  hydrateQualiaFrozenReport,
  retainQualiaFragmentBinding,
  type QualiaFragmentCaptureBinding,
} from "./qualia-frozen.js";
import type { prepareQualiaReport } from "./qualia-report.js";

/** Offline replay only: every reconstructed byte/record must match an actually retained immutable ref. */
export async function replayQualiaFrozenReport(runDirectory: string, sourceMapPath: string, outputPath: string) {
  type Row = { kind: string; at: string; value: unknown };
  const rows = (await readFile(resolve(runDirectory, "ks-host.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Row);
  const prepared = rows.find((row) => row.kind === "prepared_registration")?.value as
    | Awaited<ReturnType<typeof prepareQualiaReport>>
    | undefined;
  const requests = rows
    .filter((row) => row.kind === "evaluation_request")
    .map(
      (row) =>
        row.value as {
          context: {
            role: string;
            report: Ref<"report">;
            kind: Ref<"report_kind">;
            body: { artifact: Ref<"artifact">; text: string };
            evidence: { handle: Ref<"fragment">; record: unknown }[];
            assertions: { handle: Ref<"assertion">; record: unknown }[];
            supportSets: { handle: Ref<"support_set">; record: unknown }[];
          };
        },
    );
  const context = requests.find((request) => request.context.role === "judge")?.context;
  assert.ok(prepared && context, "Actual registration and judge request must be retained");
  const actualReport = (
    rows.find(
      (row) =>
        row.kind === "call_result" && (row.value as { nativeReceiptRef?: Ref }).nativeReceiptRef?.kind === "report",
    )?.value as { nativeReceiptRef: Ref<"report"> } | undefined
  )?.nativeReceiptRef;
  assert.ok(
    actualReport && sameRef(actualReport, context.report),
    "Actual registered report receipt and evaluation request must agree",
  );
  const artifacts = new Map<string, Uint8Array>();
  const artifact = (bytes: Uint8Array): Ref<"artifact"> => {
    const digest = digestBytes(bytes);
    artifacts.set(digest, bytes);
    return {
      kind: "artifact",
      id: `artifact-${digest.slice(7, 31)}`,
      version: "artifact.v1",
      digest,
      tenant: actualReport.tenant,
      binding: actualReport.binding,
    };
  };
  const frozen = renderReport(prepared.report.structuredBody);
  const body = artifact(Buffer.from(context.body.text));
  assert.ok(sameRef(body, context.body.artifact), "Retained rendered body must recover exact custody bytes");
  assert.equal(body.digest, frozen.bodyDigest);
  const ledger = buildLedger({
    frozen,
    body,
    id: `${actualReport.id}-ledger`,
    tenant: actualReport.tenant,
    binding: actualReport.binding,
  });
  const revision = ReportRevisionSchema.parse({
    schemaVersion: "research-report.v2",
    id: actualReport.id,
    tenant: actualReport.tenant,
    binding: actualReport.binding,
    kind: context.kind,
    task: recordRef("task", prepared.task),
    structuredBody: artifact(Buffer.from(JSON.stringify(prepared.report.structuredBody))),
    body,
    bodyDigest: frozen.bodyDigest,
    renderer: frozen.renderer,
    normalization: frozen.normalization,
    ledger: artifact(Buffer.from(JSON.stringify(ledger))),
    assertions: prepared.assertions.map((record) => recordRef("assertion", record)),
    timeCoverage: prepared.report.timeCoverage,
    derivationCandidates: [],
    supersedes: prepared.report.supersedes,
  });
  assert.ok(
    sameRef(recordRef("report", revision), actualReport),
    "Reconstructed revision must equal actual registered full report ref",
  );
  const assertions = context.assertions.map(({ handle, record }) => {
    const parsed = AssertionVersionSchema.parse(record);
    assert.ok(sameRef(handle, recordRef("assertion", parsed)));
    return parsed;
  });
  const supportSets = context.supportSets.map(({ handle, record }) => {
    const parsed = SupportSetSchema.parse(record);
    assert.ok(sameRef(handle, recordRef("support_set", parsed)));
    return parsed;
  });
  const fragments = context.evidence.map(({ handle, record }) => {
    const parsed = EvidenceFragmentSchema.parse(record);
    assert.ok(sameRef(handle, recordRef("fragment", parsed)));
    return parsed;
  });
  const submissions = rows
    .filter((row) => row.kind === "actual_model_submission")
    .map((row) => row.value as { role: string; answer: unknown; payload: { observations: unknown[] } });
  const observations = submissions.flatMap((submission) =>
    submission.payload.observations.map((value) => {
      const observation = VerificationObservationSchema.parse(value);
      if (observation.rawResponse)
        assert.ok(
          sameRef(artifact(Buffer.from(JSON.stringify(submission.answer))), observation.rawResponse),
          "Recovered model answer bytes must match actual rawResponse custody ref",
        );
      return observation;
    }),
  );
  const sourceRows = JSON.parse(await readFile(sourceMapPath, "utf8")) as {
    captureId: string;
    url: string;
    title: string;
    text: string;
  }[];
  const captureRows = rows
    .filter((row) => row.kind === "capture")
    .map((row) => ({ at: row.at, ...(row.value as { captureId: string; sourceUrl: string; ref: Ref<"artifact"> }) }));
  const sources: CapturedSource[] = sourceRows.map((source) => {
    const matches = captureRows.filter((row) => row.captureId === source.captureId && row.sourceUrl === source.url);
    const retained = matches[0];
    assert.ok(
      retained && matches.every((row) => sameRef(row.ref, retained.ref)),
      "Host capture identity must retain one actual custody ref",
    );
    assert.ok(
      sameRef(artifact(Buffer.from(source.text)), retained.ref),
      "Recovered source bytes must match actual host custody ref",
    );
    return { ...source, ref: retained.ref, retrievedAt: retained.at };
  });
  const fragmentBindings = new Map<string, QualiaFragmentCaptureBinding>();
  for (const fragment of fragments) {
    const matches = sources.filter((source) => sameRef(source.ref, fragment.capture));
    assert.equal(matches.length, 1, "Replay requires an unambiguous actual capture binding");
    retainQualiaFragmentBinding(fragmentBindings, recordRef("fragment", fragment), matches[0]!);
  }
  const input: Parameters<typeof hydrateQualiaFrozenReport>[0] = {
    report: actualReport,
    context: { report: { revision, ledger }, assertions, supportSets, observations },
    sources,
    fragmentBindings,
    loadFragments: async () => fragments,
    readArtifact: async (ref) => {
      const bytes = artifacts.get(ref.digest);
      assert.ok(bytes, "Unknown custody ref in actual replay");
      return bytes;
    },
  };
  const hydrated = await hydrateQualiaFrozenReport(input);
  // Independently tamper an actual referenced contextual fragment; refusal must precede native mapping.
  const contextual = hydrated.assertions.find((assertion) =>
    assertion.observedEvidence.some(
      (ref) => !assertion.declaredEvidence.some((declared) => declared.fragmentDigest === ref.fragmentDigest),
    ),
  );
  assert.ok(contextual, "Actual retained case must exercise report-wide contextual evidence");
  const original = input.context.observations;
  const supportObservation = original.find(
    (observation) =>
      observation.property === "support" && contextual.judgments.some((judgment) => judgment.id === observation.id),
  );
  assert.ok(supportObservation?.property === "support");
  const negatives: string[] = [];
  for (const kind of [
    "unknown-ref",
    "altered-digest",
    "foreign-scope",
    "changed-target",
    "changed-qualifiers",
    "missing-binding",
    "tampered-custody",
  ] as const) {
    const changed = structuredClone(supportObservation);
    const ref = { ...changed.evidence[0]! };
    if (kind === "unknown-ref") ref.id += "-unknown";
    if (kind === "altered-digest") ref.digest = `sha256:${"f".repeat(64)}`;
    if (kind === "foreign-scope") ref.tenant += "-foreign";
    if (["unknown-ref", "altered-digest", "foreign-scope"].includes(kind)) changed.evidence = [ref];
    if (kind === "changed-target") changed.target = { ...changed.target, digest: `sha256:${"f".repeat(64)}` };
    if (kind === "changed-qualifiers") changed.qualifiersDigest = `sha256:${"f".repeat(64)}`;
    const selected = contextual.observedEvidence.find(
      (item) => !contextual.declaredEvidence.some((declared) => declared.fragmentDigest === item.fragmentDigest),
    )!;
    const bindings = new Map(fragmentBindings);
    if (kind === "missing-binding") bindings.delete(selected.fragmentDigest);
    const broken = {
      ...input,
      fragmentBindings: bindings,
      context: {
        ...input.context,
        observations: original.map((observation) => (observation.id === changed.id ? changed : observation)),
      },
      ...(kind === "tampered-custody" ? { readArtifact: async () => Buffer.from("tampered") } : {}),
    };
    await assert.rejects(hydrateQualiaFrozenReport(broken));
    negatives.push(kind);
  }
  const proof = {
    schema: "qualia-frozen-offline-replay.v1",
    admitted: false,
    qualified: false,
    graphWritten: false,
    report: actualReport,
    capturedSources: sources.length,
    frozenFragments: fragments.length,
    actualObservations: observations.length,
    assertions: hydrated.assertions.map((assertion) => ({
      id: assertion.id,
      declared: assertion.declaredEvidence.map((item) => item.fragmentId),
      observed: assertion.observedEvidence.map((item) => item.fragmentId),
      contextual: assertion.observedEvidence
        .filter(
          (item) => !assertion.declaredEvidence.some((declared) => declared.fragmentDigest === item.fragmentDigest),
        )
        .map((item) => item.fragmentId),
      judgmentIds: assertion.judgments.map((judgment) => judgment.id),
    })),
    refusedTampering: negatives,
  };
  await writeFile(outputPath, `${JSON.stringify(proof, null, 2)}\n`);
  return proof;
}

if (process.argv[1]?.endsWith("qualia-frozen-replay.ts")) {
  const [runDirectory, sourceMapPath, outputPath] = process.argv.slice(2);
  if (!runDirectory || !sourceMapPath || !outputPath)
    throw new Error("Usage: qualia-frozen-replay.ts RUN_DIRECTORY SOURCE_MAP_PATH OUTPUT_PATH (offline only)");
  const proof = await replayQualiaFrozenReport(runDirectory, sourceMapPath, outputPath);
  console.log(
    JSON.stringify({
      report: proof.report.id,
      actualObservations: proof.actualObservations,
      assertions: proof.assertions.length,
      negatives: proof.refusedTampering.length,
      outputPath,
    }),
  );
}
