import { randomUUID } from "node:crypto";
import { sha256Digest } from "@aiengineer/knowledge-core";
import { PostgresPreparationRepository, PostgresGovernedIndexRepository } from "@aiengineer/knowledge-persistence";

const POLICY = "synthetic-current-schema-fixture/v1";
const PRODUCER = "service:synthetic-p0-producer";
const REVIEWER = "service:synthetic-p0-reviewer";
const REVIEW_ROLE = "synthetic_service_reviewer";
const NOW = "2026-09-13T12:00:00.000Z";
const TEXT = "Synthetic P0 organization was founded on January 1, 2026 and is operating.";

async function bootstrap(database, tenantId) {
  const parents = {
    missionId: randomUUID(),
    workItemId: randomUUID(),
    attemptId: randomUUID(),
    entityId: randomUUID(),
  };
  await database.transaction(tenantId, async (client) => {
    await client.query("insert into orchestration.mission(id,tenant_id,goal) values($1,$2,$3)", [
      parents.missionId,
      tenantId,
      "Synthetic isolated P0 schema compatibility proof; no human approval",
    ]);
    await client.query(
      "insert into orchestration.work_item(id,tenant_id,mission_id,kind) values($1,$2,$3,'build_vectors')",
      [parents.workItemId, tenantId, parents.missionId],
    );
    await client.query(
      "insert into orchestration.attempt(id,tenant_id,work_item_id,attempt_no,agent_deployment_id) values($1,$2,$3,1,$4)",
      [parents.attemptId, tenantId, parents.workItemId, PRODUCER],
    );
    const intentId = randomUUID();
    const receiptId = randomUUID();
    await client.query(
      `insert into orchestration.operation_intent(id,tenant_id,intent_type,schema_version,payload,
      preconditions,idempotency_key,proposed_by_attempt,mission_id,approval_state,policy_decision)
      values($1,$2,'knowledge_ingestion',1,'{"synthetic":true,"purpose":"entity-bootstrap"}','{}',$3,$4,$5,'approved',
        '{"mode":"synthetic-service-fixture","humanApproval":false}')`,
      [intentId, tenantId, `synthetic-bootstrap:${intentId}`, parents.attemptId, parents.missionId],
    );
    await client.query(
      `insert into orchestration.operation_receipt(id,intent_id,executor_version,outcome,changes_summary,affected_refs)
      values($1,$2,$3,'applied','{"synthetic":true}', $4::jsonb)`,
      [receiptId, intentId, POLICY, JSON.stringify([{ schema: "corpus", table: "entity", id: parents.entityId }])],
    );
    await client.query(
      "insert into corpus.entity(id,tenant_id,kind,slug,display_name,created_by_receipt_id) values($1,$2,'organization',$3,$4,$5)",
      [parents.entityId, tenantId, `synthetic-p0-${parents.entityId}`, "Synthetic P0 organization", receiptId],
    );
    await client.query("insert into corpus.organization(id,tenant_id) values($1,$2)", [parents.entityId, tenantId]);
  });
  return parents;
}

async function operation(context, kind, actor = PRODUCER) {
  const id = randomUUID();
  await context.database.createOperation({
    id,
    tenantId: context.tenantId,
    operationKind: kind,
    missionId: context.parents.missionId,
    workItemId: context.parents.workItemId,
    attemptId: context.parents.attemptId,
    idempotencyKey: `synthetic-p0:${id}`,
    correlationId: randomUUID(),
    actorIdentity: actor,
    request: { schemaVersion: POLICY, synthetic: true, humanApproval: false },
    steps: [],
  });
  return id;
}

async function artifact(context, input) {
  const stored = await context.store.put({
    tenantId: context.tenantId,
    mediaType: input.mediaType,
    bytes: new TextEncoder().encode(input.text),
  });
  return {
    ...stored,
    artifactType: input.type,
    bucketClass: input.type === "source_capture" ? "source_captures" : "candidate",
    storageBucket: input.type === "source_capture" ? "source-captures" : "content-derivatives",
  };
}

