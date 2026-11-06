import {
  type EvaluatorIdentity,
  type JsonValue,
  type Ref,
  digestCanonical,
} from "@aiengineer/knowledge-operation-protocol";
import {
  type AuthScope,
  type CensusOutcome,
  DISCOVERED_OCCURRENCE_SCHEMA_VERSION,
  type DiscoveredOccurrence,
  DiscoveredOccurrenceSchema,
  type UnitExplanation,
  isInterrogativeText,
  isNegatedText,
  quoteDigest,
  recordRef,
  span,
} from "@aiengineer/knowledge-research-core";
import type { AuditorDiscovery, DiscoveryInput, DiscoveryResult } from "./ports.js";

/**
 * One scripted discovery: the exact quoted text the auditor "finds" in the frozen body. `nth` picks one occurrence
 * (0-based) of a repeated quote; omitted, every occurrence is discovered. `assertionLogicalId` maps the span to a
 * comparison assertion; `null`/omitted leaves it unmapped (a candidate claim the producer may not have declared).
 */
export interface DiscoveryScriptEntry {
  readonly quote: string;
  readonly nth?: number;
  readonly assertionLogicalId?: string | null;
  readonly candidate?: string;
  /** Override the deterministic polarity/modality reading of the quote. */
  readonly negated?: boolean;
  readonly interrogative?: boolean;
  /** An auditor explanation for this discovered occurrence (clears an auditor-only or screening difference). */
  readonly explanation?: string;
}

export interface DiscoveryScript {
  readonly entries: readonly DiscoveryScriptEntry[];
  readonly unitExplanations?: readonly UnitExplanation[];
  readonly recall?: CensusOutcome["recall"];
}

const METHOD_VERSION = "scripted-census-discovery.v1";

/**
 * Deterministic in-memory `AuditorDiscovery` for T0/T1 proofs: no model call, no network. It searches the exact frozen
 * text for scripted quotes, assigns each hit to the structural unit that contains it, and reads polarity/modality with
 * the research-core cues. It is a test double that exercises the census seam; it is never evidence of auditor recall.
 */
export class ScriptedAuditorDiscovery implements AuditorDiscovery {
  readonly calls: DiscoveryInput[] = [];

  constructor(private readonly script: DiscoveryScript) {}

  async discover(scope: AuthScope, input: DiscoveryInput): Promise<DiscoveryResult> {
    this.calls.push(input);
    const text = input.body.text;
    const occurrences: DiscoveredOccurrence[] = [];
    const explanations: { occurrenceId: string; reason: string }[] = [];
    this.script.entries.forEach((entry, entryIndex) => {
      const starts: number[] = [];
      for (let at = text.indexOf(entry.quote); at >= 0; at = text.indexOf(entry.quote, at + 1)) starts.push(at);
      const picked = entry.nth === undefined ? starts : starts.slice(entry.nth, entry.nth + 1);
      for (const start of picked) {
        const at = span(start, start + entry.quote.length);
        const unit = input.units.find(
          (candidate) => candidate.span !== null && candidate.span.start <= at.start && at.end <= candidate.span.end,
        );
        if (unit === undefined) throw new Error(`SCRIPT_OUTSIDE_UNIT: ${entry.quote}`);
        const mapped =
          entry.assertionLogicalId === undefined || entry.assertionLogicalId === null
            ? null
            : (input.assertions.find((assertion) => assertion.logicalId === entry.assertionLogicalId) ?? null);
        const id = `aud-${entryIndex}-${start}`;
        occurrences.push(
          DiscoveredOccurrenceSchema.parse({
            schemaVersion: DISCOVERED_OCCURRENCE_SCHEMA_VERSION,
            id,
            body: input.body.ref,
            span: at,
            blockPath: unit.path,
            quoteDigest: quoteDigest(text, at),
            candidateAssertion: entry.candidate ?? entry.quote,
            assertion: mapped === null ? null : recordRef("assertion", mapped),
            negated: entry.negated ?? isNegatedText(entry.quote),
            interrogative: entry.interrogative ?? isInterrogativeText(entry.quote),
          } satisfies DiscoveredOccurrence),
        );
        if (entry.explanation !== undefined) explanations.push({ occurrenceId: id, reason: entry.explanation });
      }
    });
    const configDigest = digestCanonical(this.script as unknown as JsonValue);
    const evaluator: EvaluatorIdentity = {
      role: "auditor",
      kind: "deterministic",
      provider: null,
      family: null,
      model: null,
      deployment: null,
      reviewerId: null,
      methodVersion: METHOD_VERSION,
      promptDigest: null,
      configDigest,
    };
    const method: Ref<"method"> = {
      kind: "method",
      id: "scripted-census-discovery",
      version: METHOD_VERSION,
      digest: configDigest,
      tenant: scope.tenant,
      binding: scope.binding,
    };
    return {
      evaluator,
      method,
      occurrences,
      explanations,
      unitExplanations: [...(this.script.unitExplanations ?? [])],
      recall: this.script.recall ?? { label: "unmeasured", reason: "scripted discovery has no calibration slice" },
      rationale: `scripted discovery of ${occurrences.length} occurrence(s) over the exact frozen body bytes`,
      limitations: ["deterministic test double: discovers only scripted quotes"],
      usage: { providerCalls: 0, tokens: 0, costUsd: "0" },
      rawResponse: null,
    };
  }
}
