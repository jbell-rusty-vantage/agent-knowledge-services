import type { ArtifactStore } from "@aiengineer/knowledge-core";
import type {
  PostgresCanonicalRepository,
  PersistCaptureInput,
  PersistRepresentationInput,
  PersistChunkSetInput,
  GovernedProjectionProposalInput,
  GovernedProjectionProposal,
} from "@aiengineer/knowledge-persistence";

export interface CurrentSchemaPreparation {
  parents: { missionId: string; workItemId: string; attemptId: string; entityId: string };
  captured: { input: PersistCaptureInput; sourceArtifact: PersistCaptureInput["artifact"] };
  represented: { input: PersistRepresentationInput; structural: PersistCaptureInput["artifact"]; decisionId: string };
  chunked: { input: PersistChunkSetInput };
  promoted: { input: GovernedProjectionProposalInput; proposal: GovernedProjectionProposal; decisionId: string };
  sourceText: string;
  policy: string;
  producer: string;
  reviewer: string;
}

export function prepareCurrentSchemaFixture(input: {
  database: PostgresCanonicalRepository;
  tenantId: string;
  store: ArtifactStore;
}): Promise<CurrentSchemaPreparation>;
