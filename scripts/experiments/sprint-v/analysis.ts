import { createHash } from "node:crypto";
import type { Labels } from "./fixtures.js";
import type { CallRecord } from "./providers.js";

/**
 * SV-09 analysis, PREREGISTERED: this plan is written (with its digest) into the run directory before the first
 * provider call of a run, and `computeAnalysis` computes exactly these quantities afterwards. Everything here is a
 * control-slice measurement against synthetic labels the fixture author wrote; no line is an evaluator-quality,
 * calibration or operational-readiness claim. `calibrated` and `qualityValidated` are always false.
 */
export const ANALYSIS_PLAN = {
  schemaVersion: "sv09-analysis-plan.v1",
  flags: { calibrated: false, qualityValidated: false, labels: "synthetic, fixture-author, not independent human" },
  perChain: [
    "chain ids: t0 (recorded producer + recorded/scripted evaluators), producer (live producer, live evaluators), reference (locked reference draft, live evaluators)",
    "compile issues of the producer draft by code (quote_not_found, quote_not_unique, invalid_assertion, ...)",
    "report registration outcome (registered | SCHEMA_UNSUPPORTED with violations)",
    "support verdict per support set and role; coercions applied when mapping a model verdict to the K02 schema",
    "census status and hold reasons; discovered occurrence count; quotes dropped (not verbatim in their unit)",
    "aggregate: covered weight / total, unmet/held/rejecting required obligations, holds by reason, authority gate applied",
    "report.assess operation terminal state",
    "report use decision disposition and conditions; assertion use decision disposition per assertion",
    "derive: proposal count, held items by reason",
    "native admission per decision: path (component_only | aidb_guard), admitted | refused with typed code, receipt digest, native rows written",
    "exact package read: every digest check, package digest",
  ],
  againstLabels: [
    "obligation agreement: for each labeled obligation (supported | must_hold), whether the chain's obligation status matches (supported -> covered; must_hold -> not covered); counts n/d per chain, no rate claimed beyond n/d",
    "assertion-decision agreement: assertions whose obligations are labeled supported -> admitted; must_hold -> held or rejected; counts n/d",
    "report decision within the labeled expected set (expectedReportDecision)",
    "census recall (reference and t0 chains only, locked body): labeled occurrences overlapped by a discovered occurrence in the same unit path / labeled occurrences; the uncited-heading label reported separately",
    "census extra discoveries: discovered occurrences overlapping no labeled occurrence (count; not called false positives)",
    "required unit explanations given (study_appraisal): expected paths explained / expected paths",
    "appraisal judgments within the labeled allowed set (study_appraisal, producer chain): n/d",
    "judge vs second-family judge verdict-class agreement on the same support sets (reference chain): accepting vs non-accepting, n/d; INDEPENDENCE_UNPROVEN",
  ],
  spend: [
    "per call: provider, requested and response model id, role, latency ms, input/cached/output/reasoning tokens, cost USD (usage-based, or explicit estimate), planned maximum reserved",
    "totals by role and provider; total spend; ceiling 6.00 USD; blocked:budget count",
  ],
  stopRules: [
    "T0 must pass end to end (every t0Expected label) before any paid call",
    "a reservation that could exceed the ceiling is blocked:budget and recorded, never skipped",
    "one producer retry at most per task when the first draft is unparseable",
  ],
} as const;

