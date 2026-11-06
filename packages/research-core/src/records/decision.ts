import {
  DigestSchema,
  InstantSchema,
  JsonPrimitiveSchema,
  NameSchema,
  SafeIntSchema,
  SchemaVersionSchema,
  refOf,
  refOfAny,
} from "@aiengineer/knowledge-operation-protocol";
import { z } from "zod";
import { ShortTextSchema, compareInstants, identityShape } from "./common.js";

export const USE_DECISION_SCHEMA_VERSION = "research-core.use_decision.v2" as const;

/**
 * `UseDecision` (design §3, §7): binds report revision, assertion qualifiers, selected support set, tenant (identity),
 * use/audience, normalized values, schema/policy/rubric, expiry and the revocation epoch it was decided under.
 * Qualifier or policy changes invalidate reuse because they change these bound digests.
 */
export const UseDecisionSchema = z
  .strictObject({
    ...identityShape(USE_DECISION_SCHEMA_VERSION),
    subject: refOfAny(["assertion", "report"]),
    report: refOf("report"),
    qualifiersDigest: DigestSchema.nullable(),
    supportSet: refOf("support_set").nullable(),
    run: refOf("verification_run"),
    boundEffectDigest: DigestSchema,
    use: NameSchema,
    audience: NameSchema,
    normalizedValues: z.record(NameSchema, JsonPrimitiveSchema),
    targetSchema: SchemaVersionSchema,
    disposition: z.enum(["admitted", "held", "rejected"]),
    conditions: z.array(ShortTextSchema),
    policy: refOf("policy"),
    rubric: refOf("rubric"),
    revocationEpoch: SafeIntSchema,
    decidedAt: InstantSchema,
    expiresAt: InstantSchema.nullable(),
    reviewer: refOf("adjudication").nullable(),
  })
  .superRefine((decision, context) => {
    // An assertion decision always binds its qualifiers digest; it binds a support set only when one was selected
    // (an admitted decision always has one; a held decision with no passing set binds null, not a guess).
    if (
      decision.subject.kind === "assertion" &&
      (decision.qualifiersDigest === null || (decision.disposition === "admitted" && decision.supportSet === null))
    ) {
      context.addIssue({
        code: "custom",
        path: ["subject"],
        message: "an assertion decision binds its qualifiers digest and, when admitted, its selected support set",
      });
    }
    if (decision.subject.kind === "report" && (decision.qualifiersDigest !== null || decision.supportSet !== null)) {
      context.addIssue({
        code: "custom",
        path: ["subject"],
        message: "a report decision binds no qualifiers digest or support set",
      });
    }
    if (decision.subject.kind === "report" && decision.subject.digest !== decision.report.digest) {
      context.addIssue({ code: "custom", path: ["subject"], message: "a report decision's subject is its report" });
    }
    if (decision.expiresAt !== null && compareInstants(decision.expiresAt, decision.decidedAt) <= 0) {
      context.addIssue({ code: "custom", path: ["expiresAt"], message: "expiry follows the decision" });
    }
  });
export type UseDecision = z.infer<typeof UseDecisionSchema>;
