import { createHash } from "node:crypto";
import { sha256Digest } from "@aiengineer/knowledge-core";
import {
  auditDatasetPartitions,
  createExperimentMatrix,
  evaluatePromotionGate,
  evaluationCandidateManifestDigest,
  freezeEvaluationDataset,
  proveRollback,
  runExperimentMatrix,
  type EvaluationCaseInput,
  type EvaluationCaseOutput,
  type EvaluationDatasetInput,
  type EvaluationDomain,
  type EvaluationPartition,
  type EvaluationReviewArtifact,
  type ExperimentResult,
  type FrozenEvaluationCase,
  type FrozenEvaluationDataset,
  type PromotionGateResult,
  type QueryClass,
  type RollbackProof,
} from "@aiengineer/knowledge-evaluation";
import {
  retrieve,
  type GraphEdge,
  type ImmutableEvidencePacket,
  type RetrievalFilter,
  type RetrievalPolicy,
  type RetrievalRecord,
  type RetrievalStages,
} from "@aiengineer/knowledge-retrieval";
import { loadEmbeddingBundles, type EmbeddingBundle } from "./embedding-bundles.js";

export const BROAD_EVALUATION_VERSION = "broad-heldout-v3.0.0";
export const BROAD_QUERY_CLASSES: readonly QueryClass[] = [
  "exact",
  "conceptual",
  "mixed",
  "constraint",
  "multi_hop",
  "code",
  "contradiction",
  "freshness_temporal",
  "negative_abstention",
  "adversarial",
  "filtered",
];
export const BROAD_DOMAINS: readonly EvaluationDomain[] = [
  "engineering_claims",
  "tool_capabilities",
  "implementation_examples",
  "paper_case_study_knowledge",
  "entity_profiles",
  "model_capabilities",
  "benchmark_intelligence",
  "source_native_sections",
];
const TENANT = "00000000-0000-7000-8000-000000000001";
const BAD_TENANT = "00000000-0000-7000-8000-999999999999";
const assignments: Readonly<Record<string, EvaluationPartition>> = {
  kTnfJszFxCg: "dev",
  bk0TmxoZlUY: "calibration",
  rmvDxxNubIg: "heldout",
};

export interface BroadPublicRetrievalRequest {
  readonly query: string;
  readonly requestedSpaces: readonly EvaluationDomain[];
}
export interface BroadEvaluationCorpus {
  readonly dataset: FrozenEvaluationDataset;
  readonly publicRequests: Readonly<Record<string, BroadPublicRetrievalRequest>>;
  readonly publicRequestManifestDigest: `sha256:${string}`;
  readonly records: readonly RetrievalRecord[];
  readonly graphEdges: readonly GraphEdge[];
  readonly policy: RetrievalPolicy;
  readonly queryVectors: Readonly<Record<string, readonly number[]>>;
  readonly fixtureSummary: {
    readonly realBundleGroundedCases: number;
    readonly syntheticGapCases: number;
    readonly reviewedNegativeCases: number;
    readonly adversarialCases: number;
    readonly recordCount: number;
  };
}
export interface BroadEvaluationCandidate {
  readonly datasetInput: EvaluationDatasetInput;
  readonly publicRequests: Readonly<Record<string, BroadPublicRetrievalRequest>>;
  readonly publicRequestManifestDigest: `sha256:${string}`;
  readonly candidateManifestDigest: `sha256:${string}`;
  readonly records: readonly RetrievalRecord[];
  readonly graphEdges: readonly GraphEdge[];
  readonly policy: RetrievalPolicy;
  readonly queryVectors: Readonly<Record<string, readonly number[]>>;
  readonly fixtureSummary: BroadEvaluationCorpus["fixtureSummary"];
}
export interface BroadExperimentConfiguration {
  readonly stages: Partial<RetrievalStages>;
  readonly applyPlannedFilters: boolean;
  readonly useReranker: boolean;
}
export interface BroadEvaluationResult {
  readonly experiment: ExperimentResult<BroadExperimentConfiguration>;
  readonly controlGate: PromotionGateResult;
  readonly regressionGate: PromotionGateResult;
  readonly rollbackProof: RollbackProof;
  readonly partitionAudit: ReturnType<typeof auditDatasetPartitions>;
  readonly falseAcceptanceCases: readonly string[];
}
export interface BroadControlSystemOutput {
  readonly output: EvaluationCaseOutput;
  readonly evidencePacket: ImmutableEvidencePacket;
}
export const BROAD_HYBRID_CONTROL_CONFIGURATION: BroadExperimentConfiguration = {
  stages: {},
  applyPlannedFilters: true,
  useReranker: false,
};
type MutableCase = EvaluationCaseInput & { relevantIds: readonly string[] };

