import { z } from "zod";
import { NonEmptyStringSchema, UuidSchema } from "./primitives.js";

export const StoreClassSchema = z.enum(["official_canonical", "internal_exploratory", "user_managed"]);
export type StoreClass = z.infer<typeof StoreClassSchema>;
export const StoreLifecycleSchema = z.enum([
  "draft",
  "active",
  "suspended",
  "deletion_pending",
  "deleted",
  "superseded",
]);

export const PublicKnowledgeDomainSchema = z.enum([
  "engineering_claims",
  "tool_capabilities",
  "implementation_examples",
  "paper_case_study_knowledge",
  "entity_profiles",
  "model_capabilities",
  "benchmark_intelligence",
]);
export type PublicKnowledgeDomain = z.infer<typeof PublicKnowledgeDomainSchema>;
export const VectorSpaceSchema = z.enum([...PublicKnowledgeDomainSchema.options, "source_native_sections"]);
export type VectorSpace = z.infer<typeof VectorSpaceSchema>;

export const VectorStoreSchema = z.strictObject({
  id: UuidSchema,
  tenantId: UuidSchema,
  projectId: UuidSchema.optional(),
  ownerId: UuidSchema,
  storeClass: StoreClassSchema,
  name: NonEmptyStringSchema,
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  purpose: NonEmptyStringSchema,
  visibility: z.enum(["private", "tenant", "public"]),
  lifecycle: StoreLifecycleSchema,
  quotaProfileId: UuidSchema,
  retentionPolicyId: UuidSchema,
  deletionPolicyId: UuidSchema,
  rowVersion: z.int().positive(),
  supersedesId: UuidSchema.optional(),
});
export type VectorStore = z.infer<typeof VectorStoreSchema>;

const ProjectionBaseSchema = z.strictObject({
  projectionId: UuidSchema,
  procedureVersionId: UuidSchema,
  sourceRecordId: UuidSchema,
  text: NonEmptyStringSchema,
  supportLocatorIds: z.array(UuidSchema).min(1),
});
const domain = <T extends VectorSpace>(space: T, fields: z.ZodRawShape) =>
  ProjectionBaseSchema.extend({ space: z.literal(space), ...fields });

export const EngineeringClaimProjectionSchema = domain("engineering_claims", {
  claimClass: NonEmptyStringSchema,
  attribution: NonEmptyStringSchema,
  limitations: z.array(NonEmptyStringSchema),
});
export const ToolCapabilityProjectionSchema = domain("tool_capabilities", {
  toolName: NonEmptyStringSchema,
  capabilities: z.array(NonEmptyStringSchema).min(1),
  constraints: z.array(NonEmptyStringSchema),
});
export const ImplementationExampleProjectionSchema = domain("implementation_examples", {
  language: NonEmptyStringSchema,
  framework: NonEmptyStringSchema.optional(),
  commit: NonEmptyStringSchema,
  path: NonEmptyStringSchema,
  symbol: NonEmptyStringSchema.optional(),
});
export const PaperCaseStudyProjectionSchema = domain("paper_case_study_knowledge", {
  title: NonEmptyStringSchema,
  findingClass: NonEmptyStringSchema,
  derived: z.boolean(),
});
export const EntityProfileProjectionSchema = domain("entity_profiles", {
  entityType: NonEmptyStringSchema,
  canonicalName: NonEmptyStringSchema,
  aliases: z.array(NonEmptyStringSchema),
});
export const ModelCapabilityProjectionSchema = domain("model_capabilities", {
  modelVersion: NonEmptyStringSchema,
  capabilities: z.array(NonEmptyStringSchema),
  constraints: z.array(NonEmptyStringSchema),
  observedAt: z.iso.datetime({ offset: true }),
});
export const BenchmarkIntelligenceProjectionSchema = domain("benchmark_intelligence", {
  benchmarkVersion: NonEmptyStringSchema,
  metric: NonEmptyStringSchema,
  protocol: NonEmptyStringSchema,
  comparabilityWarnings: z.array(NonEmptyStringSchema),
});
export const SourceNativeSectionProjectionSchema = domain("source_native_sections", {
  sectionPath: z.array(NonEmptyStringSchema),
  faithful: z.literal(true),
  exploratory: z.literal(true),
});

export const DomainProjectionSchema = z.discriminatedUnion("space", [
  EngineeringClaimProjectionSchema,
  ToolCapabilityProjectionSchema,
  ImplementationExampleProjectionSchema,
  PaperCaseStudyProjectionSchema,
  EntityProfileProjectionSchema,
  ModelCapabilityProjectionSchema,
  BenchmarkIntelligenceProjectionSchema,
  SourceNativeSectionProjectionSchema,
]);
export type DomainProjection = z.infer<typeof DomainProjectionSchema>;
