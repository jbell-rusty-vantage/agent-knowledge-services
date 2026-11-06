import type { DocumentNode, SourceLocator, VectorSpace } from "@aiengineer/knowledge-contracts";
import { canonicalJson, sha256Digest } from "@aiengineer/knowledge-core";
import { chunkDocument, defaultChunkProfileRegistry, type ChunkingResult } from "@aiengineer/knowledge-preparation";
import {
  DeterministicTextConversionProvider,
  type ConversionNode,
  type ConversionOutput,
} from "@aiengineer/knowledge-preparation";
import {
  convertStructuralDocument,
  deterministicUuid,
  verifyNodeLocators,
  type StructuralBlock,
  type StructuralDocument,
} from "@aiengineer/knowledge-preparation";
import { createProjection, type EvidenceSupport } from "@aiengineer/knowledge-retrieval";
import {
  InMemoryArtifactStore,
  InMemoryOperationLedger,
  type ArtifactStore,
  type OperationContext,
} from "@aiengineer/knowledge-core";

export interface PreparationDocument {
  id: string;
  document_kind: string;
  title: string;
  canonical_url: string;
  source_role: "official" | "primary" | "authoritative_secondary";
  publisher: string;
  source_class: string;
  target_vector_spaces: string[];
  text: string;
  entity_slugs: string[];
}
export interface PreparationClaim {
  id: string;
  statement: string;
  claim_role: string;
  problem?: string;
  mechanism?: string;
  applicability?: string;
  limitations?: string;
  attribution: string;
  locator_excerpt: string;
  related_entities: string[];
}
export interface VettedBundleInput {
  schema_version: string;
  store_class: string;
  video_id: string;
  title: string;
  research_as_of: string;
  primary: { engineer: { slug: string; display_name: string }; organization: { slug: string; display_name: string } };
  selected_documents: PreparationDocument[];
  engineering_claims: PreparationClaim[];
}
export interface VettingFinding {
  documentId: string;
  accepted: boolean;
  checks: readonly string[];
  findings: readonly string[];
  intendedSpaces: readonly string[];
}
export interface CurationProposal {
  id: string;
  proposalType: "source_vetting" | "domain_mapping" | "projection";
  inputDigest: string;
  guardedDigest: string;
  state: "submitted";
  requestedAuthority: "reviewer_decision";
  payload: Readonly<Record<string, unknown>>;
}
export class AppendOnlyCurationProposalStore {
  readonly #items: CurationProposal[] = [];
  submit(input: Omit<CurationProposal, "id" | "guardedDigest" | "state" | "requestedAuthority">): CurationProposal {
    const guardedDigest = sha256Digest(JSON.parse(JSON.stringify(input)));
    const proposal = Object.freeze({
      ...input,
      id: deterministicUuid(`curation-proposal:${guardedDigest}`),
      guardedDigest,
      state: "submitted" as const,
      requestedAuthority: "reviewer_decision" as const,
    });
    if (!this.#items.some((item) => item.guardedDigest === guardedDigest)) this.#items.push(proposal);
    return proposal;
  }
  list(): readonly CurationProposal[] {
    return this.#items.map((item) => structuredClone(item));
  }
}
export interface VetOnlyResult {
  bundleDigest: string;
  accepted: boolean;
  findings: readonly VettingFinding[];
  proposals: readonly CurationProposal[];
}
export interface PreparedDocumentPreview {
  sourceDocumentId: string;
  sourceArtifactDigest: string;
  representation: StructuralDocument;
  conversion: ConversionOutput;
  chunking: ChunkingResult;
  sourceNativeProjectionCount: number;
}
export interface PreparationPreview {
  operationId: string;
  bundleDigest: string;
  vetting: VetOnlyResult;
  documents: readonly PreparedDocumentPreview[];
  engineeringClaimProjections: readonly ReturnType<typeof createProjection>[];
  proposals: readonly CurationProposal[];
  publicationState: "not_requested";
  embeddingState: "not_implemented";
  operationState: string;
}
const acceptedKinds = new Set<DocumentNode["kind"]>([
  "heading",
  "paragraph",
  "list",
  "table",
  "figure",
  "formula",
  "code_block",
  "citation",
  "transcript_segment",
]);
const validSpaces = new Set<VectorSpace>([
  "engineering_claims",
  "tool_capabilities",
  "implementation_examples",
  "paper_case_study_knowledge",
  "entity_profiles",
  "model_capabilities",
  "benchmark_intelligence",
  "source_native_sections",
]);
function digestValue(value: unknown): string {
  return sha256Digest(JSON.parse(canonicalJson(JSON.parse(JSON.stringify(value)))));
}
function mediaType(document: PreparationDocument) {
  if (document.document_kind === "talk_transcript") return "text/vtt";
  if (["official_homepage", "official_docs", "official_blog"].includes(document.document_kind)) return "text/html";
  if (document.document_kind === "official_repository") return "text/markdown";
  return "text/plain";
}
function profileFor(document: PreparationDocument) {
  if (document.document_kind === "talk_transcript") return "transcript-topics-v1";
  if (document.document_kind === "entity_profile") return "entity-facets-v1";
  if (document.document_kind === "official_repository") return "code-symbols-v1";
  return "heading-sections-v1";
}
function structuralBlocks(nodes: readonly ConversionNode[]): StructuralBlock[] {
  const admitted = nodes.filter((node) => acceptedKinds.has(node.kind as DocumentNode["kind"]));
  const admittedIds = new Set(admitted.map((node) => node.id));
  return admitted.map((node, ordinal) => {
    const block: StructuralBlock = {
      localKey: node.id,
      ordinal,
      kind: node.kind as DocumentNode["kind"],
      text: node.text,
      locator: {
        ...(node.locator.sectionPath ? { sectionPath: [...node.locator.sectionPath] } : {}),
        ...(node.locator.startTimeMs !== undefined ? { startTimeMs: node.locator.startTimeMs } : {}),
        ...(node.locator.endTimeMs !== undefined ? { endTimeMs: node.locator.endTimeMs } : {}),
      },
    };
    if (node.parentId && admittedIds.has(node.parentId)) return { ...block, parentKey: node.parentId };
    return block;
  });
}
function findClaimEvidence(claim: PreparationClaim, documents: readonly PreparedDocumentPreview[]): EvidenceSupport {
  const transcript =
    documents.find((item) => item.conversion.nodes.some((node) => node.kind === "transcript_segment")) ?? documents[0];
  if (!transcript) throw new Error("Claim has no source document");
  const nodes = transcript.representation.nodes;
  const excerpt = claim.locator_excerpt.trim();
  const supportingNode =
    nodes.find((node) => node.text.includes(excerpt)) ??
    nodes.find((node) =>
      claim.statement
        .split(/\s+/)
        .slice(0, 4)
        .every((token) => node.text.toLowerCase().includes(token.toLowerCase())),
    ) ??
    nodes[0];
  if (!supportingNode) throw new Error(`Claim ${claim.id} has no structural evidence node`);
  const offset = supportingNode.text.indexOf(excerpt);
  const quotedText = offset >= 0 ? excerpt : supportingNode.text;
  const locator: SourceLocator = {
    representationId: supportingNode.representationId,
    nodeId: supportingNode.id,
    startOffset: offset >= 0 ? offset : 0,
    endOffset: offset >= 0 ? offset + quotedText.length : quotedText.length,
    quoteDigest: sha256Digest(quotedText),
  };
  return { locatorId: deterministicUuid(`claim-evidence:${claim.id}:${locator.quoteDigest}`), locator, quotedText };
}

export class KnowledgePreparationService {
  readonly #converter: DeterministicTextConversionProvider;
  constructor(
    private readonly artifacts: ArtifactStore = new InMemoryArtifactStore(),
    private readonly ledger = new InMemoryOperationLedger(),
    private readonly proposals = new AppendOnlyCurationProposalStore(),
  ) {
    this.#converter = new DeterministicTextConversionProvider(artifacts);
  }
  vetOnly(bundle: VettedBundleInput): VetOnlyResult {
    const bundleDigest = digestValue(bundle);
    const findings = bundle.selected_documents.map((document): VettingFinding => {
      const issues: string[] = [];
      let url: URL | undefined;
      try {
        url = new URL(document.canonical_url);
      } catch {
        issues.push("invalid_canonical_url");
      }
      if (url && !["http:", "https:"].includes(url.protocol)) issues.push("unsupported_protocol");
      if (!document.text.trim()) issues.push("empty_content");
      if (!document.entity_slugs.length) issues.push("missing_entity_anchor");
      const unknownSpaces = document.target_vector_spaces.filter((space) => !validSpaces.has(space as VectorSpace));
      if (unknownSpaces.length) issues.push(`unknown_spaces:${unknownSpaces.join(",")}`);
      return {
        documentId: document.id,
        accepted: issues.length === 0,
        checks: [
          "canonical_url",
          "source_role",
          "non_empty_content",
          "entity_anchor",
          "target_spaces",
          "internal_exploratory_guard",
        ],
        findings: issues,
        intendedSpaces: [...document.target_vector_spaces],
      };
    });
    const proposal = this.proposals.submit({
      proposalType: "source_vetting",
      inputDigest: bundleDigest,
      payload: {
        videoId: bundle.video_id,
        sourceCount: findings.length,
        acceptedCount: findings.filter((item) => item.accepted).length,
        storeClass: bundle.store_class,
      },
    });
    return {
      bundleDigest,
      accepted:
        bundle.schema_version === "ai-engineer-embedding-bundle/0.1.0" &&
        bundle.store_class === "internal_exploratory" &&
        findings.every((item) => item.accepted),
      findings,
      proposals: [proposal],
    };
  }
  async preparePreview(bundle: VettedBundleInput, context?: Partial<OperationContext>): Promise<PreparationPreview> {
    const vetting = this.vetOnly(bundle);
    if (!vetting.accepted) throw new Error("BUNDLE_VETTING_FAILED");
    const operationId = context?.operationId ?? deterministicUuid(`prepare-preview:${vetting.bundleDigest}`);
    const fullContext: OperationContext = {
      tenantId: context?.tenantId ?? "00000000-0000-7000-8000-000000000001",
      operationId,
      attemptId: context?.attemptId ?? deterministicUuid(`attempt:${operationId}:1`),
      correlationId: context?.correlationId ?? operationId,
      actor: context?.actor ?? "executor_service",
      capabilityVersion: context?.capabilityVersion ?? "preparation-pipeline/1.0.0",
    };
    const operation = this.ledger.create(
      fullContext,
      `prepare-preview:${vetting.bundleDigest}`,
      { bundleDigest: vetting.bundleDigest },
      ["prepare"],
    );
    const step = this.ledger.claim(operation.context.operationId, "in-process-preparer", 60_000);
    if (!step) {
      const existing = this.ledger.get(operation.context.operationId)!;
      return {
        operationId,
        bundleDigest: vetting.bundleDigest,
        vetting,
        documents: [],
        engineeringClaimProjections: [],
        proposals: this.proposals.list(),
        publicationState: "not_requested",
        embeddingState: "not_implemented",
        operationState: existing.state,
      };
    }
    try {
      const documents: PreparedDocumentPreview[] = [];
      for (const document of bundle.selected_documents) {
        const source = await this.artifacts.put({
          tenantId: fullContext.tenantId,
          mediaType: mediaType(document),
          bytes: new TextEncoder().encode(document.text),
        });
        const representationId = deterministicUuid(
          `representation:${fullContext.tenantId}:${source.digest}:structural-v1`,
        );
        const conversion = await this.#converter.convert({
          tenantId: fullContext.tenantId,
          sourceArtifact: source,
          profile: {
            profileKey: `deterministic-${document.document_kind}`,
            version: "1.0.0",
            mediaType: mediaType(document),
            managedProcessingAllowed: false,
          },
        });
        const representation = convertStructuralDocument({
          tenantId: fullContext.tenantId,
          representationId,
          createdAt: "2026-09-01T00:00:00.000Z",
          blocks: structuralBlocks(conversion.nodes),
        });
        const locatorIssues = verifyNodeLocators(representation.nodes);
        if (locatorIssues.length) throw new Error(`LOCATOR_VALIDATION_FAILED:${locatorIssues.join(";")}`);
        const chunking = chunkDocument(representation.nodes, defaultChunkProfileRegistry.get(profileFor(document)));
        if (!chunking.qa.valid) throw new Error(`CHUNK_QA_FAILED:${chunking.qa.issues.join(";")}`);
        let sourceNativeProjectionCount = 0;
        const nodesById = new Map(representation.nodes.map((node) => [node.id, node]));
        for (const chunk of chunking.chunks) {
          const firstSpan = chunk.spans[0];
          if (!firstSpan) continue;
          const evidence: EvidenceSupport[] = chunk.spans.map((span, index) => {
            const node = nodesById.get(span.nodeId);
            if (!node) throw new Error(`Missing projection evidence node ${span.nodeId}`);
            const quotedText = node.text.slice(span.startOffset, span.endOffset);
            return {
              locatorId: deterministicUuid(`chunk-evidence:${chunk.id}:${index}`),
              locator: { ...span.locator, quoteDigest: sha256Digest(quotedText) },
              quotedText,
            };
          });
          createProjection({
            space: "source_native_sections",
            sourceRecordId: deterministicUuid(`source-document:${bundle.video_id}:${document.id}`),
            procedureVersionId: deterministicUuid("procedure:source-native-section/1.0.0"),
            evidence,
            assertions: [],
            sectionPath: firstSpan.locator.sectionPath ?? [],
            sourceText: chunk.sourceText,
          });
          sourceNativeProjectionCount++;
        }
        documents.push({
          sourceDocumentId: document.id,
          sourceArtifactDigest: source.digest,
          representation,
          conversion,
          chunking,
          sourceNativeProjectionCount,
        });
      }
      const engineeringClaimProjections = bundle.engineering_claims.map((claim) => {
        const evidence = findClaimEvidence(claim, documents);
        return createProjection({
          space: "engineering_claims",
          sourceRecordId: deterministicUuid(`claim:${bundle.video_id}:${claim.id}`),
          procedureVersionId: deterministicUuid("procedure:engineering-claim/1.0.0"),
          evidence: [evidence],
          assertions: [{ id: claim.id, statement: claim.statement, supportLocatorIds: [evidence.locatorId] }],
          claimClass: claim.claim_role,
          attribution: claim.attribution,
          problem: claim.problem ?? "",
          mechanism: claim.mechanism ?? "",
          applicability: claim.applicability ? [claim.applicability] : [],
          limitations: claim.limitations ? [claim.limitations] : [],
        });
      });
      const proposal = this.proposals.submit({
        proposalType: "projection",
        inputDigest: vetting.bundleDigest,
        payload: {
          videoId: bundle.video_id,
          representations: documents.map((item) => item.representation.digest),
          chunks: documents.flatMap((item) => item.chunking.chunks.map((chunk) => chunk.id)),
          projections: engineeringClaimProjections.map((item) => item.projectionId),
          requestedAction: "review_prepared_candidates",
          prohibitedActions: ["publish", "embed", "canonical_write"],
        },
      });
      this.ledger.complete(operationId, step.id, step.leaseToken!, operation.inputDigest, {
        documentDigests: documents.map((item) => item.representation.digest),
        claimProjectionIds: engineeringClaimProjections.map((item) => item.projectionId),
      });
      return {
        operationId,
        bundleDigest: vetting.bundleDigest,
        vetting,
        documents,
        engineeringClaimProjections,
        proposals: [...vetting.proposals, proposal],
        publicationState: "not_requested",
        embeddingState: "not_implemented",
        operationState: this.ledger.get(operationId)!.state,
      };
    } catch (error) {
      this.ledger.fail(operationId, step.id, step.leaseToken!, false);
      throw error;
    }
  }
}
