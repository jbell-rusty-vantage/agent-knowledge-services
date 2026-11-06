import type { Proposal, ProposalOf } from "./intent.js";
import type { Vocabulary } from "./vocabulary.js";

const spelling = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
export const extentTimestamp = (value: string | undefined): string | null =>
  value === undefined ? null : /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value;

/** Normalize spelling only when the stream's vocabulary provides one exact meaning. */
export function normalizeTemporalUnit(proposal: Proposal, vocabulary: Vocabulary): Proposal {
  if (proposal.kind !== "fact.assert_state" || !proposal.unit) return proposal;
  const allowed = vocabulary.streamKinds.get(proposal.streamKind)?.unitValues ?? [];
  if (allowed.includes(proposal.unit)) return proposal;
  const matches = allowed.filter((unit) => spelling(unit) === spelling(proposal.unit!));
  return matches.length === 1 ? { ...proposal, unit: matches[0]! } : proposal;
}

/** Only these documented price aliases can denote the same unqualified semantic slot. */
export function priceSlotAliases(unit: string): readonly string[] {
  const legacy: Record<string, string> = {
    per_1m_input_tokens: "input_tokens",
    per_1m_output_tokens: "output_tokens",
    per_1m_cached_input_tokens: "cached_input_tokens",
  };
  return legacy[unit] ? [unit, legacy[unit]!] : [unit];
}

export function eventExtent(proposal: ProposalOf<"event.assert">): NonNullable<ProposalOf<"event.assert">["extent"]> {
  if (proposal.extent) return proposal.extent;
  return {
    sourceText: `[${proposal.occurredDuring.from ?? ""},${proposal.occurredDuring.to ?? ""})`,
    precision: proposal.precision ?? "day",
    ...(proposal.occurredDuring.from ? { earliest: proposal.occurredDuring.from } : {}),
    ...(proposal.occurredDuring.to ? { latest: proposal.occurredDuring.to } : {}),
  };
}
