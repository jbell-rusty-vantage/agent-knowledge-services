import {
  ArtifactResourceSchema,
  DurableReceiptResourceSchema,
  EvaluationFailuresResourceSchema,
  EvaluationReportResourceSchema,
  EvidencePacketSchema,
  RetrievalCitationReplaySchema,
  RetrievalExplanationResourceSchema,
  RetrievalRunResourceSchema,
  VectorStoreResourceSchema,
  type EvidencePacket,
  type OperationStatus,
  type RetrievalCitationReplay,
} from "@aiengineer/knowledge-contracts";
import type { ZodType } from "zod";
import {
  boundedResourceResult,
  resourceReadFailure,
  validatedStoredResource,
  type ResourceReadResult,
} from "../../reads/resource-read-result.js";

/** Tenant-scoped canonical resource reads; implemented by the persistence resource repository. */
export interface KnowledgeResourceReader {
  getVectorStoreResource(tenantId: string, vectorStoreId: string): Promise<unknown>;
  getArtifactResource(tenantId: string, artifactId: string): Promise<unknown>;
  getReceiptResource(tenantId: string, receiptId: string): Promise<unknown>;
  getRetrievalRunResource(tenantId: string, runId: string): Promise<unknown>;
  getRetrievalExplanationResource(tenantId: string, runId: string): Promise<unknown>;
  getEvaluationReportResource(tenantId: string, runId: string): Promise<unknown>;
  getEvaluationFailuresResource(tenantId: string, runId: string): Promise<unknown>;
  operationBelongsToVectorStore(tenantId: string, vectorStoreId: string, operationId: string): Promise<boolean>;
}

export interface KnowledgeResourceReadPorts {
  readonly resources?: KnowledgeResourceReader;
  readonly operations?: { get(operationId: string, tenantId?: string): unknown };
  readonly getEvidencePacket?: (
    tenantId: string,
    packetId: string,
  ) => EvidencePacket | undefined | Promise<EvidencePacket | undefined>;
  /** Replays retained citations from remote object custody, never producer files. */
  readonly replayEvidencePacketCitations?: (tenantId: string, packetId: string) => Promise<RetrievalCitationReplay>;
  readonly maximumResponseBytes?: number;
}

export type KnowledgeResourceReads = ReturnType<typeof createKnowledgeResourceReads>;

/**
 * Knowledge resource reads shared by the API routes and MCP tools. The caller has
 * already authorized `knowledge.read` for `tenantId`; the tenant is never taken from
 * the stored resource or request input as authority. Identifiers are validated by the caller.
 */
export function createKnowledgeResourceReads(ports: KnowledgeResourceReadPorts) {
  const stored = <T>(
    load: (reader: KnowledgeResourceReader) => Promise<unknown>,
    schema: ZodType<T>,
  ): Promise<ResourceReadResult<T>> => {
    const reader = ports.resources;
    if (!reader) return Promise.resolve(resourceReadFailure("unavailable"));
    return load(reader).then((resource) =>
      resource
        ? boundedResourceResult(validatedStoredResource(schema, resource), ports.maximumResponseBytes)
        : resourceReadFailure("not_found"),
    );
  };
  return {
    retrievalRun: (tenantId: string, runId: string) =>
      stored((reader) => reader.getRetrievalRunResource(tenantId, runId), RetrievalRunResourceSchema),
    retrievalExplanation: (tenantId: string, runId: string) =>
      stored((reader) => reader.getRetrievalExplanationResource(tenantId, runId), RetrievalExplanationResourceSchema),
    evaluationReport: (tenantId: string, runId: string) =>
      stored((reader) => reader.getEvaluationReportResource(tenantId, runId), EvaluationReportResourceSchema),
    evaluationFailures: (tenantId: string, runId: string) =>
      stored((reader) => reader.getEvaluationFailuresResource(tenantId, runId), EvaluationFailuresResourceSchema),
    vectorStore: (tenantId: string, vectorStoreId: string) =>
      stored((reader) => reader.getVectorStoreResource(tenantId, vectorStoreId), VectorStoreResourceSchema),
    artifact: (tenantId: string, artifactId: string) =>
      stored((reader) => reader.getArtifactResource(tenantId, artifactId), ArtifactResourceSchema),
    receipt: (tenantId: string, receiptId: string) =>
      stored((reader) => reader.getReceiptResource(tenantId, receiptId), DurableReceiptResourceSchema),
    /** The operation must belong to the tenant's vector store before its status is read. */
    async vectorStoreOperation(
      tenantId: string,
      vectorStoreId: string,
      operationId: string,
    ): Promise<ResourceReadResult<OperationStatus>> {
      const reader = ports.resources;
      if (!reader || !ports.operations) return resourceReadFailure("unavailable");
      if (!(await reader.operationBelongsToVectorStore(tenantId, vectorStoreId, operationId)))
        return resourceReadFailure("not_found");
      const operation = (await ports.operations.get(operationId, tenantId)) as OperationStatus | undefined;
      return operation ? { ok: true, value: operation } : resourceReadFailure("inconsistent");
    },
    async evidencePacket(tenantId: string, packetId: string): Promise<ResourceReadResult<EvidencePacket>> {
      const packet = await ports.getEvidencePacket?.(tenantId, packetId);
      return packet ? { ok: true, value: EvidencePacketSchema.parse(packet) } : resourceReadFailure("not_found");
    },
    async citationReplay(tenantId: string, packetId: string): Promise<ResourceReadResult<RetrievalCitationReplay>> {
      if (!ports.replayEvidencePacketCitations) return resourceReadFailure("unavailable");
      try {
        return {
          ok: true,
          value: RetrievalCitationReplaySchema.parse(await ports.replayEvidencePacketCitations(tenantId, packetId)),
        };
      } catch (error) {
        if (error instanceof Error && error.message === "EVIDENCE_PACKET_NOT_FOUND")
          return resourceReadFailure("not_found");
        throw error;
      }
    },
  };
}
