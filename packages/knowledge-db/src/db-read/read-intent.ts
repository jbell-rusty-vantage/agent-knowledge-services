import { z } from "zod";
import type { Digest } from "./canonical.js";
import type { Row } from "./rows.js";

export const SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const SlugSchema = z.string().regex(SLUG, "slug: ^[a-z0-9][a-z0-9._-]{0,63}$");
export const UuidSchema = z.string().uuid();
export const ReadRoleSchema = z.enum(["app_reader", "pipeline_agent"]);

export const ReadContextSchema = z.looseObject({
  tenantId: UuidSchema,
  correlationId: z.string().min(1).max(200).optional(),
  missionId: UuidSchema.optional(),
  attemptId: UuidSchema.optional(),
  activationId: z.string().max(200).optional(),
  actor: z.looseObject({ kind: z.enum(["agent", "human", "service"]), id: z.string().min(1).max(200) }).optional(),
});

const NamedQueryOperation = z.strictObject({
  required: z.boolean().default(true),
  opId: SlugSchema,
  kind: z.literal("named_query").default("named_query"),
  query: z.string().min(1).max(120),
  params: z.record(z.string(), z.unknown()).default({}),
  role: ReadRoleSchema.nullable().default(null),
  limit: z.number().int().positive().max(2000).optional(),
});
const RetrievalOperation = z.strictObject({
  required: z.boolean().default(true),
  opId: SlugSchema,
  kind: z.literal("retrieval"),
  query: z.string().min(1).max(120),
  params: z.record(z.string(), z.unknown()).default({}),
  role: ReadRoleSchema.nullable().default(null),
  limit: z.number().int().positive().max(2000).optional(),
});
const ArtifactOperation = z.strictObject({
  required: z.boolean().default(true),
  opId: SlugSchema,
  kind: z.literal("artifact"),
  artifactId: UuidSchema,
  include: z.enum(["digest_only", "inline"]).default("digest_only"),
});
export const ReadOperationSchema = z.discriminatedUnion("kind", [
  NamedQueryOperation,
  RetrievalOperation,
  ArtifactOperation,
]);
export type ReadOperation = z.infer<typeof ReadOperationSchema>;

export const MAX_OPERATIONS = 32;
export const MAX_STATEMENT_TIMEOUT_MS = 60_000;

export const ReadIntentSchema = z.strictObject({
  schemaVersion: z.literal("knowledge-read-intent.v1"),
  intentId: SlugSchema,
  context: ReadContextSchema,
  contract: z
    .strictObject({ migrationHead: z.string().optional(), workspaceFingerprint: z.string().optional() })
    .optional(),
  atKnowledgeSeq: z.number().int().nonnegative().nullable().default(null),
  operations: z.array(ReadOperationSchema).min(1).max(MAX_OPERATIONS),
  limits: z
    .strictObject({
      maxRowsPerOp: z.number().int().positive().max(2000).optional(),
      statementTimeoutMs: z.number().int().positive().max(MAX_STATEMENT_TIMEOUT_MS).optional(),
    })
    .optional(),
});
export type ReadIntent = z.infer<typeof ReadIntentSchema>;
export type ReadIntentInput = z.input<typeof ReadIntentSchema>;

export type OperationStatus = "ok" | "empty" | "skipped" | "error" | "truncated";

export interface OperationResult {
  readonly opId: string;
  readonly kind: ReadOperation["kind"];
  readonly query?: string;
  readonly role?: string;
  readonly params?: Record<string, unknown>;
  readonly resolvedFrom?: Record<string, string>;
  readonly status: OperationStatus;
  readonly rowCount: number;
  readonly truncated: boolean;
  readonly columns?: readonly string[];
  readonly rows?: readonly Row[];
  readonly value?: unknown;
  readonly artifactId?: string;
  readonly contentDigest: Digest;
  readonly volatile?: boolean;
  readonly reason?: string;
  readonly error?: { code: string; message: string };
  readonly durationMs: number;
}

export interface KnowledgeHead {
  readonly knowledgeSeq: number;
  readonly updatedAt: string;
}

export interface ReadSnapshot {
  readonly schemaVersion: "knowledge-read-snapshot.v1";
  readonly snapshotId: string;
  readonly intentRef: { readonly intentId: string; readonly intentDigest: Digest; readonly artifactId?: string };
  readonly context: ReadIntent["context"] & { readonly executorVersion: string };
  readonly contract: {
    readonly migrationHead: string;
    readonly workspaceFingerprint?: string;
    readonly catalogVersion?: string;
  };
  readonly knowledgeHead: KnowledgeHead;
  readonly knowledgeHeadAfter: KnowledgeHead;
  readonly headChanged: boolean;
  readonly atKnowledgeSeq: number;
  readonly executedAt: string;
  readonly operations: readonly OperationResult[];
  readonly snapshotDigest: Digest;
  readonly storage?: {
    readonly artifactId: string;
    readonly bucket: string;
    readonly objectPath: string;
    readonly storageState: string;
    readonly lineage: readonly { relation: string; to: string; state: "written" | "denied" }[];
  };
}
