import {
  DecisionResolutionSchema,
  EvaluationContextSchema,
  ReportObservationRequestSchema,
  ReportSealRequestSchema,
  ReportUseRequestSchema,
  type Origin,
  type Ref,
} from "@aiengineer/knowledge-operation-protocol";
import { normalizedValuesDigest } from "@aiengineer/knowledge-research-core";
import { biotechEffect, reportPublishFields } from "@aiengineer/knowledge-binding-biotech-graph";
import type { FrozenQualiaReport } from "./qualia-frozen.js";

/** Host adapter owns K07 credentials and real invoke/poll/result-byte verification. This helper grants no authority. */
export interface QualiaK01Host {
  call(input: {
    actor: "producer" | "judge" | "auditor";
    operation: string;
    nativeContract: { name: string; version: string };
    payload: unknown;
    requestId: string;
    upstream?: Ref[];
    effectKey?: string;
    boundEffectDigest?: string;
  }): Promise<Record<string, unknown>>;
  /** Load actual immutable revision/custody from registered service records, never reconstruct from producer output. */
  frozenReport(report: Ref<"report">): Promise<FrozenQualiaReport>;
  /** Persist exact response bytes/receipts and model usage locally; do not commit runtime receipts. */
  record(kind: string, value: unknown): Promise<void>;
}
export interface QualiaEvaluator {
  origin: Origin;
  model: "gpt-6.1-sol" | "gpt-6.1-terra";
  /** Actual isolated model invocation. Auditor receives only its served context (no producer ledger/support map). */
  evaluate(
    context: unknown,
  ): Promise<{ observations: unknown[]; census: unknown | null; usage: unknown; rawResponse: string }>;
}

export function assertSeparateEvaluator(producer: Origin, evaluator: QualiaEvaluator): void {
  if (!["gpt-6.1-sol", "gpt-6.1-terra"].includes(evaluator.model))
    throw new Error("Owner allows only GPT-6.1 Sol/Terra");
  if (
    producer.subject === evaluator.origin.subject ||
    (producer.mission !== null &&
      evaluator.origin.mission !== null &&
      producer.mission.missionId === evaluator.origin.mission.missionId &&
      producer.mission.operationId === evaluator.origin.mission.operationId)
  )
    throw new Error("Evaluator must have its own authenticated subject and mission operation");
}

/**
 * Compose existing native KS authority, distinct from MC's cross-vendor trusted-assessment qualification.
 * No result defaults to admitted; a held/refused decision returns without graph dispatch. An adapter can pause
 * evaluate() for a JSON-lines/HTTP model worker, persist its real answer, then resume this exact sequence.
 */
