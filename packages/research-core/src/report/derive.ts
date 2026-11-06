import {
  type Digest,
  type JsonValue,
  type Ref,
  digestCanonical,
  sameRef,
} from "@aiengineer/knowledge-operation-protocol";
import { recordRef } from "../digest.js";
import type { TimeQualifier } from "../profiles/base.js";
import type { AssertionValue, AssertionVersion } from "../records/assertion.js";
import type { DomainMapping } from "../records/mapping.js";
import type { ReportRevision } from "../records/report.js";
import type { SupportEvaluation } from "../support/algebra.js";

export interface DerivedProposal {
  readonly ruleId: string;
  readonly target: string;
  readonly targetSchema: string;
  readonly assertion: Ref<"assertion">;
  readonly supportSet: Ref<"support_set">;
  readonly qualifiersDigest: Digest;
  readonly entityId: string | null;
  readonly time: TimeQualifier;
  readonly value: AssertionValue | null;
  readonly fields: Readonly<Record<string, JsonValue>>;
  readonly proposalDigest: Digest;
}

export type DeriveHoldReason =
  | "assertion_unavailable"
  | "not_supported"
  | "no_matching_rule"
  | "unresolved_entity"
  | "ambiguous_entity"
  | "unresolved_time"
  | "undeclared_qualifier_field";

export interface HeldItem {
  readonly assertion: Ref<"assertion">;
  readonly ruleId: string | null;
  readonly reason: DeriveHoldReason;
}

export interface DerivedProposals {
  readonly report: Ref<"report">;
  readonly mapping: Ref<"mapping">;
  readonly proposals: readonly DerivedProposal[];
  readonly held: readonly HeldItem[];
}

/**
 * `report_derive` (design §3.2): compile ONLY explicitly supported assertion fields of this revision through declared
 * mapping rules. Unresolved entity/time mappings hold individual items; other items still compile. It performs no
 * entity resolution: an entity resolves only through an exact surface match in the mapping's recorded resolutions.
 */
export function reportDerive(input: {
  readonly revision: ReportRevision;
  readonly assertions: readonly AssertionVersion[];
  readonly support: readonly SupportEvaluation[];
  readonly mapping: DomainMapping;
}): DerivedProposals {
  const proposals: DerivedProposal[] = [];
  const held: HeldItem[] = [];
  for (const ref of input.revision.assertions) {
    const assertion = input.assertions.find((candidate) => sameRef(recordRef("assertion", candidate), ref));
    if (assertion === undefined) {
      held.push({ assertion: ref, ruleId: null, reason: "assertion_unavailable" });
      continue;
    }
    const evaluation = input.support.find((candidate) => candidate.ok && sameRef(candidate.assertion, ref));
    if (evaluation === undefined || !evaluation.ok || !evaluation.passes || evaluation.selected === null) {
      held.push({ assertion: ref, ruleId: null, reason: "not_supported" });
      continue;
    }
    const supportSet = evaluation.selected;
    const rules = input.mapping.rules.filter((rule) => rule.assertionKinds.includes(assertion.kind));
    if (rules.length === 0) {
      held.push({ assertion: ref, ruleId: null, reason: "no_matching_rule" });
      continue;
    }
    const qualifiers = assertion.qualifiers as Readonly<Record<string, JsonValue>>;
    for (const rule of rules) {
      const hold = (reason: DeriveHoldReason) => held.push({ assertion: ref, ruleId: rule.ruleId, reason });
      let entityId: string | null = null;
      if (rule.requiresEntity) {
        const surface = assertion.qualifiers.entity;
        const matches = new Set(
          input.mapping.entityResolutions
            .filter((resolution) => surface !== null && resolution.surface === surface)
            .map((resolution) => resolution.entityId),
        );
        if (matches.size === 0) {
          hold("unresolved_entity");
          continue;
        }
        if (matches.size > 1) {
          hold("ambiguous_entity");
          continue;
        }
        entityId = [...matches][0] ?? null;
      }
      const time = assertion.qualifiers.time;
      if (rule.requiresTime && (time === null || (time.from === null && time.to === null && time.asOf === null))) {
        hold("unresolved_time");
        continue;
      }
      const missing = rule.qualifierFields.filter((field) => !(field in qualifiers));
      if (missing.length > 0) {
        hold("undeclared_qualifier_field");
        continue;
      }
      const fields: Record<string, JsonValue> = {};
      for (const field of rule.qualifierFields) fields[field] = qualifiers[field] ?? null;
      const body = {
        ruleId: rule.ruleId,
        target: rule.target,
        targetSchema: input.mapping.targetSchema,
        assertion: ref,
        supportSet,
        qualifiersDigest: evaluation.qualifiersDigest,
        entityId,
        time,
        value: rule.includeValue ? assertion.value : null,
        fields,
      };
      proposals.push({ ...body, proposalDigest: digestCanonical(body as unknown as JsonValue) });
    }
  }
  return {
    report: recordRef("report", input.revision),
    mapping: recordRef("mapping", input.mapping),
    proposals,
    held,
  };
}
