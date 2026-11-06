import { CanonicalRetrievalExecutor } from "@aiengineer/knowledge-application";
import {
  EvidencePacketSchema,
  type EvidencePacket,
  type RetrievalCitationReplay,
} from "@aiengineer/knowledge-contracts";
import {
  createRemoteRetrievalArtifactReader,
  type PostgresCanonicalRepository,
  type ResourceReadRepository,
} from "@aiengineer/knowledge-persistence";
import { createGatewayEmbeddingAdapterFromEnvironment } from "@aiengineer/knowledge-retrieval";
import type { HostEnvironment } from "./shared.js";

/** Knowledge services composed identically for every in-process server transport. */
export interface KnowledgeServices {
  readonly resources?: ResourceReadRepository;
  readonly getEvidencePacket?: (tenantId: string, packetId: string) => Promise<EvidencePacket | undefined>;
  readonly replayEvidencePacketCitations?: (tenantId: string, packetId: string) => Promise<RetrievalCitationReplay>;
  readonly canonicalRetrievalExecutor?: CanonicalRetrievalExecutor;
}

function composeCitationReplay(database: PostgresCanonicalRepository, environment: HostEnvironment) {
  // Citation replay reads sealed bytes from remote object custody, never from producer files.
  const projectUrl = environment.SUPABASE_URL?.trim(),
    serviceRoleKey = environment.SUPABASE_SECRET_KEY?.trim();
  if (!projectUrl || !serviceRoleKey) return undefined;
  const buckets = (environment.KNOWLEDGE_RETRIEVAL_ARTIFACT_BUCKETS?.trim() || "ai-engineer-cloud-bucket")
    .split(",")
    .map((bucket) => bucket.trim())
    .filter(Boolean);
  const read = createRemoteRetrievalArtifactReader(database, { projectUrl, serviceRoleKey, buckets });
  return (tenantId: string, packetId: string) => database.replayEvidencePacketCitations(tenantId, packetId, read);
}

/**
 * Canonical resource reads, evidence packets, citation replay and retrieval execution.
 * Retrieval needs the accounted gateway embedding adapter; without gateway credentials
 * it is absent and transports report it unavailable.
 */
export function composeKnowledgeServices(
  database: PostgresCanonicalRepository | undefined,
  environment: HostEnvironment,
): KnowledgeServices {
  if (!database) return {};
  // Construction order matches the previous API bootstrap: executor, then citation replay.
  const gatewayConfigured = Boolean(environment.AI_GATEWAY_API_KEY?.trim() || environment.VERCEL_OIDC_TOKEN?.trim());
  const canonicalRetrievalExecutor = gatewayConfigured
    ? new CanonicalRetrievalExecutor(
        database,
        createGatewayEmbeddingAdapterFromEnvironment(environment as NodeJS.ProcessEnv),
      )
    : undefined;
  const replayEvidencePacketCitations = composeCitationReplay(database, environment);
  return {
    resources: database,
    getEvidencePacket: async (tenantId: string, packetId: string) => {
      const packet = await database.getEvidencePacket(tenantId, packetId);
      return packet === undefined ? undefined : EvidencePacketSchema.parse(packet);
    },
    ...(replayEvidencePacketCitations ? { replayEvidencePacketCitations } : {}),
    ...(canonicalRetrievalExecutor ? { canonicalRetrievalExecutor } : {}),
  };
}