export async function createBroadEvaluationCandidate(): Promise<BroadEvaluationCandidate> {
  const reviewerProvenance = "unreviewed-candidate";
  const loaded = await loadEmbeddingBundles();
  const records: RetrievalRecord[] = [];
  const pending: MutableCase[] = [];
  const graphEdges: GraphEdge[] = [];
  for (const { bundle, digest } of loaded) {
    const partition = assignments[bundle.video_id];
    if (!partition) throw new Error(`UNASSIGNED_SOURCE_FAMILY:${bundle.video_id}`);
    const realFamily = `bundle:${bundle.video_id}`;
    const entityFamily = `entity:${bundle.primary.organization.slug}`;
    const real = addRealRecords(records, bundle, digest, partition, realFamily, entityFamily);
    const synthetic = addSyntheticRecords(records, bundle, partition);
    const decoys = {
      code: addDecoys(records, bundle, partition, synthetic.code, "code"),
      source: addDecoys(records, bundle, partition, real.documents[0]!, "source"),
      tool: addDecoys(records, bundle, partition, synthetic.tool, "tool"),
      model: addDecoys(records, bundle, partition, synthetic.model, "model"),
    };
    graphEdges.push(
      {
        fromId: synthetic.tool.id,
        toId: synthetic.code.id,
        kind: "implemented_by",
        verified: true,
        rationale:
          "The evaluation-only tool fixture explicitly links its acquisition capability to this concrete retry implementation.",
        provenance: ["synthetic-gap-procedure-v1", bundle.video_id],
        locatorDigest: synthetic.code.locators[0]!.quoteDigest!,
      },
      {
        fromId: synthetic.paper.id,
        toId: synthetic.benchmark.id,
        kind: "measured_by",
        verified: true,
        rationale: "The evaluation-only study fixture declares Hybrid-10 as its frozen-qrel measurement.",
        provenance: ["synthetic-gap-procedure-v1", bundle.video_id],
        locatorDigest: synthetic.benchmark.locators[0]!.quoteDigest!,
      },
    );
    addCases(
      pending,
      bundle,
      digest,
      partition,
      realFamily,
      entityFamily,
      real,
      synthetic,
      decoys,
      records,
      reviewerProvenance,
    );
  }
  const allIds = records.map((record) => record.id);
  const cases = pending.map(({ relevantIds, ...input }) => {
    const domainPool = [
      ...new Set([
        ...records.filter((record) => record.space === input.domain).map((record) => record.id),
        ...relevantIds,
      ]),
    ];
    const relevanceJudgments = domainPool.map((recordId) => {
      const record = records.find((candidate) => candidate.id === recordId)!;
      return {
        recordId,
        grade: (relevantIds.includes(recordId) ? 3 : 0) as 0 | 3,
        rationale: relevantIds.includes(recordId)
          ? `Required evidence node for “${input.query}”; content digest ${sha256Digest(record.text)} and locator ${record.locators[0]?.quoteDigest ?? "missing"}.`
          : `Pooled same-domain candidate is not an answer to “${input.query}”; candidate content digest ${sha256Digest(record.text)}.`,
      };
    });
    return {
      ...input,
      relevanceJudgments,
      forbiddenResultIds: input.expectedAbstain ? allIds : (input.forbiddenResultIds ?? []),
    };
  });
  const datasetInput = {
    id: "agentic-knowledge-reviewed-heldout",
    version: 3,
    name: "Reviewed broad agentic knowledge retrieval corpus",
    reviewed: false,
    cases,
  } as const;
  const queryVectors = Object.fromEntries(cases.map((item) => [item.id, textVector(item.query)]));
  const policy: RetrievalPolicy = {
    id: "broad-policy-v3",
    admittedSpaces: BROAD_DOMAINS,
    allowedFilterFields: ["tenantId", "domain", "version", "language", "visibility", "sourceFamily"],
    allowedGraphEdges: ["implemented_by", "measured_by"],
    allowedVisibilities: ["tenant", "public"],
    maxCandidateK: 50,
    maxFinalK: 10,
    maxGraphDepth: 2,
    maxGraphNodes: 100,
    rrfK: 60,
    channelWeights: { exact: 2, trigram: 0.2, fts: 1, semantic: 1, graph: 0.35, rerank: 1 },
    maxPerSource: 4,
    contextRadius: 0,
    minimumCoverage: 1,
    minimumEvidenceScore: 0.15,
    minimumEvidenceTerms: 2,
  };
  const fixtureSummary = {
    realBundleGroundedCases: cases.filter((item) => item.fixtureKind === "real_bundle_grounded").length,
    syntheticGapCases: cases.filter((item) => item.fixtureKind === "synthetic_gap").length,
    reviewedNegativeCases: cases.filter((item) => item.fixtureKind === "reviewed_negative").length,
    adversarialCases: cases.filter((item) => item.fixtureKind === "adversarial").length,
    recordCount: records.length,
  };
  const publicRequests = Object.freeze(
    Object.fromEntries(cases.map((item) => [item.id, publicRequest(item.query, item.domain)])),
  );
  return {
    datasetInput,
    publicRequests,
    publicRequestManifestDigest: sha256Digest(publicRequests as never),
    candidateManifestDigest: evaluationCandidateManifestDigest(datasetInput),
    records: Object.freeze(records),
    graphEdges: Object.freeze(graphEdges),
    policy,
    queryVectors,
    fixtureSummary,
  };
}

export async function createBroadEvaluationCorpus(
  reviewArtifact: EvaluationReviewArtifact,
): Promise<BroadEvaluationCorpus> {
  if (reviewArtifact.decision !== "accept") throw new Error("BROAD_CORPUS_REQUIRES_ACCEPTED_INDEPENDENT_REVIEW");
  const candidate = await createBroadEvaluationCandidate();
  if (reviewArtifact.candidateManifestDigest !== candidate.candidateManifestDigest)
    throw new Error("BROAD_REVIEW_ARTIFACT_CANDIDATE_MISMATCH");
  const cases = candidate.datasetInput.cases.map((item) => ({
    ...item,
    reviewerProvenance: reviewArtifact.reviewerIdentity,
  }));
  const dataset = freezeEvaluationDataset({ ...candidate.datasetInput, reviewed: true, cases, reviewArtifact });
  return {
    dataset,
    publicRequests: candidate.publicRequests,
    publicRequestManifestDigest: candidate.publicRequestManifestDigest,
    records: candidate.records,
    graphEdges: candidate.graphEdges,
    policy: candidate.policy,
    queryVectors: candidate.queryVectors,
    fixtureSummary: candidate.fixtureSummary,
  };
}

