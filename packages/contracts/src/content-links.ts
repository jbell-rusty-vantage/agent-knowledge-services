import { z } from "zod";
import { IsoDateTimeSchema, Sha256DigestSchema, UuidSchema } from "./primitives.js";

const Key = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/);
const Text = z.string().min(1).max(4_000);
const DigestReference = z.strictObject({ id: UuidSchema, digest: Sha256DigestSchema });
const NodeReference = DigestReference.extend({ representationId: UuidSchema });
const ChunkReference = DigestReference.extend({
  documentVersionId: UuidSchema,
  representation: DigestReference,
  captureId: UuidSchema,
  sourceNodes: z.array(NodeReference).min(1).max(256),
});
const Evidence = z.strictObject({
  claimId: UuidSchema,
  claimKey: Key,
  claimDigest: Sha256DigestSchema,
  runId: UuidSchema,
  manifest: DigestReference,
  assessment: DigestReference,
  locatorId: UuidSchema,
  captureId: UuidSchema,
  role: z.enum(["supports", "challenges", "context"]),
});
const Common = {
  operationId: Key,
  dependsOn: z.array(Key).max(256).default([]),
  evidence: z.array(Evidence).min(1).max(256),
  rationale: Text,
  applicability: z.strictObject({
    validFrom: IsoDateTimeSchema.nullable(),
    validTo: IsoDateTimeSchema.nullable(),
    qualifiers: z.array(Text).max(32),
  }),
};
const SummarySource = NodeReference.extend({ weight: z.number().min(0).max(1) });
const ProjectionTarget = z.strictObject({
  kind: z.enum(["entity", "claim", "record", "summary", "chunk"]),
  canonicalId: UuidSchema,
});

export const ContentLinkOperationSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...Common,
    kind: z.literal("document.entity.link"),
    documentId: UuidSchema,
    documentVersion: DigestReference,
    entityId: UuidSchema,
    role: z.enum(["primary", "secondary", "mention"]),
    method: z.enum(["extraction", "manual", "inherited", "provider"]),
    confidence: z.number().min(0).max(1).optional(),
    sourceNodes: z.array(NodeReference).min(1).max(256),
  }),
  z.strictObject({
    ...Common,
    kind: z.literal("chunk.entity.link"),
    chunk: ChunkReference,
    entityId: UuidSchema,
    verb: z.enum([
      "mentions",
      "is_about",
      "defines",
      "compares",
      "demonstrates",
      "quotes",
      "cites",
      "deprecates",
      "recommends",
    ]),
    method: Key,
    confidence: z.number().min(0).max(1).optional(),
  }),
  z.strictObject({
    ...Common,
    kind: z.literal("chunk.claim.link"),
    chunk: ChunkReference,
    claimId: UuidSchema,
    verb: z.enum(["supports", "challenges", "context", "asserts", "mentions", "quotes", "explains", "qualifies"]),
  }),
  z.strictObject({
    ...Common,
    kind: z.literal("chunk.relationship.link"),
    chunk: ChunkReference,
    relationshipId: UuidSchema,
    verb: z.enum(["supports", "challenges", "context", "dates"]),
  }),
  z.strictObject({
    ...Common,
    kind: z.literal("summary.materialize"),
    summaryId: UuidSchema,
    documentVersion: DigestReference,
    representation: DigestReference,
    derivedFrom: DigestReference,
    transformationRunId: UuidSchema,
    summaryKind: z.enum([
      "abstract",
      "executive",
      "technical",
      "key_claims",
      "timeline",
      "entity_centric",
      "section",
      "chunk_group",
      "faq",
      "investor_brief",
      "learner_brief",
    ]),
    scope: z.enum(["document", "section", "chunk_group", "entity_view"]),
    scopeNodeId: UuidSchema.optional(),
    focusEntityId: UuidSchema.optional(),
    audience: z.enum(["general", "investor", "engineer", "learner"]),
    text: z.string().min(1).max(200_000),
    language: z.string().min(1).max(64).optional(),
    tokenCount: z.int().positive().max(200_000),
    sources: z.array(SummarySource).min(1).max(256),
    supersedesId: UuidSchema.optional(),
  }),
  z.strictObject({ ...Common, kind: z.literal("summary.source.link"), summaryId: UuidSchema, source: SummarySource }),
  z.strictObject({
    ...Common,
    kind: z.literal("projection.target.link"),
    target: ProjectionTarget,
    sourceChunks: z.array(ChunkReference).min(1).max(256),
  }),
]);
export type ContentLinkOperation = z.infer<typeof ContentLinkOperationSchema>;

