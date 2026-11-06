import type { RetrievalChannel, RetrievalPolicy, RetrievalRecord, StageContribution } from "../types.js";

export function sum(items: readonly StageContribution[]): number {
  return items.reduce((n, x) => n + x.rrfContribution, 0);
}

// Reciprocal-rank-fusion contribution for one channel's rank, weighted by the
// policy's per-channel weight (defaulting to 1 for a channel the policy doesn't
// mention). Pure so the fusion math is testable without a channelRanks Map or a
// full pipeline run; retrieve.ts still owns the Map itself (load-bearing insertion
// order — see retrieve.ts's rankChannel).
export function rrfContribution(
  channelWeights: RetrievalPolicy["channelWeights"],
  rrfK: number,
  channel: RetrievalChannel,
  rank: number,
): number {
  const weight = channelWeights[channel] ?? 1;
  return weight / (rrfK + rank);
}

export function compareCandidate(
  a: { score: number; record: RetrievalRecord },
  b: { score: number; record: RetrievalRecord },
): number {
  return (
    b.score - a.score ||
    b.record.assurance.localeCompare(a.record.assurance) ||
    Date.parse(b.record.freshnessAt) - Date.parse(a.record.freshnessAt) ||
    a.record.id.localeCompare(b.record.id)
  );
}