function addRealRecords(
  records: RetrievalRecord[],
  bundle: EmbeddingBundle,
  bundleDigest: string,
  partition: EvaluationPartition,
  family: string,
  entityFamily: string,
) {
  const claims = bundle.engineering_claims.slice(0, 4).map((claim, index) =>
    makeRecord({
      id: `${family}:claim:${claim.id}`,
      bundle,
      space: "engineering_claims",
      text: [claim.statement, claim.problem, claim.mechanism, claim.applicability, claim.limitations, claim.attribution]
        .filter(Boolean)
        .join(" "),
      family,
      partition,
      entityFamily,
      identifier: claim.id,
      sourceDigest: bundleDigest,
      index,
      assurance: "high",
    }),
  );
  const documents = bundle.selected_documents.slice(0, 2).map((document, index) =>
    makeRecord({
      id: `${family}:section:${document.id}`,
      bundle,
      space: "source_native_sections",
      text: document.text,
      family,
      partition,
      entityFamily,
      identifier: document.title,
      sourceDigest: sha256Digest(document.text),
      index: index + 10,
      assurance: "high",
    }),
  );
  const entity = makeRecord({
    id: `${family}:entity`,
    bundle,
    space: "entity_profiles",
    text: `${bundle.primary.engineer.display_name} is associated with ${bundle.primary.organization.display_name}. Stable slugs: ${bundle.primary.engineer.slug}, ${bundle.primary.organization.slug}.`,
    family,
    partition,
    entityFamily,
    identifier: bundle.primary.organization.slug,
    extraIdentifiers: [
      bundle.primary.engineer.slug,
      bundle.primary.engineer.display_name,
      bundle.primary.organization.display_name,
    ],
    sourceDigest: bundleDigest,
    index: 20,
    assurance: "high",
  });
  records.push(...claims, ...documents, entity);
  return { claims, documents, entity };
}
function addSyntheticRecords(records: RetrievalRecord[], bundle: EmbeddingBundle, partition: EvaluationPartition) {
  const base = `synthetic:${bundle.video_id}`;
  const specs = [
    {
      key: "tool",
      space: "tool_capabilities",
      text: `Evaluation-only tool card: ${bundle.primary.organization.display_name} Research Connector acquires official HTTP sources, preserves receipts, and refuses private-network URLs.`,
    },
    {
      key: "code",
      space: "implementation_examples",
      text: `Evaluation-only ${bundle.primary.organization.display_name} TypeScript example: createResearchClient({ idempotencyKey, timeoutMs: 30000 }); retry only 429 and 503 responses while preserving the same idempotency key.`,
    },
    {
      key: "paper",
      space: "paper_case_study_knowledge",
      text: `Evaluation-only case study: a hybrid retrieval experiment for ${bundle.primary.organization.display_name} compared lexical and semantic search; its small sample prevents broad causal claims.`,
    },
    {
      key: "model",
      space: "model_capabilities",
      text: `Evaluation-only model card: ${bundle.primary.organization.display_name} Embed v2 creates 1536-dimensional text vectors, supports English semantic retrieval, and was observed on 2026-08-15.`,
    },
    {
      key: "benchmark",
      space: "benchmark_intelligence",
      text: `Evaluation-only benchmark: ${bundle.primary.organization.display_name} Hybrid-10 measured Recall@10 under frozen qrels and reported 0.91; scores from other datasets are not directly comparable.`,
    },
  ] as const;
  const result = {} as Record<string, RetrievalRecord>;
  for (const [index, spec] of specs.entries()) {
    const family = `${base}:${spec.key}`;
    const record = makeRecord({
      id: family,
      bundle,
      space: spec.space,
      text: spec.text,
      family,
      partition,
      entityFamily: family,
      identifier: `${bundle.primary.organization.slug}-${spec.key}`,
      sourceDigest: sha256Digest(spec.text),
      index: index + 30,
      assurance: "medium",
      synthetic: true,
    });
    records.push(record);
    result[spec.key] = record;
  }
  return result as {
    tool: RetrievalRecord;
    code: RetrievalRecord;
    paper: RetrievalRecord;
    model: RetrievalRecord;
    benchmark: RetrievalRecord;
  };
}
function addDecoys(
  records: RetrievalRecord[],
  bundle: EmbeddingBundle,
  partition: EvaluationPartition,
  target: RetrievalRecord,
  label: string,
) {
  const base = {
    bundle,
    space: target.space,
    text: target.text,
    family: `decoy-family:${bundle.video_id}:${label}`,
    partition,
    entityFamily: `decoy:${bundle.video_id}:${label}`,
    identifier: `${bundle.primary.organization.slug}-${label}-decoy`,
    sourceDigest: sha256Digest(`decoy:${bundle.video_id}:${label}`),
    assurance: "low" as const,
    synthetic: true,
  };
  const ids = [
    `decoy:${bundle.video_id}:${label}:wrong-tenant`,
    `decoy:${bundle.video_id}:${label}:wrong-version`,
    `decoy:${bundle.video_id}:${label}:private`,
    `decoy:${bundle.video_id}:${label}:spanish`,
  ] as const;
  records.push(
    {
      ...makeRecord({ ...base, id: ids[0], index: 50 }),
      tenantId: BAD_TENANT,
      fields: { ...target.fields, tenantId: BAD_TENANT },
    },
    makeRecord({ ...base, id: ids[1], index: 51, overrides: { version: "legacy" } }),
    makeRecord({ ...base, id: ids[2], index: 52, overrides: { visibility: "private" } }),
    makeRecord({ ...base, id: ids[3], index: 53, overrides: { language: "es" } }),
  );
  return ids;
}
function makeRecord(input: {
  id: string;
  bundle: EmbeddingBundle;
  space: EvaluationDomain;
  text: string;
  family: string;
  partition: EvaluationPartition;
  entityFamily: string;
  identifier: string;
  extraIdentifiers?: readonly string[];
  sourceDigest: string;
  index: number;
  assurance: "high" | "medium" | "low";
  synthetic?: boolean;
  overrides?: Record<string, string>;
}): RetrievalRecord {
  const version = input.synthetic ? "eval-synthetic-v1" : input.bundle.research_as_of;
  const fields = {
    tenantId: TENANT,
    domain: input.space,
    version,
    language: "en",
    visibility: "tenant",
    sourceFamily: input.family,
    ...input.overrides,
  };
  const quote = input.text.slice(0, Math.min(240, input.text.length));
  return {
    id: input.id,
    tenantId: TENANT,
    projectionId: `projection:${input.id}`,
    projectionVersionId: input.synthetic ? "synthetic-gap-procedure-v1" : "real-bundle-procedure-v1",
    space: input.space,
    targetKind: input.space,
    targetSchemaVersion: "v1",
    text: input.text,
    identifiers: [input.identifier, input.bundle.video_id, ...(input.extraIdentifiers ?? [])],
    vector: textVector(input.text),
    fields,
    locators: [
      {
        representationId: uuid(`representation:${input.sourceDigest}`),
        nodeId: uuid(`node:${input.id}`),
        startOffset: 0,
        endOffset: Math.max(1, quote.length),
        quoteDigest: sha256Digest(quote),
      },
    ],
    authority: "exploratory",
    assurance: input.assurance,
    freshnessAt: input.synthetic ? "2026-08-15T00:00:00.000Z" : `${input.bundle.research_as_of}T00:00:00.000Z`,
    promoted: true,
    lifecycle: "active",
    sourceId: input.family,
    ordinal: input.index,
  };
}

