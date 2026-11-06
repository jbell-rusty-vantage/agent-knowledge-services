import { IdSchema, NameSchema, SchemaVersionSchema, refOf } from "@aiengineer/knowledge-operation-protocol";
import { z } from "zod";
import { AssertionKindSchema } from "./assertion.js";
import { LocalIdSchema, ShortTextSchema, duplicates, identityShape } from "./common.js";

export const MAPPING_SCHEMA_VERSION = "research-core.mapping.v2" as const;

/**
 * Declared domain mapping consumed by `reportDerive`. `entityResolutions` are outputs of a separate, recorded entity
 * resolution step (each names its artifact); deterministic compilation only looks them up by exact surface string.
 */
export const DomainMappingSchema = z
  .strictObject({
    ...identityShape(MAPPING_SCHEMA_VERSION),
    targetSchema: SchemaVersionSchema,
    rules: z
      .array(
        z.strictObject({
          ruleId: LocalIdSchema,
          assertionKinds: z.array(AssertionKindSchema).min(1),
          target: NameSchema,
          includeValue: z.boolean(),
          /** Qualifier field names exactly as the profile spells them (camelCase, e.g. `studyDesign`, `appraisalDomain`). */
          qualifierFields: z.array(z.string().regex(/^[a-z][A-Za-z0-9_]{0,63}$/)),
          requiresEntity: z.boolean(),
          requiresTime: z.boolean(),
        }),
      )
      .min(1),
    entityResolutions: z.array(
      z.strictObject({ surface: ShortTextSchema, entityId: IdSchema, resolution: refOf("artifact") }),
    ),
  })
  .superRefine((mapping, context) => {
    for (const id of duplicates(mapping.rules.map((rule) => rule.ruleId))) {
      context.addIssue({ code: "custom", path: ["rules"], message: `duplicate rule ${id}` });
    }
  });
export type DomainMapping = z.infer<typeof DomainMappingSchema>;