export function planDigest(): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(ANALYSIS_PLAN)).digest("hex")}`;
}

export interface ChainResult {
  chain: "t0" | "producer" | "reference";
  installation: string;
  kind: "evidence_report" | "study_appraisal";
  runId: string | null;
  compileIssues: { assertion: string | null; code: string; detail: string }[];
  registration: { ok: boolean; code?: string; violations?: readonly string[] };
  keyObligations: Record<string, string[]>;
  judgments: {
    set: string;
    assertionKey: string;
    role: string;
    verdict: string | null;
    coercions: string[];
    callId: string | null;
    blocked: string | null;
  }[];
  census: {
    status: string;
    holds: readonly string[];
    discovered: { path: string; text: string; assertion: string | null; negated: boolean }[];
    unitExplanations: { path: string; reason: string }[];
    dropped: number;
    auditor: string;
  } | null;
  aggregate: Record<string, unknown> | null;
  obligationStatus: Record<string, string>;
  assessmentState: string | null;
  reportDecision: { id: string; disposition: string; conditions: readonly string[] } | null;
  assertionDecisions: { key: string; id: string; disposition: string; conditions: readonly string[] }[];
  appraisalJudgments: Record<string, string | null>;
  derive: { proposals: number; held: { assertion: string; reason: string }[] } | null;
  native: {
    subject: string;
    decisionId: string;
    disposition: string;
    outcome: "admitted" | "refused" | "skipped";
    path: string | null;
    code: string | null;
    receiptDigest: string | null;
    rows: number;
  }[];
  exactRead: { ok: boolean; packageDigest: string | null; checks: Record<string, boolean> } | null;
  errors: string[];
}

const overlaps = (a: string, b: string) => a.includes(b) || b.includes(a);

export function computeAnalysis(input: {
  chains: readonly ChainResult[];
  labels: Readonly<Record<string, Labels>>;
  calls: readonly CallRecord[];
}) {
  const perChain = input.chains.map((chain) => {
    const labels = input.labels[chain.kind] as Labels;
    const labeled = Object.entries(labels.obligations).filter(([, label]) => label.expected !== "optional");
    const obligationAgreement = labeled.filter(([id, label]) => {
      const status = chain.obligationStatus[id];
      return label.expected === "supported" ? status === "covered" : status !== undefined && status !== "covered";
    }).length;
    const assertionAgreement = chain.assertionDecisions.filter((decision) => {
      const obligations = chain.keyObligations[decision.key] ?? [];
      const expected = obligations.map((id) => labels.obligations[id]?.expected).find((value) => value !== "optional");
      if (expected === undefined) return false;
      return expected === "supported" ? decision.disposition === "admitted" : decision.disposition !== "admitted";
    }).length;
    const lockedBody = chain.chain !== "producer";
    const census = chain.census;
    const recall =
      lockedBody && census
        ? labels.census.occurrences.map((occurrence) => ({
            id: occurrence.id,
            path: occurrence.path,
            found: census.discovered.some((d) => d.path === occurrence.path && overlaps(d.text, occurrence.quote)),
            note: occurrence.note,
          }))
        : null;
    const extra =
      lockedBody && census
        ? census.discovered.filter(
            (d) => !labels.census.occurrences.some((o) => o.path === d.path && overlaps(d.text, o.quote)),
          ).length
        : null;
    const unitExplained = census
      ? labels.census.expectedUnitExplanations.filter((path) => census.unitExplanations.some((u) => u.path === path))
          .length
      : 0;
    const judgmentAgreement = Object.entries(chain.appraisalJudgments).map(([obligation, judgment]) => ({
      obligation,
      judgment,
      allowed: labels.obligations[obligation]?.judgments ?? null,
      within: judgment !== null && (labels.obligations[obligation]?.judgments ?? []).includes(judgment),
    }));
    const accepting = (verdict: string | null) => verdict === "full_support" || verdict === "qualified_support";
    const bySet = new Map<string, Record<string, string | null>>();
    for (const judgment of chain.judgments) {
      bySet.set(judgment.set, { ...(bySet.get(judgment.set) ?? {}), [judgment.role]: judgment.verdict });
    }
    const paired = [...bySet.values()].filter((v) => v.judge !== undefined && v.second_family_judge !== undefined);
    return {
      chain: chain.chain,
      kind: chain.kind,
      installation: chain.installation,
      registration: chain.registration,
      compileIssuesByCode: chain.compileIssues.reduce<Record<string, number>>((acc, issue) => {
        acc[issue.code] = (acc[issue.code] ?? 0) + 1;
        return acc;
      }, {}),
      obligationAgreement: `${obligationAgreement}/${labeled.length}`,
      assertionDecisionAgreement: `${assertionAgreement}/${chain.assertionDecisions.length}`,
      reportDecision: chain.reportDecision?.disposition ?? null,
      reportDecisionWithinLabels: chain.reportDecision
        ? labels.expectedReportDecision.includes(chain.reportDecision.disposition)
        : false,
      holdsByReason: (chain.aggregate?.holdsByReason as Record<string, number> | undefined) ?? null,
      censusHolds: census?.holds ?? null,
      censusRecall: recall ? `${recall.filter((r) => r.found).length}/${recall.length}` : null,
      censusRecallDetail: recall,
      censusExtraDiscoveries: extra,
      censusDroppedQuotes: census?.dropped ?? null,
      unitExplanationsGiven: `${unitExplained}/${labels.census.expectedUnitExplanations.length}`,
      appraisalJudgments: judgmentAgreement,
      judgeVsSecondFamily: paired.length
        ? {
            acceptingClassAgreement: `${paired.filter((v) => accepting(v.judge ?? null) === accepting(v.second_family_judge ?? null)).length}/${paired.length}`,
            exactVerdictAgreement: `${paired.filter((v) => v.judge === v.second_family_judge).length}/${paired.length}`,
            independence: "INDEPENDENCE_UNPROVEN (vendor difference is a diversity control)",
          }
        : null,
      native: chain.native.map((n) => ({
        subject: n.subject,
        outcome: n.outcome,
        path: n.path,
        code: n.code,
        rows: n.rows,
      })),
      exactRead: chain.exactRead,
      errors: chain.errors,
    };
  });
  const byRole: Record<string, { calls: number; usd: number; latencyMs: number[]; tokens: number }> = {};
  for (const call of input.calls) {
    const entry = byRole[`${call.provider}:${call.role}`] ?? { calls: 0, usd: 0, latencyMs: [], tokens: 0 };
    entry.calls += 1;
    entry.usd += call.costUsd;
    entry.latencyMs.push(call.latencyMs);
    entry.tokens += call.usage.inputTokens + call.usage.outputTokens;
    byRole[`${call.provider}:${call.role}`] = entry;
  }
  return {
    plan: planDigest(),
    flags: ANALYSIS_PLAN.flags,
    perChain,
    spend: {
      totalUsd: Math.round(input.calls.reduce((sum, call) => sum + call.costUsd, 0) * 1e6) / 1e6,
      byRole: Object.fromEntries(
        Object.entries(byRole).map(([key, value]) => [
          key,
          {
            calls: value.calls,
            usd: Math.round(value.usd * 1e6) / 1e6,
            tokens: value.tokens,
            latencyMsMedian: [...value.latencyMs].sort((a, b) => a - b)[Math.floor(value.latencyMs.length / 2)] ?? null,
          },
        ]),
      ),
      blockedBudget: input.calls.filter((call) => call.status === "blocked_budget").length,
      failedCalls: input.calls
        .filter((call) => call.status !== "ok" && call.status !== "blocked_budget")
        .map((c) => ({ id: c.id, status: c.status, error: c.error })),
    },
  };
}