export async function runQualiaEvidence(input: {
  host: QualiaK01Host;
  prefix: string;
  producer: Origin;
  registration: Record<string, unknown>;
  judge: QualiaEvaluator;
  auditor: QualiaEvaluator;
  makeIntent(frozen: FrozenQualiaReport): Promise<Record<string, unknown>>;
  use: string;
  audience: string;
  policy: Ref<"policy">;
  rubric: Ref<"rubric">;
  build: { buildId: string; runtime: string; dirty: boolean };
  consumeAndVerify(effectKey: string): Promise<unknown>;
}) {
  assertSeparateEvaluator(input.producer, input.judge);
  assertSeparateEvaluator(input.producer, input.auditor);
  if (input.judge.origin.subject === input.auditor.origin.subject)
    throw new Error("Judge and auditor require separate authenticated subjects");
  const host = input.host;
  const call = async (
    actor: "producer" | "judge" | "auditor",
    operation: string,
    name: string,
    payload: unknown,
    suffix: string,
    extra: Partial<Parameters<QualiaK01Host["call"]>[0]> = {},
  ) => {
    const answer = await host.call({
      actor,
      operation,
      nativeContract: { name, version: "v1" },
      payload,
      requestId: `${input.prefix}:${suffix}`,
      ...extra,
    });
    await host.record(operation, answer);
    return answer;
  };
  const registered = await call("producer", "report.register", "research-report", input.registration, "register", {
    nativeContract: { name: "research-report", version: "v2" },
  });
  const report = registered.nativeReceiptRef as Ref<"report">;
  if (!report || report.kind !== "report" || typeof report.digest !== "string")
    throw new Error("Real report registration returned no immutable report reference");
  const frozen = await host.frozenReport(report);
  const intent = await input.makeIntent(frozen);
  // Exact frozen fields, no look-alike report supplied by a producer.
  const proposals = intent.proposals as Record<string, unknown>[];
  const publish = proposals?.filter((p) => p.kind === "report.publish");
  if (publish?.length !== 1 || Object.entries(reportPublishFields(frozen)).some(([k, v]) => publish[0]?.[k] !== v))
    throw new Error("Native report differs from actual frozen KS revision");
  const effect = biotechEffect(intent, input.producer);
  await host.record("native_intent", {
    intent,
    ...effect,
    nativeBytes: Buffer.from(effect.nativeBytes).toString("utf8"),
  });
  for (const role of ["judge", "auditor"] as const) {
    const context = EvaluationContextSchema.parse(
      await call(
        role,
        "knowledge.read",
        "evaluation-context-read",
        { schema: "evaluation-context-read.v1", report },
        `${role}-context`,
        { upstream: [report] },
      ),
    );
    if (context.role !== role || context.report.digest !== report.digest)
      throw new Error("Evaluator context role or revision mismatch");
    const result = await input[role].evaluate(context);
    await host.record(`${role}_model`, { model: input[role].model, origin: input[role].origin, ...result });
    if (!result.rawResponse || result.usage === null || result.usage === undefined)
      throw new Error("Actual evaluator response and usage are required");
    const observations = ReportObservationRequestSchema.parse({
      schema: "report-observation.v1",
      report,
      observations: result.observations,
      census: result.census,
    });
    await call(role, "report.observe", "report-observation", observations, `${role}-observe`, { upstream: [report] });
  }
  await call(
    "producer",
    "report.seal",
    "report-seal",
    ReportSealRequestSchema.parse({ schema: "report-seal.v1", report, build: input.build }),
    "seal",
    { upstream: [report] },
  );
  const normalizedValues = {};
  const decision = await call(
    "producer",
    "report.decide",
    "report-use",
    ReportUseRequestSchema.parse({
      schema: "report-use.v1",
      report,
      subject: report,
      use: input.use,
      audience: input.audience,
      purpose: "official",
      boundEffectDigest: effect.boundEffectDigest,
      targetSchema: "biotech-knowledge-intent.v2",
      normalizedValues,
      policy: input.policy,
      rubric: input.rubric,
      expiresAt: null,
    }),
    "decide",
    { upstream: [report] },
  );
  const ref = decision.decision as Ref<"use_decision">;
  if (!ref || ref.kind !== "use_decision") throw new Error("Actual KS decision missing");
  const resolved = DecisionResolutionSchema.parse(
    await call(
      "producer",
      "decision.resolve",
      "decision-resolve",
      { schema: "decision-resolve.v1", decision: ref },
      "resolve",
    ),
  );
  if (resolved.report.digest !== report.digest || resolved.subject.digest !== report.digest)
    throw new Error("Resolved decision names another report");
  if (resolved.disposition !== "admitted" || resolved.admissibility.status !== "admitted" || resolved.reviewPending)
    return { report, decision: resolved, dispatched: false, qualified: false };
  const effectKey = `${input.prefix}:native`;
  const admitted = await call(
    "producer",
    "knowledge.apply",
    "biotech-knowledge-apply",
    {
      schemaVersion: "biotech-knowledge-apply.v1",
      intent,
      exactUse: {
        useDecisionId: resolved.current.id,
        processedEpoch: resolved.revocationEpoch,
        normalizedValuesDigest: normalizedValuesDigest(normalizedValues),
      },
    },
    "apply",
    { effectKey, boundEffectDigest: effect.boundEffectDigest, upstream: [report] },
  );
  const native = await input.consumeAndVerify(effectKey);
  await host.record("native_readback", native);
  return { report, decision: resolved, admission: admitted, native, dispatched: true, qualified: false };
}
