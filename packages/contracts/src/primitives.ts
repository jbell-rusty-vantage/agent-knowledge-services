import { z } from "zod";

export const ContractVersionSchema = z.literal("v1");
export const UuidSchema = z.uuid();
export const NonEmptyStringSchema = z.string().trim().min(1);
export const IsoDateTimeSchema = z.iso.datetime({ offset: true });
export const Sha256DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const IdempotencyKeySchema = z.string().trim().min(8).max(255);
export const JsonPrimitiveSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type JsonValue = z.infer<typeof JsonPrimitiveSchema> | JsonValue[] | { [key: string]: JsonValue };
export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([JsonPrimitiveSchema, z.array(JsonValueSchema), z.record(z.string(), JsonValueSchema)]),
);

export const ArtifactReferenceSchema = z.strictObject({
  artifactId: UuidSchema,
  tenantId: UuidSchema,
  digest: Sha256DigestSchema,
  mediaType: NonEmptyStringSchema,
  byteLength: z.int().nonnegative().optional(),
  downloadHandle: NonEmptyStringSchema.optional(),
});
export type ArtifactReference = z.infer<typeof ArtifactReferenceSchema>;

export const CanonicalRecordReferenceSchema = z.strictObject({
  kind: NonEmptyStringSchema,
  schemaVersion: NonEmptyStringSchema,
  recordId: UuidSchema,
  tenantId: UuidSchema,
});
export type CanonicalRecordReference = z.infer<typeof CanonicalRecordReferenceSchema>;

export const SourceLocatorSchema = z
  .strictObject({
    representationId: UuidSchema,
    nodeId: UuidSchema.optional(),
    page: z.int().positive().optional(),
    sectionPath: z.array(NonEmptyStringSchema).optional(),
    startOffset: z.int().nonnegative().optional(),
    endOffset: z.int().positive().optional(),
    startTimeMs: z.int().nonnegative().optional(),
    endTimeMs: z.int().positive().optional(),
    domPath: NonEmptyStringSchema.optional(),
    symbol: NonEmptyStringSchema.optional(),
    quoteDigest: Sha256DigestSchema.optional(),
  })
  .superRefine((locator, context) => {
    if (
      locator.startOffset !== undefined &&
      locator.endOffset !== undefined &&
      locator.endOffset <= locator.startOffset
    ) {
      context.addIssue({ code: "custom", message: "endOffset must be greater than startOffset", path: ["endOffset"] });
    }
    if (
      locator.startTimeMs !== undefined &&
      locator.endTimeMs !== undefined &&
      locator.endTimeMs <= locator.startTimeMs
    ) {
      context.addIssue({ code: "custom", message: "endTimeMs must be greater than startTimeMs", path: ["endTimeMs"] });
    }
  });
export type SourceLocator = z.infer<typeof SourceLocatorSchema>;

export const ImmutableResourceSchema = z.strictObject({
  id: UuidSchema,
  tenantId: UuidSchema,
  digest: Sha256DigestSchema,
  schemaVersion: ContractVersionSchema,
  createdAt: IsoDateTimeSchema,
});

export const PageSchema = z.strictObject({
  nextCursor: z.string().min(1).optional(),
});

export const ProblemDetailsSchema = z.strictObject({
  type: z.string().url(),
  title: NonEmptyStringSchema,
  status: z.int().min(400).max(599),
  detail: NonEmptyStringSchema.optional(),
  instance: NonEmptyStringSchema.optional(),
  code: z.enum([
    "INVALID_CONTRACT",
    "UNAUTHORIZED",
    "FORBIDDEN",
    "NOT_FOUND",
    "CONFLICT",
    "IDEMPOTENCY_CONFLICT",
    "STALE_GUARDED_DIGEST",
    "INVALID_STATE_TRANSITION",
    "CAPABILITY_NOT_ADMITTED",
    "LIMIT_EXCEEDED",
    "INTERNAL_ERROR",
  ]),
  correlationId: NonEmptyStringSchema,
  issues: z.array(z.strictObject({ path: NonEmptyStringSchema, message: NonEmptyStringSchema })).optional(),
});
export type ProblemDetails = z.infer<typeof ProblemDetailsSchema>;