async function review(context, input) {
  const decisionOperationId = await operation(context, "review_decision", REVIEWER);
  const subjectId = await context.database.createReviewSubject(context.tenantId, {
    id: randomUUID(),
    operationId: input.operationId,
    subjectKind: input.kind,
    subjectRef: input.ref,
    guardedSha256: input.digest.slice(7),
    eligibleRoles: [REVIEW_ROLE],
    quorumRequired: 1,
  });
  const reviewId = await context.database.recordReviewDecision(context.tenantId, {
    id: randomUUID(),
    reviewSubjectId: subjectId,
    guardedSha256: input.digest.slice(7),
    reviewerIdentity: REVIEWER,
    reviewerRole: REVIEW_ROLE,
    decision: "approve",
    rationale: "Synthetic service fixture decision; not human or production admission",
    decisionOperationId,
  });
  return {
    operationId: decisionOperationId,
    knowledgeReviewDecisionId: reviewId,
    guardedDigest: input.digest,
    reviewerIdentity: REVIEWER,
    decision: "accept",
    policyVersion: POLICY,
    rationale: "Synthetic compatibility fixture; no semantic validation claim",
  };
}

async function capture(context) {
  const sourceArtifact = await artifact(context, { text: TEXT, mediaType: "text/plain", type: "source_capture" });
  const operationId = await operation(context, "capture");
  const input = {
    operationId,
    sourceId: randomUUID(),
    captureId: randomUUID(),
    sourceClass: "web_page",
    canonicalUrl: `https://example.test/synthetic-p0/${context.tenantId}`,
    sensitivity: "public",
    artifact: sourceArtifact,
    captureMethod: "manual-upload@1.0.0",
    captureMethodVersion: "1.0.0",
    requestUrl: "https://example.test/synthetic-p0",
    observations: { synthetic: true, humanApproval: false },
    capturedAt: NOW,
  };
  const persisted = await context.preparation.persistCapture(context.tenantId, input);
  return { input, persisted, sourceArtifact };
}

async function represent(context, captured) {
  const representationId = randomUUID();
  const node = {
    id: randomUUID(),
    tenantId: context.tenantId,
    representationId,
    createdAt: NOW,
    ordinal: 0,
    stableLocalKey: "synthetic-paragraph",
    kind: "paragraph",
    text: TEXT,
    digest: sha256Digest(TEXT),
    locator: { representationId, startOffset: 0, endOffset: TEXT.length, quoteDigest: sha256Digest(TEXT) },
  };
  const structural = await artifact(context, {
    text: JSON.stringify({ synthetic: true, nodes: [node] }),
    mediaType: "application/json",
    type: "report_json",
  });
  const operationId = await operation(context, "transformation");
  const input = {
    operationId,
    transformationRunId: randomUUID(),
    sourceCaptureId: captured.input.captureId,
    sourceArtifact: captured.sourceArtifact,
    documentId: randomUUID(),
    documentKind: "official_docs",
    canonicalTitle: "Synthetic P0 schema fixture",
    canonicalSourceId: captured.input.sourceId,
    documentVersionId: randomUUID(),
    versionLabel: "synthetic-v1",
    manifestDigest: sha256Digest({ source: captured.sourceArtifact.digest }),
    sourceNativeRepresentationId: randomUUID(),
    structuralRepresentationId: representationId,
    providerKey: "synthetic-fixture",
    providerVersion: "1",
    profileDigest: sha256Digest(POLICY),
    requestDigest: sha256Digest({ synthetic: true }),
    receiptDigest: sha256Digest({ synthetic: true, conversion: "faithful-copy" }),
    outputArtifacts: [structural],
    structuralArtifactId: structural.artifactId,
    structuralArtifactDigest: structural.digest,
    nodes: [node],
    fidelity: { grade: "high", coverage: 1, locatorCoverage: 1, findings: [] },
    receipt: { synthetic: true, conversion: "faithful-copy", humanApproval: false },
    completedAt: NOW,
  };
  const persisted = await context.preparation.persistRepresentation(context.tenantId, input);
  const decision = await review(context, {
    operationId,
    kind: "representation",
    ref: { representationId },
    digest: structural.digest,
  });
  const decisionId = await context.governance.persistRepresentationDecision(context.tenantId, {
    ...decision,
    representationId,
  });
  return { input, persisted, node, structural, decisionId };
}

