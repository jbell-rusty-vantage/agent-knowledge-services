import { deepFreeze, sha256Digest } from "@aiengineer/knowledge-core";
import { exactScore, ftsScore, score, tokenize, trigramScore } from "./lexical/index.js";
import { buildRetrievalPlan } from "./plan/index.js";
import { compareCandidate, rrfContribution, sum } from "./rerank/index.js";
import { expandVerifiedGraph } from "./graph/index.js";
import { cosine } from "./semantic/index.js";
import type {
  ImmutableEvidencePacket,
  RetrievalFilter,
  RetrievalRecord,
  RetrievalStages,
  RetrievedCandidate,
  RetrieveOptions,
  StageContribution,
} from "./types.js";

// Pipeline — the one orchestrator. It owns every mutable accumulator (channelRanks,
// omitted, timings, eligible, plan) so the stage primitives in the sibling folders
// can stay pure functions or Map-free walks; they report back through rankChannel
// or a return value instead of owning their own state.
export async function retrieve(query: string, options: RetrieveOptions): Promise<ImmutableEvidencePacket> {
  const now = options.now ?? new Date().toISOString();
  const plan = buildRetrievalPlan(query, options.policy, options);
  const stages: RetrievalStages = {
    exact: true,
    trigram: true,
    fts: true,
    semantic: true,
    graph: true,
    rerank: true,
    diversity: true,
    context: true,
    ...options.stages,
  };
  const omitted: { recordId?: string; reason: string }[] = [];
  const timings: Record<string, number> = {};
  const time = <T>(name: string, fn: () => T): T => {
    const start = performance.now();
    const result = fn();
    timings[name] = performance.now() - start;
    return result;
  };
  const eligible = time("authorize_filter", () =>
    options.records.filter((record) => {
      if (record.tenantId !== options.tenantId) {
        omitted.push({ recordId: record.id, reason: "tenant_mismatch" });
        return false;
      }
      if (
        options.policy.allowedVisibilities &&
        !options.policy.allowedVisibilities.includes(String(record.fields.visibility))
      ) {
        omitted.push({
          recordId: record.id,
          reason: "visibility_not_authorized",
        });
        return false;
      }
      if (
        !plan.spaces.includes(record.space) ||
        !record.promoted ||
        record.lifecycle === "inactive" ||
        record.lifecycle === "tombstoned"
      ) {
        omitted.push({ recordId: record.id, reason: "not_eligible" });
        return false;
      }
      if (!plan.hardFilters.every((filter) => matches(record, filter))) {
        omitted.push({ recordId: record.id, reason: "hard_filter_mismatch" });
        return false;
      }
      return true;
    }),
  );
  // One channelRanks Map, owned here. Every stage below reports into it through
  // rankChannel instead of keeping its own map, because the insertion order of this
  // Map is load-bearing: the graph-seed sort and the fused-candidate sort both do
  // [...channelRanks], and a per-stage map would let that order drift by stage
  // execution order instead of by rank.
  const channelRanks = new Map<string, StageContribution[]>();
  const rankChannel = (
    channel: StageContribution["channel"],
    scored: readonly {
      record: RetrievalRecord;
      score: number;
      explanation: string;
      graphPath?: readonly string[];
    }[],
  ) => {
    scored.slice(0, plan.candidateK).forEach((item, index) => {
      const rank = index + 1;
      const entry: StageContribution = {
        channel,
        rank,
        rawScore: item.score,
        rrfContribution: rrfContribution(options.policy.channelWeights, options.policy.rrfK, channel, rank),
        explanation: item.explanation,
        ...(item.graphPath ? { graphPath: item.graphPath } : {}),
      };
      channelRanks.set(item.record.id, [...(channelRanks.get(item.record.id) ?? []), entry]);
    });
  };
  time("lexical", () => {
    for (const subquery of plan.subqueries) {
      const tokens = tokenize(subquery.text);
      if (stages.exact)
        rankChannel(
          "exact",
          score(eligible, (r) => exactScore(r, subquery.text), "exact identifier/phrase match"),
        );
      if (stages.trigram)
        rankChannel(
          "trigram",
          score(eligible, (r) => trigramScore(r.text, subquery.text), "trigram similarity"),
        );
      if (stages.fts)
        rankChannel(
          "fts",
          score(eligible, (r) => ftsScore(r.text, tokens), "full-text token coverage"),
        );
    }
  });
  if (options.queryVector && stages.semantic)
    time("semantic", () =>
      rankChannel(
        "semantic",
        score(eligible, (r) => (r.vector ? cosine(options.queryVector!, r.vector) : 0), "cosine semantic similarity"),
      ),
    );
  if (stages.graph)
    time("graph", () => {
      const seeds = [...channelRanks.entries()]
        .sort((a, b) => sum(b[1]) - sum(a[1]))
        .slice(0, Math.min(10, plan.candidateK))
        .map(([id]) => id);
      expandVerifiedGraph(plan, eligible, options.graphEdges ?? [], options.policy, seeds, rankChannel);
    });
  let degradedMode = false;
  if (options.reranker && stages.rerank) {
    const fusedIds = [...channelRanks.entries()]
      .sort((a, b) => sum(b[1]) - sum(a[1]))
      .slice(0, plan.candidateK)
      .map(([id]) => id);
    try {
      const reranked = await options.reranker.rerank(
        plan.normalizedQuery,
        fusedIds.map((id) => eligible.find((r) => r.id === id)!),
      );
      rankChannel(
        "rerank",
        reranked
          .map((x) => ({
            record: eligible.find((r) => r.id === x.recordId)!,
            score: x.score,
            explanation: `reranker ${options.reranker!.version}`,
          }))
          .filter((x) => x.record !== undefined),
      );
    } catch {
      degradedMode = true;
      omitted.push({ reason: "reranker_failed_fused_results_used" });
    }
  }
  // Insertion order of channelRanks is load-bearing here too: this is the same
  // [...channelRanks] the graph seed sort above used, so fused candidates are built
  // from the same iteration order every stage contributed to.
  const prelim = [...channelRanks]
    .map(([id, contributions]) => {
      const record = eligible.find((x) => x.id === id)!;
      const covered = plan.subqueries
        .filter((q) => exactScore(record, q.text) > 0 || ftsScore(record.text, tokenize(q.text)) > 0)
        .map((q) => q.id);
      const penalties: string[] = [];
      let penalty = 0;
      if (record.flags?.retracted) {
        penalties.push("retracted");
        penalty += 1;
      }
      if (record.flags?.superseded) {
        penalties.push("superseded");
        penalty += 0.25;
      }
      if (record.flags?.contradicted) {
        penalties.push("contradicted");
        penalty += 0.15;
      }
      const ageDays = Math.max(0, (Date.parse(now) - Date.parse(record.freshnessAt)) / 86_400_000);
      if (ageDays > 730) {
        penalties.push("stale_over_730_days");
        penalty += 0.02;
      }
      return {
        record,
        contributions,
        matchedConstraints: plan.hardFilters.map((f) => `${f.field}:${f.op}`),
        penalties,
        score: sum(contributions) - penalty,
        coveredSubqueryIds: covered,
      };
    })
    .filter((x) => {
      if (x.record.flags?.retracted) {
        omitted.push({ recordId: x.record.id, reason: "retracted" });
        return false;
      }
      return true;
    })
    .sort(compareCandidate);
  const selected: typeof prelim = [];
  const sourceCounts = new Map<string, number>();
  for (const item of prelim) {
    if (selected.length >= plan.finalK) break;
    const count = sourceCounts.get(item.record.sourceId) ?? 0;
    if (stages.diversity && count >= options.policy.maxPerSource) {
      omitted.push({
        recordId: item.record.id,
        reason: "source_diversity_cap",
      });
      continue;
    }
    sourceCounts.set(item.record.sourceId, count + 1);
    selected.push(item);
  }
  const ranked: RetrievedCandidate[] = selected.map((item, index) => ({
    ...item,
    finalRank: index + 1,
    contextOnly: false,
  }));
  const selectedIds = new Set(ranked.map((x) => x.record.id));
  if (stages.context && options.policy.contextRadius > 0) {
    for (const item of [...ranked])
      for (const context of eligible) {
        if (
          selectedIds.has(context.id) ||
          context.sourceId !== item.record.sourceId ||
          context.ordinal === undefined ||
          item.record.ordinal === undefined ||
          Math.abs(context.ordinal - item.record.ordinal) > options.policy.contextRadius
        )
          continue;
        selectedIds.add(context.id);
        ranked.push({
          record: context,
          contributions: [],
          matchedConstraints: [],
          penalties: [],
          score: 0,
          finalRank: item.finalRank,
          contextOnly: true,
          coveredSubqueryIds: [],
        });
      }
  }
  const coverage = plan.subqueries.map((q) => ({
    subqueryId: q.id,
    coverage: ranked.some((item) => !item.contextOnly && item.coveredSubqueryIds.includes(q.id)) ? 1 : 0,
  }));
  const required = coverage.filter((_, i) => plan.subqueries[i]!.coverageRole === "required");
  const coverageScore = required.reduce((n, x) => n + x.coverage, 0) / Math.max(1, required.length);
  const evidenceScore = Math.max(
    0,
    ...selected.flatMap((item) =>
      item.contributions
        .filter(({ channel }) => channel === "exact" || channel === "fts" || channel === "semantic")
        .map(({ rawScore }) => rawScore),
    ),
  );
  const queryTerms = tokenize(plan.normalizedQuery);
  const evidenceTerms = Math.max(
    0,
    ...selected.map((item) => {
      const textTerms = new Set(tokenize(item.record.text));
      return queryTerms.filter((term) => textTerms.has(term)).length;
    }),
  );
  const exactIdentifierHit = selected.some((item) =>
    item.contributions.some(({ channel, rawScore }) => channel === "exact" && rawScore === 1),
  );
  const insufficientTerms = !exactIdentifierHit && evidenceTerms < plan.minimumEvidenceTerms;
  const policyBypassAttempt =
    /\b(?:ignore|bypass|disable|override)\b.{0,48}\b(?:tenant|authorization|access|policy|filter)s?\b|\b(?:reveal|exfiltrate|leak)\b.{0,48}\b(?:private|secret|other (?:tenant|customer))\b/i.test(
      plan.normalizedQuery,
    );
  const abstain =
    policyBypassAttempt ||
    coverageScore < plan.minimumCoverage ||
    evidenceScore < plan.minimumEvidenceScore ||
    insufficientTerms ||
    selected.length === 0;
  const members = ranked.map((item) =>
    deepFreeze({
      memberId: stableId(`member:${item.record.id}:${item.contextOnly}`),
      recordId: item.record.id,
      projectionId: item.record.projectionId,
      space: item.record.space,
      locators: item.record.locators,
      contributions: item.contributions,
      graphPaths: item.contributions.flatMap((c) => (c.graphPath ? [c.graphPath] : [])),
      matchedConstraints: item.matchedConstraints,
      penalties: item.penalties,
      authority: item.record.authority,
      assurance: item.record.assurance,
      freshAt: item.record.freshnessAt,
      contradictionIds: item.record.contradictionIds ?? [],
      supersedesIds: item.record.supersedesIds ?? [],
      coveredSubqueryIds: item.coveredSubqueryIds,
      contextOnly: item.contextOnly,
      finalScore: item.score,
      finalRank: item.finalRank,
    }),
  );
  const retrievalRunId =
    options.retrievalRunId ?? stableId(`run:${options.tenantId}:${sha256Digest(JSON.stringify(plan))}`);
  const receiptId = stableId(`receipt:${retrievalRunId}`);
  const immutableCore = {
    tenantId: options.tenantId,
    retrievalRunId,
    normalizedQuery: plan.normalizedQuery,
    plan,
    members,
    omittedResults: omitted,
    coverage,
    abstention: {
      recommended: abstain,
      ...(abstain
        ? {
            reason: policyBypassAttempt
              ? "query requests authorization-policy bypass"
              : coverageScore < plan.minimumCoverage
                ? `required subquery coverage ${coverageScore.toFixed(2)} is below ${plan.minimumCoverage.toFixed(2)}`
                : insufficientTerms
                  ? `top evidence matches ${evidenceTerms} query terms; ${plan.minimumEvidenceTerms} required`
                  : `top evidence score ${evidenceScore.toFixed(3)} is below ${plan.minimumEvidenceScore.toFixed(3)}`,
          }
        : {}),
    },
    degradedMode,
    receiptId,
  };
  const digest = sha256Digest(JSON.stringify(immutableCore));
  return deepFreeze({
    id: stableId(`packet:${digest}`),
    digest,
    createdAt: now,
    ...immutableCore,
    stageLatenciesMs: timings,
  });
}

// Admission, not a retrieval channel: evaluated once per eligible record against
// every hard filter, so it stays with the pipeline rather than a stage folder.
function matches(record: RetrievalRecord, filter: RetrievalFilter) {
  const actual = record.fields[filter.field];
  const expected = filter.value;
  if (actual === undefined) return false;
  switch (filter.op) {
    case "eq":
      return actual === expected;
    case "neq":
      return actual !== expected;
    case "in":
      return Array.isArray(expected) && expected.includes(actual as never);
    case "contains":
      return Array.isArray(actual) ? actual.includes(expected as never) : String(actual).includes(String(expected));
    case "gte":
      return actual >= expected;
    case "lte":
      return actual <= expected;
  }
}

function stableId(seed: string) {
  const hex = sha256Digest(seed).slice(7, 39);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
