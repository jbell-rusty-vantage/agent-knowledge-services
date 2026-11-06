import {
  IdSchema,
  InstantSchema,
  NameSchema,
  SafeIntSchema,
  UsdSchema,
  refOf,
} from "@aiengineer/knowledge-operation-protocol";
import { z } from "zod";
import { LongTextSchema, RiskClassSchema, duplicates, identityShape } from "./common.js";

export const TASK_SCHEMA_VERSION = "research-core.task.v2" as const;

/** Frozen weights are integers (basis points of the task total): canonical bytes carry no floats. */
export const ObligationSchema = z.strictObject({
  id: IdSchema,
  description: LongTextSchema,
  weight: z.int().min(0).max(10000),
  required: z.boolean(),
});
export type Obligation = z.infer<typeof ObligationSchema>;

/** `VerificationTaskContract` (design §3): MC may supply task identity; KS freezes this obligation artifact. */
export const VerificationTaskContractSchema = z
  .strictObject({
    ...identityShape(TASK_SCHEMA_VERSION),
    domain: z.enum(["engineering", "scientific", "education"]),
    originalTask: refOf("artifact"),
    use: NameSchema,
    audience: NameSchema,
    obligations: z.array(ObligationSchema).min(1),
    asOf: InstantSchema,
    permittedMedia: z.array(NameSchema),
    rubric: refOf("rubric"),
    policy: refOf("policy"),
    minimumRisk: RiskClassSchema,
    limits: z.strictObject({
      calls: SafeIntSchema,
      tokens: SafeIntSchema,
      costUsd: UsdSchema,
      deadline: InstantSchema,
    }),
  })
  .superRefine((task, context) => {
    for (const id of duplicates(task.obligations.map((obligation) => obligation.id))) {
      context.addIssue({ code: "custom", path: ["obligations"], message: `duplicate obligation id ${id}` });
    }
    // OQ1 (accepted): weights are basis points of the frozen task total, so they sum to exactly 10000.
    const total = task.obligations.reduce((sum, obligation) => sum + obligation.weight, 0);
    if (total !== 10000) {
      context.addIssue({
        code: "custom",
        path: ["obligations"],
        message: `obligation weights sum to ${total}, not 10000 bp`,
      });
    }
  });
export type VerificationTaskContract = z.infer<typeof VerificationTaskContractSchema>;