async function chunk(context, represented) {
  const operationId = await operation(context, "chunk_set");
  const chunkId = randomUUID();
  const input = {
    operationId,
    representationId: represented.input.structuralRepresentationId,
    procedureVersionId: randomUUID(),
    procedureSlug: `synthetic-p0-${context.tenantId}`,
    procedureVersion: "1",
    tokenizer: "unicode-word-punctuation-v1",
    profile: { synthetic: true, targetTokens: 64 },
    inputDigest: represented.structural.digest,
    outputDigest: sha256Digest({ tenant: context.tenantId, chunkId, text: TEXT }),
    chunkSetId: randomUUID(),
    chunks: [
      {
        id: chunkId,
        ordinal: 0,
        sourceText: TEXT,
        contextualPrefix: "",
        embeddingText: TEXT,
        sourceTextDigest: sha256Digest(TEXT),
        embeddingTextDigest: sha256Digest(TEXT),
        sourceTokenCount: 14,
        embeddingTokenCount: 14,
        role: "headings",
        spans: [
          {
            nodeId: represented.node.id,
            startOffset: 0,
            endOffset: TEXT.length,
            selectedTextDigest: sha256Digest(TEXT),
          },
        ],
      },
    ],
  };
  const persisted = await context.preparation.persistChunkSet(context.tenantId, input);
  return { input, persisted };
}

async function promote(context, prepared) {
  const procedureId = randomUUID();
  await context.database.transaction(context.tenantId, async (client) => {
    await client.query(
      `insert into retrieval.projection_procedure(id,slug,version,description,code_ref,implementation_sha256)
      values($1,$2,1,$3,$4,$5)`,
      [
        procedureId,
        `synthetic-p0-${context.tenantId}`,
        "Synthetic faithful chunk projection",
        "packages/ingestion/test/preparation-fixture.mjs",
        sha256Digest(POLICY).slice(7),
      ],
    );
  });
  const operationId = await operation(context, "promotion_proposal");
  const input = {
    operationId,
    chunkSetId: prepared.chunked.input.chunkSetId,
    representationDecisionId: prepared.represented.decisionId,
    projectionProcedureId: procedureId,
    purpose: "synthetic-compatibility-proof",
    contextualPrefix: "",
    language: "en",
    visibility: "private",
    classification: "public",
    targetDomains: ["engineering"],
    expectedValue: "current-schema compatibility",
    risks: ["synthetic evidence"],
    exclusions: ["production admission"],
    reason: "Synthetic fixture only",
    proposedBy: PRODUCER,
  };
  const proposal = await context.governance.persistProjectionProposal(context.tenantId, input);
  const decision = await review(context, {
    operationId,
    kind: "content_promotion",
    ref: { proposalId: proposal.proposalId },
    digest: proposal.proposalDigest,
  });
  const decisionId = await context.governance.persistPromotionDecision(context.tenantId, {
    ...decision,
    proposalId: proposal.proposalId,
    gates: { syntheticFixture: true, humanApproval: false },
  });
  return { input, proposal, decisionId };
}

/** Real SQL adapters and real local artifact bytes, with explicitly synthetic service admission. */
export async function prepareCurrentSchemaFixture(input) {
  const parents = await bootstrap(input.database, input.tenantId);
  const context = {
    ...input,
    parents,
    preparation: new PostgresPreparationRepository(input.database),
    governance: new PostgresGovernedIndexRepository(input.database),
  };
  const captured = await capture(context);
  const represented = await represent(context, captured);
  const chunked = await chunk(context, represented);
  const promoted = await promote(context, { represented, chunked });
  return {
    parents,
    captured,
    represented,
    chunked,
    promoted,
    sourceText: TEXT,
    policy: POLICY,
    producer: PRODUCER,
    reviewer: REVIEWER,
  };
}