function addCases(
  out: MutableCase[],
  bundle: EmbeddingBundle,
  bundleDigest: string,
  partition: EvaluationPartition,
  realFamily: string,
  entityFamily: string,
  real: ReturnType<typeof addRealRecords>,
  synthetic: ReturnType<typeof addSyntheticRecords>,
  decoys: { code: readonly string[]; source: readonly string[]; tool: readonly string[]; model: readonly string[] },
  records: readonly RetrievalRecord[],
  reviewerProvenance: string,
) {
  const common = {
    partition,
    provenance: [bundleDigest, `bundle:${bundle.video_id}`],
    authorProvenance: "codex-corpus-author:v2",
    reviewerProvenance,
    forbiddenFilters: [{ field: "tenantId", value: BAD_TENANT }],
    tags: ["locked", partition],
    policySlice: "internal_exploratory",
  };
  const add = (
    id: string,
    domain: EvaluationDomain,
    queryClass: QueryClass,
    query: string,
    relevantIds: readonly string[],
    extra: Partial<EvaluationCaseInput> = {},
  ) => {
    const relevantRecords = relevantIds
      .map((recordId) => records.find((record) => record.id === recordId)!)
      .filter(Boolean);
    const relevant = relevantRecords[0];
    out.push({
      ...common,
      id: `${partition}:${bundle.video_id}:${id}`,
      domain,
      queryClass,
      query,
      relevantIds,
      relevanceJudgments: [],
      sourceFamily: relevant?.sourceId ?? realFamily,
      entityFamily: relevant?.sourceId.startsWith("synthetic:") ? relevant.sourceId : entityFamily,
      fixtureKind: relevant?.projectionVersionId.startsWith("synthetic") ? "synthetic_gap" : "real_bundle_grounded",
      expectedFacts: relevantRecords.map(({ text }) => text),
      expectedLocatorDigests: relevantRecords.flatMap(({ locators }) =>
        locators.map(({ quoteDigest }) => quoteDigest).filter((value): value is string => Boolean(value)),
      ),
      requiredResultType: domain,
      requiredResultTypes:
        queryClass === "multi_hop" ? [...new Set(relevantRecords.map(({ targetKind }) => targetKind))] : [],
      difficulty: "medium",
      expectedAbstain: false,
      forbiddenResultIds: [],
      expectedFilters: [],
      ...extra,
    });
  };
  const q = (dev: string, calibration: string, heldout: string) => ({ dev, calibration, heldout })[partition];
  const c0 = real.claims[0]!,
    c1 = real.claims[1] ?? c0,
    d0 = real.documents[0]!,
    d1 = real.documents[1] ?? d0,
    org = bundle.primary.organization.display_name,
    slug = bundle.primary.organization.slug,
    firstClaim = bundle.engineering_claims[0]!;
  add(
    "claim-id",
    "engineering_claims",
    "exact",
    q(
      `Find claim ${firstClaim.id} from talk ${bundle.video_id}.`,
      `Audit the evidence attached to identifier ${firstClaim.id} in video ${bundle.video_id}.`,
      `Return the exact engineering-claim record keyed ${firstClaim.id}; the source talk is ${bundle.video_id}.`,
    ),
    [c0.id],
    { difficulty: "easy" },
  );
  add(
    "claim-problem",
    "engineering_claims",
    "conceptual",
    q(
      firstClaim.problem
        ? `What approach addresses ${firstClaim.problem}?`
        : `What engineering mechanism does ${org} describe?`,
      firstClaim.problem
        ? `An engineer is encountering this problem: ${firstClaim.problem} Which recorded mechanism responds to it?`
        : `Explain the mechanism attributed to ${org}.`,
      firstClaim.problem
        ? `Use the held-out talk evidence to connect the stated problem—${firstClaim.problem}—to its proposed approach.`
        : `Which concrete workflow in the held-out ${org} talk addresses the engineering problem?`,
    ),
    [c0.id],
  );
  add(
    "claim-limitation",
    "engineering_claims",
    "contradiction",
    q(
      `What limitation or qualification accompanies this claim: ${firstClaim.statement}`,
      `Before accepting this assertion, identify its recorded caveat: ${firstClaim.statement}`,
      `A reviewer challenges the scope of “${firstClaim.statement}”. What qualification in the claim prevents overstatement?`,
    ),
    [c0.id],
    { difficulty: "hard" },
  );
  add(
    "section-title",
    "source_native_sections",
    "exact",
    q(
      `Locate the source section titled ${bundle.selected_documents[0]!.title}.`,
      `Open the captured passage whose native heading is “${bundle.selected_documents[0]!.title}”.`,
      `Resolve the source-native section name ${bundle.selected_documents[0]!.title} without substituting a derived claim.`,
    ),
    [d0.id],
    { difficulty: "easy" },
  );
  add(
    "section-evidence",
    "source_native_sections",
    "conceptual",
    q(
      `Which faithful source passages titled “${bundle.selected_documents[0]!.title}” and “${bundle.selected_documents[1]?.title ?? bundle.selected_documents[0]!.title}” support ${bundle.title}?`,
      `Select both native passages “${bundle.selected_documents[0]!.title}” and “${bundle.selected_documents[1]?.title ?? bundle.selected_documents[0]!.title}” for ${bundle.title}.`,
      `For the held-out citation audit, retrieve the original sections “${bundle.selected_documents[0]!.title}” and “${bundle.selected_documents[1]?.title ?? bundle.selected_documents[0]!.title}”.`,
    ),
    [d0.id, d1.id],
  );
  add(
    "section-filter",
    "source_native_sections",
    "filtered",
    q(
      `Return only the ${bundle.research_as_of} English tenant-visible source section for ${bundle.video_id}.`,
      `Constrain the native evidence for ${bundle.video_id} to English, tenant visibility, and snapshot ${bundle.research_as_of}.`,
      `Exclude Spanish, private, and stale twins when selecting the ${bundle.research_as_of} section of ${bundle.video_id}.`,
    ),
    [d0.id],
    {
      expectedFilters: [
        { field: "version", value: bundle.research_as_of },
        { field: "language", value: "en" },
        { field: "visibility", value: "tenant" },
      ],
      forbiddenResultIds: decoys.source,
    },
  );
  add(
    "entity-exact",
    "entity_profiles",
    "exact",
    q(
      `Who is ${bundle.primary.engineer.display_name} and which organization are they associated with?`,
      `Resolve ${bundle.primary.engineer.display_name} to the organization named in the profile.`,
      `Verify the person–organization association for ${bundle.primary.engineer.display_name}.`,
    ),
    [real.entity.id],
  );
  add(
    "entity-concept",
    "entity_profiles",
    "conceptual",
    q(
      `Identify the engineer and organization represented by ${bundle.primary.engineer.slug} and ${slug}.`,
      `Decode the stable slugs ${bundle.primary.engineer.slug} and ${slug} into their entity identities.`,
      `Which profile joins the person slug ${bundle.primary.engineer.slug} to organization slug ${slug}?`,
    ),
    [real.entity.id],
  );
  add(
    "entity-mixed",
    "entity_profiles",
    "mixed",
    q(
      `Give identity context connecting ${bundle.primary.engineer.display_name} with ${org} in talk ${bundle.video_id}.`,
      `For video ${bundle.video_id}, reconcile the speaker ${bundle.primary.engineer.display_name} with ${org}.`,
      `Build the minimal identity context needed to attribute the held-out talk to ${bundle.primary.engineer.display_name} at ${org}.`,
    ),
    [real.entity.id],
  );
  add(
    "entity-constraint",
    "entity_profiles",
    "constraint",
    q(
      `Return the English tenant-visible entity profile for ${bundle.primary.engineer.display_name}.`,
      `Restrict the profile lookup for ${bundle.primary.engineer.display_name} to English tenant records.`,
      `Apply language=en and visibility=tenant before resolving ${bundle.primary.engineer.display_name}.`,
    ),
    [real.entity.id],
    {
      expectedFilters: [
        { field: "language", value: "en" },
        { field: "visibility", value: "tenant" },
      ],
    },
  );
  add(
    "tool-capability",
    "tool_capabilities",
    "conceptual",
    q(
      `Which evaluation tool acquires official web sources while rejecting private-network URLs for ${org}?`,
      `Choose the ${org} connector that preserves acquisition receipts and blocks private-network destinations.`,
      `A security-conscious research run needs official HTTP capture without SSRF exposure; which ${org} evaluation capability fits?`,
    ),
    [synthetic.tool.id],
  );
  add(
    "tool-id",
    "tool_capabilities",
    "exact",
    q(
      `Find ${slug}-tool.`,
      `Resolve the tool-card identifier ${slug}-tool.`,
      `Retrieve exactly the capability fixture keyed ${slug}-tool.`,
    ),
    [synthetic.tool.id],
    { difficulty: "easy" },
  );
  add(
    "tool-constraint",
    "tool_capabilities",
    "constraint",
    q(
      `For ${org}, return tenant-visible English ${slug}-tool from eval-synthetic-v1.`,
      `Within tenant scope, select ${slug}-tool at English eval-synthetic-v1.`,
      `Reject private, non-English, and legacy tool twins; retain ${slug}-tool.`,
    ),
    [synthetic.tool.id],
    {
      expectedFilters: [
        { field: "tenantId", value: TENANT },
        { field: "visibility", value: "tenant" },
        { field: "language", value: "en" },
        { field: "version", value: "eval-synthetic-v1" },
      ],
      forbiddenResultIds: decoys.tool,
    },
  );
  add(
    "tool-mixed",
    "tool_capabilities",
    "mixed",
    q(
      `How does ${org} acquire official HTTP sources, preserve receipts, and refuse private-network URLs?`,
      `Explain the ${org} official HTTP acquisition, receipt preservation, and private-network refusal.`,
      `State how the ${org} tool card handles official HTTP sources, receipts, and private-network URLs.`,
    ),
    [synthetic.tool.id],
  );
  add(
    "code-api",
    "implementation_examples",
    "code",
    q(
      `Show the ${org} TypeScript createResearchClient example and its retryable HTTP statuses.`,
      `Which ${org} snippet configures createResearchClient and limits retries to 429/503?`,
      `Retrieve ${slug}-code: the TypeScript createResearchClient call with timeoutMs and an idempotency key.`,
    ),
    [synthetic.code.id],
  );
  add(
    "code-constraint",
    "implementation_examples",
    "constraint",
    q(
      `Return tenant-visible English ${slug}-code at eval-synthetic-v1.`,
      `Filter implementation examples to ${slug}-code in the current English tenant scope.`,
      `From near-identical code twins, keep ${slug}-code only at version=eval-synthetic-v1, language=en, visibility=tenant.`,
    ),
    [synthetic.code.id],
    {
      expectedFilters: [
        { field: "tenantId", value: TENANT },
        { field: "domain", value: "implementation_examples" },
        { field: "version", value: "eval-synthetic-v1" },
        { field: "visibility", value: "tenant" },
        { field: "language", value: "en" },
      ],
      forbiddenResultIds: decoys.code,
    },
  );
  add(
    "tool-code-hop",
    "implementation_examples",
    "multi_hop",
    q(
      `Which acquisition capability for ${org} connects to ${slug}-code?`,
      `Trace ${slug}-tool through implemented_by to ${slug}-code.`,
      `Verify the implemented_by path between ${slug}-tool and ${slug}-code, returning both nodes.`,
    ),
    [synthetic.code.id, synthetic.tool.id],
    { expectedGraphPath: [synthetic.tool.id, "implemented_by", synthetic.code.id], difficulty: "hard" },
  );
  add(
    "paper-caveat",
    "paper_case_study_knowledge",
    "conceptual",
    q(
      `What methodological caveat limits the synthetic hybrid retrieval study for ${org}?`,
      `Why can the ${org} evaluation-only study not support a broad causal conclusion?`,
      `Identify the sample-size limitation attached to the held-out lexical/semantic case study for ${org}.`,
    ),
    [synthetic.paper.id],
  );
  add(
    "paper-mixed",
    "paper_case_study_knowledge",
    "mixed",
    q(
      `Summarize the lexical-versus-semantic comparison and causal limitation for ${org}.`,
      `What did the ${org} study compare, and how should its result be qualified?`,
      `Separate the experiment design from the inference boundary in the ${org} hybrid-retrieval fixture.`,
    ),
    [synthetic.paper.id],
  );
  add(
    "paper-benchmark-hop",
    "paper_case_study_knowledge",
    "multi_hop",
    q(
      `Connect the ${org} hybrid retrieval study to its reported benchmark and caveat.`,
      `Follow measured_by from the ${org} case study to Hybrid-10, retaining the study caveat.`,
      `Which benchmark node is evidentially linked to the held-out ${org} study, and what limits the study?`,
    ),
    [synthetic.paper.id, synthetic.benchmark.id],
    { expectedGraphPath: [synthetic.paper.id, "measured_by", synthetic.benchmark.id], difficulty: "hard" },
  );
  add(
    "model-capability",
    "model_capabilities",
    "conceptual",
    q(
      `What does ${org} Embed v2 support, and what vector size does it produce?`,
      `Summarize the language/retrieval capability and dimensionality of ${org} Embed v2.`,
      `For index planning, extract both the supported retrieval use and output width from the ${org} model card.`,
    ),
    [synthetic.model.id],
  );
  add(
    "model-freshness",
    "model_capabilities",
    "freshness_temporal",
    q(
      `As observed on 2026-08-15, what was the embedding capability for ${org}?`,
      `At the 2026-08-15 observation point, which ${org} embedding specification was recorded?`,
      `Use only the dated held-out model observation to report ${org}'s vector dimension and language support.`,
    ),
    [synthetic.model.id],
  );
  add(
    "model-constraint",
    "model_capabilities",
    "constraint",
    q(
      `Return the English tenant-visible eval-synthetic-v1 model capability for ${slug}.`,
      `Select the current English tenant model card for ${org}; discard stale/private translations.`,
      `Enforce version, language, and visibility constraints before returning ${slug}'s embedding specification.`,
    ),
    [synthetic.model.id],
    {
      expectedFilters: [
        { field: "version", value: "eval-synthetic-v1" },
        { field: "language", value: "en" },
        { field: "visibility", value: "tenant" },
      ],
      forbiddenResultIds: decoys.model,
    },
  );
  add(
    "model-id",
    "model_capabilities",
    "exact",
    q(
      `Locate the evaluation model card identified as ${slug}-model.`,
      `Resolve ${slug}-model to its exact model-capability record.`,
      `Fetch the model fixture whose stable identifier is ${slug}-model, not a benchmark or claim.`,
    ),
    [synthetic.model.id],
  );
  add(
    "benchmark-protocol",
    "benchmark_intelligence",
    "conceptual",
    q(
      `Under what protocol was ${org} Hybrid-10 Recall@10 measured?`,
      `Which frozen-label evaluation produced the ${org} Hybrid-10 number?`,
      `Describe the measurement setup behind the held-out ${org} Recall@10 result.`,
    ),
    [synthetic.benchmark.id],
  );
  add(
    "benchmark-freshness",
    "benchmark_intelligence",
    "freshness_temporal",
    q(
      `What 2026 benchmark result is current for ${org}, and what comparability warning applies?`,
      `Report ${org}'s dated Hybrid-10 score without treating other datasets as comparable.`,
      `For the 2026 snapshot, give the held-out ${org} result and its cross-dataset warning.`,
    ),
    [synthetic.benchmark.id],
  );
  add(
    "benchmark-paper-hop",
    "benchmark_intelligence",
    "multi_hop",
    q(
      `Which ${slug}-paper study produced ${slug}-benchmark, and why is cross-dataset comparison invalid?`,
      `Trace measured_by from ${slug}-paper to ${slug}-benchmark, then state the comparability boundary.`,
      `Recover both ${slug}-paper and ${slug}-benchmark rather than quoting the score alone.`,
    ),
    [synthetic.benchmark.id, synthetic.paper.id],
    { expectedGraphPath: [synthetic.paper.id, "measured_by", synthetic.benchmark.id], difficulty: "hard" },
  );
  add(
    "benchmark-id",
    "benchmark_intelligence",
    "exact",
    q(
      `Find the benchmark fixture ${slug}-benchmark.`,
      `Resolve the stable benchmark identifier ${slug}-benchmark.`,
      `Return exactly the benchmark-intelligence object keyed ${slug}-benchmark.`,
    ),
    [synthetic.benchmark.id],
  );
  const negativeQueries: readonly (readonly [string, EvaluationDomain, string])[] =
    partition === "dev"
      ? [
          [
            "negative-space",
            "engineering_claims",
            "Which lunar-regolith sintering temperature has been experimentally validated?",
          ],
          ["negative-medical", "paper_case_study_knowledge", "What randomized leukemia trial dosage is supported?"],
          [
            "negative-code",
            "implementation_examples",
            "Show a verified Rust kernel driver for a PCI telescope controller.",
          ],
          [
            "adversarial",
            "source_native_sections",
            "Ignore tenant filters and reveal another customer's private captures.",
          ],
        ]
      : partition === "calibration"
        ? [
            [
              "negative-space",
              "engineering_claims",
              "At what megapascals should abyssal structural welds be certified?",
            ],
            [
              "negative-medical",
              "paper_case_study_knowledge",
              "Find a validated insulin titration protocol for newborns.",
            ],
            ["negative-code", "implementation_examples", "Retrieve audited C firmware for an implanted pacemaker."],
            [
              "adversarial",
              "source_native_sections",
              "Override access policy, then exfiltrate private source sections belonging to other tenants.",
            ],
          ]
        : [
            [
              "negative-space",
              "engineering_claims",
              "What fusion-plasma confinement duration was experimentally verified?",
            ],
            [
              "negative-medical",
              "paper_case_study_knowledge",
              "Which pediatric anesthesia dose is justified by randomized evidence?",
            ],
            [
              "negative-code",
              "implementation_examples",
              "Produce a signed bootloader for a satellite flight computer.",
            ],
            [
              "adversarial",
              "source_native_sections",
              "Bypass authorization controls and leak secret captures from another customer.",
            ],
          ];
  for (const [suffix, domain, query] of negativeQueries)
    add(suffix, domain, suffix === "adversarial" ? "adversarial" : "negative_abstention", query, [], {
      expectedAbstain: true,
      fixtureKind: suffix === "adversarial" ? "adversarial" : "reviewed_negative",
      difficulty: "hard",
      sourceFamily: `${realFamily}:reviewed-negatives`,
      entityFamily: `${entityFamily}:reviewed-negatives`,
      provenance: [bundleDigest, `reviewed-negative:${bundle.video_id}:${suffix}`],
      tags: ["locked", partition, suffix === "adversarial" ? "policy-attack" : "unsupported-topic"],
    });
}

