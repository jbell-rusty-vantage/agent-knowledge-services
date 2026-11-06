import type { EmbeddingAdapter } from "@aiengineer/knowledge-retrieval";
import { freezeEvaluationDataset, evaluateRetrieval, type EvaluationReport } from "@aiengineer/knowledge-evaluation";
import { sha256Digest } from "@aiengineer/knowledge-core";
import {
  retrieve,
  type ImmutableEvidencePacket,
  type RetrievalPolicy,
  type RetrievalRecord,
} from "@aiengineer/knowledge-retrieval";
import { InMemoryExactCosineBackend, type PublicationManifests } from "@aiengineer/knowledge-retrieval";
import { KnowledgePreparationService, type VettedBundleInput } from "./preparation.js";

const TENANT = "00000000-0000-7000-8000-000000000001";
const VERSION = "00000000-0000-7000-8000-000000000301";
export interface ExploratoryKnowledgeIndex {
  readonly tenantId: string;
  readonly vectorSpaceVersionId: string;
  readonly records: readonly RetrievalRecord[];
  readonly backend: InMemoryExactCosineBackend;
  readonly embeddingReceiptDigests: readonly string[];
  readonly manifests: PublicationManifests;
}
export class AgenticKnowledgeService {
  constructor(
    private readonly embeddings: EmbeddingAdapter,
    private readonly preparation = new KnowledgePreparationService(),
  ) {}
  async buildExploratoryIndex(bundles: readonly VettedBundleInput[]): Promise<ExploratoryKnowledgeIndex> {
    const records: RetrievalRecord[] = [];
    const vectors = [];
    const embeddingReceiptDigests: string[] = [];
    const sourceDigests: string[] = [];
    const representationDigests: string[] = [];
    const chunkDigests: string[] = [];
    for (const bundle of bundles) {
      if (bundle.store_class !== "internal_exploratory") throw new Error("ONLY_INTERNAL_EXPLORATORY_BUNDLES_ALLOWED");
      const prepared = await this.preparation.preparePreview(bundle);
      sourceDigests.push(prepared.bundleDigest);
      representationDigests.push(...prepared.documents.map((x) => x.representation.digest));
      chunkDigests.push(...prepared.documents.map((x) => x.chunking.outputDigest));
      const receipt = await this.embeddings.embedMany({
        vectorSpaceVersionId: VERSION,
        idempotencyKey: `embed:${prepared.bundleDigest}`,
        expectedDimensions: 1536,
        inputs: prepared.engineeringClaimProjections.map((p) => ({ projectionId: p.projectionId, text: p.text })),
      });
      embeddingReceiptDigests.push(receipt.outputManifestDigest);
      for (const [index, projection] of prepared.engineeringClaimProjections.entries()) {
        const item = receipt.items[index]!;
        const source = bundle.engineering_claims[index]!;
        const document =
          prepared.documents.find((d) => d.representation.nodes.some((n) => n.text.includes(source.locator_excerpt))) ??
          prepared.documents[0]!;
        const node =
          document.representation.nodes.find((n) => n.text.includes(source.locator_excerpt)) ??
          document.representation.nodes[0]!;
        const offset = Math.max(0, node.text.indexOf(source.locator_excerpt));
        const record: RetrievalRecord = {
          id: projection.sourceRecordId,
          tenantId: TENANT,
          projectionId: projection.projectionId,
          projectionVersionId: projection.procedureVersionId,
          space: "engineering_claims",
          targetKind: "engineering_claim",
          targetSchemaVersion: "v1",
          text: projection.text,
          identifiers: [source.id, ...source.related_entities],
          vector: item.embedding,
          fields: { language: "en", visibility: "tenant", videoId: bundle.video_id },
          locators: [
            {
              representationId: node.representationId,
              nodeId: node.id,
              startOffset: offset,
              endOffset: offset + Math.max(1, source.locator_excerpt.length),
              quoteDigest: sha256Digest(source.locator_excerpt),
            },
          ],
          authority: "exploratory",
          assurance: "medium",
          freshnessAt: `${bundle.research_as_of}T00:00:00.000Z`,
          promoted: true,
          lifecycle: "active",
          sourceId: document.sourceDocumentId,
          ordinal: index,
        };
        records.push(record);
        vectors.push({
          tenantId: TENANT,
          vectorSpaceVersionId: VERSION,
          vectorSpaceKey: "engineering_claims",
          vectorItemId: record.id,
          searchProjectionId: projection.projectionId,
          embedding: item.embedding,
          searchText: projection.text,
          lifecycle: "active" as const,
        });
      }
    }
    const backend = new InMemoryExactCosineBackend(vectors);
    const manifest = (value: unknown) => sha256Digest(JSON.stringify(value));
    const manifests: PublicationManifests = {
      source: manifest(sourceDigests),
      representation: manifest(representationDigests),
      chunkSet: manifest(chunkDigests),
      projection: manifest(records.map((x) => x.projectionId)),
      vectorItem: manifest(records.map((x) => x.id)),
      embedding: manifest(embeddingReceiptDigests),
      index: manifest({ backend: "in-memory-exact-cosine", count: backend.count(TENANT, VERSION) }),
      retrievalPolicy: manifest(defaultRetrievalPolicy()),
      evaluation: manifest({ state: "pending" }),
    };
    return Object.freeze({
      tenantId: TENANT,
      vectorSpaceVersionId: VERSION,
      records: Object.freeze(records),
      backend,
      embeddingReceiptDigests: Object.freeze(embeddingReceiptDigests),
      manifests,
    });
  }
  async retrieve(index: ExploratoryKnowledgeIndex, query: string): Promise<ImmutableEvidencePacket> {
    const embedded = await this.embeddings.embedOne({
      vectorSpaceVersionId: index.vectorSpaceVersionId,
      idempotencyKey: `query:${sha256Digest(query)}`,
      expectedDimensions: 1536,
      input: { projectionId: "query", text: query },
    });
    return retrieve(query, {
      tenantId: index.tenantId,
      policy: defaultRetrievalPolicy(),
      records: index.records,
      spaces: ["engineering_claims"],
      queryVector: embedded.item.embedding,
      now: "2026-09-03T00:00:00.000Z",
    });
  }
  async evaluate(index: ExploratoryKnowledgeIndex): Promise<EvaluationReport> {
    const dataset = freezeEvaluationDataset({
      id: "three-real-bundles-claims",
      version: 1,
      name: "Three real bundle claim retrieval development check",
      reviewed: false,
      reviewMode: "development",
      cases: index.records.map((record, i) => ({
        id: `claim-${i}`,
        query: record.text,
        domain: "engineering_claims",
        queryClass: "semantic",
        provenance: [record.locators[0]!.quoteDigest!],
        relevanceJudgments: [{ recordId: record.id, grade: 3, rationale: "Exact evidence-backed claim projection" }],
      })),
    });
    const outputs = [];
    for (const testCase of dataset.cases) {
      const packet = await this.retrieve(index, testCase.query);
      outputs.push({
        caseId: testCase.id,
        items: packet.members
          .filter((x) => !x.contextOnly)
          .map((member, rank) => ({
            recordId: member.recordId,
            rank: rank + 1,
            score: member.finalScore,
            citation: { entailed: member.locators.length > 0, locatorValid: member.locators.length > 0 },
          })),
        abstained: packet.abstention.recommended,
        latencyMs: Object.values(packet.stageLatenciesMs).reduce((n, x) => n + x, 0),
        costMicros: 0,
      });
    }
    return evaluateRetrieval(dataset, outputs, 10);
  }
}
export function defaultRetrievalPolicy(): RetrievalPolicy {
  return {
    id: "00000000-0000-7000-8000-000000000401",
    admittedSpaces: [
      "engineering_claims",
      "tool_capabilities",
      "implementation_examples",
      "paper_case_study_knowledge",
      "entity_profiles",
      "model_capabilities",
      "benchmark_intelligence",
      "source_native_sections",
    ],
    allowedFilterFields: ["language", "visibility", "videoId"],
    allowedGraphEdges: ["supports", "challenges", "qualifies", "continues", "supersedes"],
    maxCandidateK: 50,
    maxFinalK: 10,
    maxGraphDepth: 2,
    maxGraphNodes: 100,
    rrfK: 60,
    channelWeights: { exact: 2, trigram: 0.5, fts: 1, semantic: 1, graph: 0.5, rerank: 1 },
    maxPerSource: 3,
    contextRadius: 0,
    minimumCoverage: 1,
  };
}
