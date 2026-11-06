import { DigestSchema, IdSchema, refOf } from "@aiengineer/knowledge-operation-protocol";
import { z } from "zod";
import { duplicates, identityShape } from "./common.js";

export const SUPPORT_SET_SCHEMA_VERSION = "research-core.support_set.v2" as const;

/**
 * One required premise. `evidence` names fragments; `derivedFrom` names premise assertions (derivations). At least one
 * is present. Execution-input and citation edges are not assessed support; only observations assess.
 */
export const RequiredPremiseSchema = z
  .strictObject({
    premise: IdSchema,
    evidence: z.array(refOf("fragment")),
    derivedFrom: z.array(refOf("assertion")),
  })
  .refine((premise) => premise.evidence.length + premise.derivedFrom.length > 0, {
    path: ["evidence"],
    message: "a required premise names evidence or premise assertions",
  });
export type RequiredPremise = z.infer<typeof RequiredPremiseSchema>;

/**
 * `SupportSet` (design §3): conjunctive across `required`; separate sets are alternatives. `qualifiersDigest` binds the
 * exact qualifiers the set was assembled for. `provenance` keeps declared-citation support separate from replacement
 * support found later (a rescue cannot repair the original citation).
 */
export const SupportSetSchema = z
  .strictObject({
    ...identityShape(SUPPORT_SET_SCHEMA_VERSION),
    assertion: refOf("assertion"),
    qualifiersDigest: DigestSchema,
    provenance: z.enum(["declared_citation", "replacement_search", "auditor_discovery"]),
    required: z.array(RequiredPremiseSchema).min(1),
    contrary: z.array(refOf("fragment")),
  })
  .superRefine((set, context) => {
    for (const premise of duplicates(set.required.map((entry) => entry.premise))) {
      context.addIssue({ code: "custom", path: ["required"], message: `duplicate premise ${premise}` });
    }
  });
export type SupportSet = z.infer<typeof SupportSetSchema>;