/** Typed proposals only; canonical custody, tenant, evidence and head checks belong to the executor. */
export const ContentLinkIntentSchema = z
  .strictObject({
    schemaVersion: z.literal("content-link-intent.v1"),
    intentId: Key,
    context: z.strictObject({
      tenantId: UuidSchema,
      missionId: UuidSchema,
      attemptId: UuidSchema,
      actor: z.strictObject({ kind: z.enum(["agent", "human", "service"]), id: Key }),
    }),
    contract: z.strictObject({
      migrationHead: Key,
      workspaceFingerprint: Sha256DigestSchema,
      policyDigest: Sha256DigestSchema,
    }),
    inputSnapshot: z.strictObject({
      artifact: DigestReference,
      knowledgeSeq: z.int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    }),
    expectedKnowledgeHead: z.int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    asOf: IsoDateTimeSchema,
    onStale: z.literal("fail").default("fail"),
    operations: z.array(ContentLinkOperationSchema).min(1).max(256),
  })
  .superRefine((intent, context) => {
    const reject = (message: string) => context.addIssue({ code: "custom", message });
    const unique = (values: readonly string[], label: string) => {
      if (new Set(values).size !== values.length) reject(`${label} must be unique`);
    };
    if (intent.expectedKnowledgeHead !== intent.inputSnapshot.knowledgeSeq)
      reject("snapshot and expected knowledge head must agree");
    unique(
      intent.operations.map((operation) => operation.operationId),
      "operation IDs",
    );
    const operations = new Map(intent.operations.map((operation) => [operation.operationId, operation]));
    const bindings = new Map<string, string>();
    const remember = (kind: string, id: string, value: unknown) => {
      const key = `${kind}:${id}`,
        serialized = JSON.stringify(value);
      const prior = bindings.get(key);
      if (prior !== undefined && prior !== serialized) reject(`${kind} has conflicting immutable bindings`);
      bindings.set(key, serialized);
    };
    const node = (value: z.infer<typeof NodeReference>) =>
      remember("node", value.id, [value.digest, value.representationId]);
    const artifact = (value: z.infer<typeof DigestReference>) => remember("artifact", value.id, value.digest);
    artifact(intent.inputSnapshot.artifact);
    const chunk = (value: z.infer<typeof ChunkReference>) => {
      remember("chunk", value.id, [
        value.digest,
        value.documentVersionId,
        value.representation,
        value.captureId,
        [...value.sourceNodes].sort((a, b) => a.id.localeCompare(b.id)),
      ]);
      remember("representation", value.representation.id, value.representation.digest);
      unique(
        value.sourceNodes.map((source) => source.id),
        "chunk source nodes",
      );
      for (const source of value.sourceNodes) {
        node(source);
        if (source.representationId !== value.representation.id)
          reject("chunk source nodes must belong to its representation");
      }
    };
    for (const operation of intent.operations) {
      unique(operation.dependsOn, "operation dependencies");
      if (operation.dependsOn.some((id) => !operations.has(id))) reject("operation dependency is missing");
      const interval = operation.applicability;
      if (interval.validFrom && interval.validTo && Date.parse(interval.validFrom) >= Date.parse(interval.validTo))
        reject("temporal applicability must be a nonempty interval");
      unique(
        operation.evidence.map(
          (evidence) =>
            `${evidence.runId}:${evidence.claimKey}:${evidence.assessment.id}:${evidence.locatorId}:${evidence.role}`,
        ),
        "operation evidence",
      );
      for (const evidence of operation.evidence) {
        artifact(evidence.manifest);
        remember("claim", evidence.claimId, evidence.claimDigest);
        remember("run claim", `${evidence.runId}:${evidence.claimKey}`, [evidence.claimId, evidence.claimDigest]);
        remember("run manifest", evidence.runId, evidence.manifest);
        remember("assessment", evidence.assessment.id, [evidence.assessment.digest, evidence.claimId, evidence.runId]);
        remember("locator", evidence.locatorId, evidence.captureId);
      }
      if ("chunk" in operation) {
        chunk(operation.chunk);
        if (!operation.evidence.some((evidence) => evidence.captureId === operation.chunk.captureId))
          reject("chunk link requires evidence from its capture");
      }
      if (operation.kind === "document.entity.link") {
        remember("document version", operation.documentVersion.id, operation.documentVersion.digest);
        remember("document version owner", operation.documentVersion.id, operation.documentId);
        unique(
          operation.sourceNodes.map((source) => source.id),
          "document source nodes",
        );
        operation.sourceNodes.forEach(node);
      }
      if (operation.kind === "chunk.claim.link") {
        const matching = operation.evidence.filter(
          (evidence) => evidence.claimId === operation.claimId && evidence.captureId === operation.chunk.captureId,
        );
        if (!matching.length) reject("claim link must bind its canonical claim and capture evidence");
        if (
          (operation.verb === "supports" || operation.verb === "challenges") &&
          !matching.some((evidence) => evidence.role === operation.verb)
        )
          reject("claim link role must match its evidence role");
      }
      if (operation.kind === "projection.target.link") {
        unique(
          operation.sourceChunks.map((source) => source.id),
          "projection source chunks",
        );
        operation.sourceChunks.forEach(chunk);
        for (const source of operation.sourceChunks) {
          if (!operation.evidence.some((evidence) => evidence.captureId === source.captureId))
            reject("projection source chunk requires evidence from its capture");
        }
        if (
          operation.target.kind === "claim" &&
          !operation.evidence.some((evidence) => evidence.claimId === operation.target.canonicalId)
        )
          reject("claim projection must bind its canonical claim evidence");
        if (
          operation.target.kind === "chunk" &&
          !operation.sourceChunks.some((source) => source.id === operation.target.canonicalId)
        )
          reject("chunk target must identify a source chunk");
      }
      if (operation.kind === "summary.source.link") node(operation.source);
      if (operation.kind === "summary.materialize") {
        remember("summary", operation.summaryId, {
          ...operation,
          operationId: undefined,
          dependsOn: undefined,
          rationale: undefined,
        });
        remember("document version", operation.documentVersion.id, operation.documentVersion.digest);
        if (operation.scope === "section" && !operation.scopeNodeId) reject("section summary requires its scope node");
        if (operation.scope === "entity_view" && !operation.focusEntityId)
          reject("entity summary requires its focus entity");
        if (operation.representation.id === operation.derivedFrom.id)
          reject("summary output must differ from faithful input");
        remember("representation", operation.representation.id, operation.representation.digest);
        remember("representation", operation.derivedFrom.id, operation.derivedFrom.digest);
        unique(
          operation.sources.map((source) => source.id),
          "summary source nodes",
        );
        for (const source of operation.sources) {
          node(source);
          if (source.representationId !== operation.derivedFrom.id)
            reject("summary sources must belong to the faithful input");
        }
        if (operation.scopeNodeId && !operation.sources.some((source) => source.id === operation.scopeNodeId))
          reject("summary scope node must appear in source lineage");
        if (operation.supersedesId === operation.summaryId) reject("summary cannot supersede itself");
      }
    }
    const visiting = new Set<string>(),
      visited = new Set<string>();
    const visit = (id: string): void => {
      if (visiting.has(id)) {
        reject("operation dependency cycle");
        return;
      }
      if (visited.has(id)) return;
      visiting.add(id);
      for (const dependency of operations.get(id)?.dependsOn ?? []) visit(dependency);
      visiting.delete(id);
      visited.add(id);
    };
    for (const id of operations.keys()) visit(id);
  });
export type ContentLinkIntent = z.infer<typeof ContentLinkIntentSchema>;