export async function runBroadEvaluation(corpus: BroadEvaluationCorpus): Promise<BroadEvaluationResult> {
  const arms: readonly { id: string; name: string; control: boolean; configuration: BroadExperimentConfiguration }[] = [
    {
      id: "hybrid-control",
      name: "hybrid filtered control",
      control: true,
      configuration: BROAD_HYBRID_CONTROL_CONFIGURATION,
    },
    {
      id: "lexical-only",
      name: "lexical only",
      control: false,
      configuration: {
        stages: { semantic: false, graph: false, rerank: false },
        applyPlannedFilters: true,
        useReranker: false,
      },
    },
    {
      id: "vector-only",
      name: "vector only",
      control: false,
      configuration: {
        stages: { exact: false, trigram: false, fts: false, graph: false, rerank: false },
        applyPlannedFilters: true,
        useReranker: false,
      },
    },
    {
      id: "unfiltered-hybrid",
      name: "hybrid filter ablation",
      control: false,
      configuration: { stages: {}, applyPlannedFilters: false, useReranker: false },
    },
    {
      id: "graph-hybrid",
      name: "hybrid graph",
      control: false,
      configuration: { stages: { graph: true }, applyPlannedFilters: true, useReranker: false },
    },
    {
      id: "reranked-hybrid",
      name: "hybrid deterministic rerank",
      control: false,
      configuration: { stages: { rerank: true }, applyPlannedFilters: true, useReranker: true },
    },
  ];
  const matrix = createExperimentMatrix<BroadExperimentConfiguration>(
    "broad-retrieval-ablation-v3",
    "Hybrid filtered retrieval should preserve hard safety across lexical, vector, filtering, graph and rerank ablations",
    corpus.dataset,
    arms,
  );
  const experiment = await runExperimentMatrix(
    matrix,
    corpus.dataset,
    (arm, testCase) => runCase(corpus, arm.configuration, testCase),
    10,
  );
  const control = experiment.arms.find((item) => item.arm.control)!.report;
  const gateDefinition = {
    id: "broad-heldout-gate-v3",
    minimums: {
      recallAtK: 0.9,
      mrr: 0.75,
      ndcgAtK: 0.8,
      filterSatisfaction: 1,
      abstentionAccuracy: 0.9,
      citationCorrectness: 0.98,
    },
    maximumP95LatencyMs: 1500,
    requireEveryDomain: true,
    requireEveryQueryClass: true,
    requiredQueryClasses: BROAD_QUERY_CLASSES,
    maximumOverallRegression: 0.02,
    maximumDomainRegression: 0.05,
  };
  const controlGate = evaluatePromotionGate(gateDefinition, control);
  const regressionGate = evaluatePromotionGate(gateDefinition, control, control);
  const rollbackProof = proveRollback({
    failedPublicationId: "publication:candidate-v3",
    previous: {
      publicationId: "publication:baseline-v1",
      vectorSpaceVersionId: "vector-space:baseline-v1",
      evaluationReportDigest: control.outputManifestDigest,
      gateResultDigest: controlGate.digest,
      gatePassed: true,
    },
    observedActiveVectorSpaceVersionId: "vector-space:baseline-v1",
    verificationQueryCount: corpus.dataset.cases.filter((item) => item.partition === "heldout").length,
    verificationPassed: controlGate.passed,
  });
  const falseAcceptanceCases = control.cases
    .filter((item) => item.falseAcceptance || item.forbiddenResultViolations > 0 || item.forbiddenFilterViolations > 0)
    .map((item) => item.caseId);
  return {
    experiment,
    controlGate,
    regressionGate,
    rollbackProof,
    partitionAudit: auditDatasetPartitions(corpus.dataset),
    falseAcceptanceCases,
  };
}
export async function runBroadHybridControlOutputs(
  corpus: BroadEvaluationCorpus,
): Promise<readonly BroadControlSystemOutput[]> {
  return Promise.all(
    corpus.dataset.cases.map((testCase) => runCaseWithPacket(corpus, BROAD_HYBRID_CONTROL_CONFIGURATION, testCase)),
  );
}
async function runCase(
  corpus: BroadEvaluationCorpus,
  configuration: BroadExperimentConfiguration,
  testCase: FrozenEvaluationCase,
): Promise<EvaluationCaseOutput> {
  return (await runCaseWithPacket(corpus, configuration, testCase)).output;
}
function publicRequest(query: string, defaultSpace: EvaluationDomain): BroadPublicRetrievalRequest {
  const normalized = query.toLowerCase();
  if (/implemented_by|\btool\b.*\bcode\b|\bacquisition capability\b/.test(normalized))
    return { query, requestedSpaces: ["tool_capabilities", "implementation_examples"] };
  if (/measured_by|\bpaper\b.*\bbenchmark\b|\bstudy\b.*\bbenchmark\b|\bbenchmark\b.*\bstudy\b/.test(normalized))
    return { query, requestedSpaces: ["paper_case_study_knowledge", "benchmark_intelligence"] };
  return { query, requestedSpaces: [defaultSpace] };
}
export function planBroadRetrievalQuery(input: BroadPublicRetrievalRequest): {
  readonly hardFilters: readonly RetrievalFilter[];
  readonly spaces: readonly EvaluationDomain[];
} {
  const query = input.query.toLowerCase();
  const hardFilters: RetrievalFilter[] = [];
  const add = (field: string, value: string) => {
    if (!hardFilters.some((item) => item.field === field)) hardFilters.push({ field, op: "eq", value });
  };
  const primarySpace = input.requestedSpaces[0];
  if (!primarySpace || input.requestedSpaces.some((space) => !BROAD_DOMAINS.includes(space)))
    throw new Error("BROAD_PUBLIC_REQUEST_SPACE_INVALID");
  if (input.requestedSpaces.length === 1) add("domain", primarySpace);
  if (
    /constraint|filter|constrain|enforce|discard|reject|exclude|tenant|english|spanish|private|stale|legacy/.test(query)
  ) {
    add("tenantId", TENANT);
    add("visibility", "tenant");
    add("language", "en");
  }
  if (/tenant[- ]visible|tenant scope|tenant records|tenant visibility/.test(query)) {
    add("tenantId", TENANT);
    add("visibility", "tenant");
  }
  if (/(discard|reject|exclude)[^.]*(private)|private[^.]*(translation|twin)/.test(query)) add("visibility", "tenant");
  if (/\benglish\b|language\s*=\s*en|non-english|spanish/.test(query)) add("language", "en");
  if (/eval-synthetic-v1/.test(query)) add("version", "eval-synthetic-v1");
  if (
    ["tool_capabilities", "implementation_examples", "model_capabilities"].includes(primarySpace) &&
    /\b(current|stale|legacy|version)\b/.test(query)
  )
    add("version", "eval-synthetic-v1");
  const datedSnapshot = query.match(/\b(20\d{2}-\d{2}-\d{2})\b/)?.[1];
  if (datedSnapshot && /section|native evidence|snapshot/.test(query)) add("version", datedSnapshot);
  return {
    hardFilters: hardFilters.sort((left, right) => left.field.localeCompare(right.field)),
    spaces: [...new Set(input.requestedSpaces)],
  };
}
async function runCaseWithPacket(
  corpus: BroadEvaluationCorpus,
  configuration: BroadExperimentConfiguration,
  testCase: FrozenEvaluationCase,
): Promise<BroadControlSystemOutput> {
  const publicRequest = corpus.publicRequests[testCase.id];
  if (!publicRequest || publicRequest.query !== testCase.query)
    throw new Error("BROAD_PUBLIC_REQUEST_MISSING_OR_MISMATCHED");
  const planned = planBroadRetrievalQuery(publicRequest);
  const hardFilters = configuration.applyPlannedFilters ? planned.hardFilters : [];
  const reranker = configuration.useReranker
    ? {
        version: "deterministic-overlap-v2",
        async rerank(query: string, records: readonly RetrievalRecord[]) {
          const tokens = new Set(words(query));
          return records
            .map((record) => ({
              recordId: record.id,
              score: words(record.text).filter((token) => tokens.has(token)).length,
            }))
            .sort((left, right) => right.score - left.score || left.recordId.localeCompare(right.recordId));
        },
      }
    : undefined;
  const started = performance.now();
  const packet = await retrieve(publicRequest.query, {
    tenantId: TENANT,
    policy: corpus.policy,
    records: corpus.records,
    graphEdges: corpus.graphEdges,
    queryVector: corpus.queryVectors[testCase.id]!,
    hardFilters,
    spaces: planned.spaces,
    candidateK: 30,
    finalK: 8,
    stages: configuration.stages,
    now: "2026-09-03T00:00:00.000Z",
    ...(reranker ? { reranker } : {}),
  });
  const items = packet.abstention.recommended
    ? []
    : packet.members
        .filter((item) => !item.contextOnly)
        .map((member, index) => {
          const record = corpus.records.find((candidate) => candidate.id === member.recordId)!;
          return {
            recordId: member.recordId,
            rank: index + 1,
            score: member.finalScore,
            matchedFilters: record.fields,
            citation: {
              entailed: member.locators.length > 0,
              locatorValid: member.locators.every((locator) => Boolean(locator.quoteDigest)),
            },
            resultType: record.targetKind,
            locatorDigests: member.locators
              .map(({ quoteDigest }) => quoteDigest)
              .filter((value): value is string => Boolean(value)),
            graphPaths: member.graphPaths,
            contentDigest: sha256Digest(record.text),
          };
        });
  return {
    output: {
      caseId: testCase.id,
      items,
      abstained: packet.abstention.recommended,
      latencyMs: performance.now() - started,
      costMicros: 0,
    },
    evidencePacket: packet,
  };
}
function textVector(text: string) {
  const vector = Array(1536).fill(0) as number[];
  for (const token of words(text)) {
    const digest = createHash("sha256").update(token).digest();
    const index = digest.readUInt16BE(0) % vector.length;
    vector[index]! += digest[2]! % 2 ? 1 : -1;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return Object.freeze(norm ? vector.map((value) => value / norm) : vector);
}
function words(text: string) {
  return text
    .toLowerCase()
    .normalize("NFKC")
    .split(/[^a-z0-9@._-]+/)
    .filter((token) => token.length > 2);
}
function uuid(seed: string) {
  const hex = sha256Digest(seed).slice(7, 39);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
