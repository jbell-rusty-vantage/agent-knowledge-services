import {
  PromotionSelectionApplication,
  type PromotionSelectionApplicationPorts,
  type PromotionSelectionOperation,
  type PromotionTargetSpace,
  type PromotionWork,
} from "@aiengineer/knowledge-application";
import {
  JsonValueSchema,
  OperationContextSchema,
  PromotionProposalInputSchema,
  PromotionSelectionAuthoritySchema,
  SelectedCandidateIndexInputSchema,
  Sha256DigestSchema,
  UuidSchema,
  VectorSpaceSchema,
  type PromotionProposalInput,
  type OperationKind,
} from "@aiengineer/knowledge-contracts";
import { sha256Digest } from "@aiengineer/knowledge-core";
import { deterministicUuid } from "@aiengineer/knowledge-core";
import {
  PostgresKnowledgeOperationService,
  sameActorIdentity,
  validatePromotionSelection,
  type PostgresCanonicalRepository,
  type PostgresGovernedIndexRepository,
  type PromotionSelectionArtifact,
  type PromotionSelectionConfiguration,
  type PromotionSelectionPorts,
} from "@aiengineer/knowledge-persistence";
import { z } from "zod";

type Row = Record<string, unknown>;
const digest = (value: unknown) => sha256Digest(JsonValueSchema.parse(value));
const stageKinds = { prepare: "promotion_proposal", embed: "embedding_run", index: "vector_store_ingestion" } as const;
const stageSteps = { prepare: ["propose"], embed: ["embed", "verify"], index: ["prepare", "embed", "index"] } as const;

type Environment = Readonly<Record<string, string | undefined>>;
const AUTHORITY_LOCATOR_JSON_MAX_BYTES = 4_096;

/** Locator is independently registered authority id+digest. Extra fields fail closed. */
export const PromotionSelectionAuthorityLocatorSchema = z.strictObject({
  id: UuidSchema,
  digest: Sha256DigestSchema,
});

export type ComposedPromotionSelectionHost = {
  readonly promotionSelection: PromotionSelectionConfiguration;
};

/**
 * Locator only: independently registered authority artifact id+digest.
 * Tenant, run pin, policy, budget and reviewer stay inside those bytes.
 */
export function parsePromotionSelectionAuthorityLocator(
  environment: Environment,
): PromotionSelectionArtifact | undefined {
  const raw = environment.PROMOTION_SELECTION_AUTHORITY_ARTIFACT_JSON?.trim();
  if (!raw) return undefined;
  if (Buffer.byteLength(raw, "utf8") > AUTHORITY_LOCATOR_JSON_MAX_BYTES)
    throw new Error("PROMOTION_SELECTION_RUNTIME_CONFIGURATION_TOO_LARGE");
  try {
    return PromotionSelectionAuthorityLocatorSchema.parse(JSON.parse(raw));
  } catch {
    throw new Error("PROMOTION_SELECTION_RUNTIME_CONFIGURATION_INVALID");
  }
}

/** Selection workers require a host-composed authority. Verification workers omit both locator and host. */
export function resolvePromotionSelectionHost(input: {
  readonly host: Partial<ComposedPromotionSelectionHost>;
  readonly locator?: PromotionSelectionArtifact;
  readonly persistenceMode: "postgres" | "memory";
}): PromotionSelectionConfiguration | undefined {
  if (input.locator === undefined && input.host.promotionSelection === undefined) return undefined;
  if (input.persistenceMode !== "postgres") throw new Error("PROMOTION_SELECTION_REQUIRES_POSTGRES");
  const authority = input.host.promotionSelection;
  if (!authority) throw new Error("PROMOTION_SELECTION_AUTHORITY_REQUIRED");
  return authority;
}

export function composePromotionSelectionWorkerHost(input: {
  readonly ports: PromotionSelectionPorts;
  readonly authorityArtifact: PromotionSelectionArtifact;
}): ComposedPromotionSelectionHost {
  return { promotionSelection: createPromotionSelectionConfiguration(input) };
}

export interface CanonicalPromotionSelectionConfiguration {
  readonly database: PostgresCanonicalRepository;
  readonly governance: PostgresGovernedIndexRepository;
  readonly authority: PromotionSelectionConfiguration;
  readonly proposal: PromotionProposalInput;
  readonly attemptId: string;
  readonly reviewerAttemptId: string;
  readonly correlationId: string;
  readonly capabilityVersion: string;
  readonly embeddingExecutorId: string;
  readonly origin: string;
  readonly spaces: readonly {
    space: PromotionTargetSpace;
    vectorSpaceVersionId: string;
    modelSlug: string;
    providerRoute: readonly string[];
  }[];
}

/**
 * Production selection authority. Tenant, run, policy, proposer, reviewer and
 * budget come from independently registered authority bytes on the same
 * transaction, so a selection can never pin its own admission limits.
 */
export function createPromotionSelectionConfiguration(configuration: {
  readonly ports: PromotionSelectionPorts;
  readonly authorityArtifact: PromotionSelectionArtifact;
}): PromotionSelectionConfiguration {
  const artifact: PromotionSelectionArtifact = { ...configuration.authorityArtifact };
  const ports = configuration.ports;
  return {
    selectionPorts: ports,
    async selectionAuthority(client, tenantId) {
      const bytes = await ports.readArtifact(client, { tenantId, artifact });
      const document = PromotionSelectionAuthoritySchema.parse(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown,
      );
      if (document.tenantId !== tenantId) throw new Error("PROMOTION_SELECTION_AUTHORITY_TENANT_MISMATCH");
      return {
        tenantId: document.tenantId,
        runPinDigest: document.runPinDigest,
        policyDigest: document.policyDigest,
        proposedBy: document.proposedBy,
        requiredReviewer: document.requiredReviewer,
        budget: document.budget,
      };
    },
  };
}

/** One explicitly pinned selection; canonical operations own scheduling, leases and retries. */
export function createCanonicalPromotionSelectionApplication(
  configuration: CanonicalPromotionSelectionConfiguration,
): PromotionSelectionApplication {
  return new PromotionSelectionApplication(new CanonicalPromotionSelectionPorts(configuration));
}

class CanonicalPromotionSelectionPorts implements PromotionSelectionApplicationPorts {
  private readonly configuration: CanonicalPromotionSelectionConfiguration;
  private readonly proposal: PromotionProposalInput;
  private readonly spaces: CanonicalPromotionSelectionConfiguration["spaces"];
  private readonly operations: PostgresKnowledgeOperationService;
  private readonly work: readonly PromotionWork[];

  constructor(configuration: CanonicalPromotionSelectionConfiguration) {
    this.configuration = { ...configuration };
    this.proposal = PromotionProposalInputSchema.parse(configuration.proposal);
    this.spaces = z
      .array(
        z.strictObject({
          space: VectorSpaceSchema,
          vectorSpaceVersionId: UuidSchema,
          modelSlug: z.string().trim().min(1),
          providerRoute: z.array(z.string().trim().min(1)).min(1).max(32),
        }),
      )
      .parse(configuration.spaces);
    UuidSchema.parse(configuration.reviewerAttemptId);
    UuidSchema.parse(this.proposal.selection.requiredReviewer);
    if (configuration.reviewerAttemptId === configuration.attemptId) throw new Error("PROMOTION_REVIEW_PIN_MISMATCH");
    const requested = [...new Set(this.proposal.selection.selected.flatMap((member) => member.targetSpaces))].sort();
    if (
      digest(this.spaces.map((pin) => pin.space).sort()) !== digest(requested) ||
      new Set(this.spaces.map((pin) => pin.vectorSpaceVersionId)).size !== this.spaces.length
    )
      throw new Error("PROMOTION_SPACE_PINS_MISMATCH");
    this.work = [
      { stage: "prepare" },
      ...requested.map((targetSpace) => ({ stage: "embed" as const, targetSpace })),
      { stage: "index" },
    ];
    this.operations = new PostgresKnowledgeOperationService(configuration.database);
    for (const work of this.work)
      this.context(work, deterministicUuid("promotion-selection-operation", this.key(work)));
  }

  private key(work: PromotionWork): string {
    return `promotion-selection:${this.proposal.selectionArtifact.digest}:${work.stage}${work.targetSpace ? `:${work.targetSpace}` : ""}`;
  }

  private assertTenant(tenantId: string): void {
    if (tenantId !== this.proposal.selection.tenantId) throw new Error("PROMOTION_TENANT_PIN_MISMATCH");
  }

  async authenticate(input: Parameters<PromotionSelectionApplicationPorts["authenticate"]>[0]) {
    if (
      digest(input.selection) !== digest(this.proposal.selection) ||
      digest(input.artifact) !== digest(this.proposal.selectionArtifact)
    )
      throw new Error("PROMOTION_SELECTION_PIN_MISMATCH");
    const { database, authority } = this.configuration;
    return database.transaction(this.proposal.selection.tenantId, async (client) => {
      const selected = await validatePromotionSelection(client, {
        selection: input.selection,
        artifact: input.artifact,
        authority: await authority.selectionAuthority(client, this.proposal.selection.tenantId),
        ports: authority.selectionPorts,
      });
      return { selectionDigest: selected.selectionDigest };
    });
  }

  private context(work: PromotionWork, operationId: string) {
    const producer = work.stage === "prepare";
    return OperationContextSchema.parse({
      tenantId: this.proposal.selection.tenantId,
      operationId,
      attemptId: this.configuration.attemptId,
      correlationId: this.configuration.correlationId,
      actor: {
        kind: "service",
        id: producer ? this.proposal.selection.proposedBy : this.configuration.embeddingExecutorId,
        serviceIdentity: producer ? "content_curator_agent" : "embedding_executor",
      },
      capabilityVersion: this.configuration.capabilityVersion,
      idempotencyKey: this.key(work),
      reason: this.proposal.reason,
      contractVersion: "v1",
    });
  }

  async findOperation(input: Parameters<PromotionSelectionApplicationPorts["findOperation"]>[0]) {
    this.assertTenant(input.tenantId);
    const work = this.work.find((item) => this.key(item) === input.idempotencyKey);
    if (!work) throw new Error("PROMOTION_OPERATION_KEY_NOT_PINNED");
    return (await this.readStage(work))?.operation;
  }

  async submitOperation(input: Parameters<PromotionSelectionApplicationPorts["submitOperation"]>[0]) {
    this.assertTenant(input.tenantId);
    await this.authenticate({ selection: input.selection, artifact: input.artifact });
    const work = this.work.find((item) => this.key(item) === input.idempotencyKey);
    if (!work || work.stage !== input.stage || work.targetSpace !== input.targetSpace)
      throw new Error("PROMOTION_OPERATION_KEY_NOT_PINNED");
    const payload = await this.payload(work);
    const operationId = deterministicUuid("promotion-selection-operation", this.key(work));
    await this.operations.submit(
      stageKinds[work.stage],
      { context: this.context(work, operationId), input: payload, expectedVersions: { api: "v1" } },
      this.configuration.origin,
    );
    const result = await this.readStage(work);
    if (!result) throw new Error("PROMOTION_OPERATION_SUBMISSION_NOT_RETAINED");
    return result.operation;
  }

  private async readStage(
    work: PromotionWork,
  ): Promise<{ operation: PromotionSelectionOperation; body: Row | null } | undefined> {
    const tenantId = this.proposal.selection.tenantId;
    const row = await this.configuration.database.transaction(
      tenantId,
      async (client) =>
        (
          await client.query<Row>(
            "select id from knowledge_service.operation where tenant_id=$1 and idempotency_key=$2",
            [tenantId, this.key(work)],
          )
        ).rows[0],
    );
    if (!row) return undefined;
    const operationId = String(row.id),
      payload = await this.payload(work);
    const record = await this.configuration.database.getOperationRecord(tenantId, operationId);
    const expectedContext = this.context(work, operationId);
    if (
      !record ||
      record.actorIdentity !== `service:${expectedContext.actor.id}` ||
      record.operationKind !== stageKinds[work.stage] ||
      record.idempotencyKey !== this.key(work) ||
      digest((record.request as Row).input) !== digest(payload) ||
      digest(record.request).slice(7) !== record.requestSha256
    )
      throw new Error("PROMOTION_RETAINED_OPERATION_MISMATCH");
    const steps = await this.configuration.database.listSteps(tenantId, operationId);
    if (steps.length !== stageSteps[work.stage].length) throw new Error("PROMOTION_RETAINED_STEPS_MISMATCH");
    for (const [ordinal, name] of stageSteps[work.stage].entries()) {
      const step = steps.find((item) => item.stepKey === name),
        expected = {
          schemaVersion: "knowledge-operation-request/v1",
          kind: stageKinds[work.stage],
          operationInput: payload,
          expectedVersions: { api: "v1" },
          context: this.context(work, operationId),
          step: { name, ordinal },
        };
      if (!step || digest(step.input) !== digest(expected) || step.inputSha256 !== digest(expected).slice(7))
        throw new Error("PROMOTION_RETAINED_CONTEXT_MISMATCH");
    }
    const states = ["queued", "running", "needs_review", "succeeded", "failed", "cancelled", "quarantined"] as const;
    if (!(states as readonly string[]).includes(record.status))
      throw new Error("PROMOTION_OPERATION_STATE_UNSUPPORTED");
    const terminal = stageSteps[work.stage].at(-1)!;
    const receipt =
      record.status === "succeeded"
        ? await this.receipt(operationId, stageKinds[work.stage], `${terminal}.succeeded`)
        : null;
    if (receipt && work.stage === "index") {
      const current = await this.configuration.governance.verifySelectedCandidate(
        tenantId,
        SelectedCandidateIndexInputSchema.parse(payload),
      );
      if (
        receipt.body.evidenceDigest !== current.evidenceDigest ||
        receipt.body.selectionDigest !== current.selectionDigest ||
        receipt.body.indexed !== true ||
        receipt.body.publishable !== false ||
        receipt.body.stage !== "index"
      )
        throw new Error("PROMOTION_INDEX_RECEIPT_MISMATCH");
    }
    return {
      operation: {
        operationId,
        idempotencyKey: this.key(work),
        selectionDigest: this.proposal.selectionArtifact.digest,
        ...work,
        status: record.status as (typeof states)[number],
        receiptId: receipt?.id ?? null,
      },
      body: receipt?.body ?? null,
    };
  }

  private async preparation() {
    const result = await this.readStage({ stage: "prepare" });
    if (!result?.body || !result.operation.receiptId || result.operation.status !== "succeeded")
      throw new Error("PROMOTION_PREPARATION_PENDING");
    return result as typeof result & { body: Row; operation: PromotionSelectionOperation & { receiptId: string } };
  }

  private async review() {
    const prepared = await this.preparation(),
      tenantId = this.proposal.selection.tenantId;
    const decision = await this.configuration.database.transaction(
      tenantId,
      async (client) =>
        (
          await client.query<Row>(
            `with latest as (
          select * from retrieval.content_promotion_decision where tenant_id=$1 and proposal_id=$2 order by created_at desc,id desc limit 1
        ) select d.*, (d.expires_at is null or d.expires_at>now()) and (s.expires_at is null or s.expires_at>now()) current,
          (not d.legacy_provenance and not r.legacy_provenance
            and r.id=d.knowledge_review_decision_id and r.decision_operation_id=d.decision_operation_id
            and r.guarded_sha256=d.guarded_sha256 and r.reviewer_identity=d.reviewer_identity
            and r.reviewer_role='human_reviewer' and r.decision=case when d.decision='accept' then 'approve' else d.decision end
            and s.id=$3 and s.operation_id=$4 and s.subject_kind='content_promotion' and s.guarded_sha256=d.guarded_sha256
            and s.quorum_required=1 and 'human_reviewer'=any(s.eligible_roles)
            and s.subject_ref->>'proposalId'=d.proposal_id::text
            and s.subject_ref->>'selectionDigest'=$5 and s.subject_ref->>'selectionArtifactId'=$6) provenance_valid
        from latest d left join knowledge_service.review_decision r on r.tenant_id=d.tenant_id and r.id=d.knowledge_review_decision_id
        left join knowledge_service.review_subject s on s.tenant_id=r.tenant_id and s.id=r.review_subject_id`,
            [
              tenantId,
              prepared.body.proposalId,
              prepared.body.reviewSubjectId,
              prepared.operation.operationId,
              this.proposal.selectionArtifact.digest,
              this.proposal.selectionArtifact.id,
            ],
          )
        ).rows[0],
    );
    if (!decision) return { prepared, decision: null, receipt: null };
    if (decision.provenance_valid !== true) throw new Error("PROMOTION_REVIEW_PROVENANCE_MISMATCH");
    const receipt = await this.receipt(
      String(decision.decision_operation_id),
      "promotion_decision",
      "decide.succeeded",
    );
    if (!receipt) return { prepared, decision: null, receipt: null };
    const steps = await this.configuration.database.listSteps(tenantId, String(decision.decision_operation_id));
    const step = steps.find((step) => step.stepKey === "decide"),
      stepInput = step?.input as Row;
    const context = OperationContextSchema.parse(stepInput?.context);
    const request = stepInput.operationInput as Row;
    const record = await this.configuration.database.getOperationRecord(
      tenantId,
      String(decision.decision_operation_id),
    );
    const attempts = await this.configuration.database.transaction(
      tenantId,
      async (client) =>
        (
          await client.query<Row>(
            `select p.agent_deployment_id producer,r.agent_deployment_id reviewer from orchestration.attempt p
        join orchestration.attempt r on r.tenant_id=p.tenant_id and r.id=$3 where p.tenant_id=$1 and p.id=$2`,
            [tenantId, this.configuration.attemptId, this.configuration.reviewerAttemptId],
          )
        ).rows[0],
    );
    const actor = context.actor;
    if (
      actor.kind !== "service" ||
      actor.serviceIdentity !== "human_reviewer" ||
      actor.id !== this.proposal.selection.requiredReviewer ||
      !step ||
      digest(step.input).slice(7) !== step.inputSha256 ||
      !record ||
      record.actorIdentity !== `service:${actor.id}` ||
      digest(record.request).slice(7) !== record.requestSha256 ||
      digest((record.request as Row).input) !== digest(request) ||
      request.reviewSubjectId !== prepared.body.reviewSubjectId ||
      request.proposalId !== prepared.body.proposalId ||
      request.guardedDigest !== prepared.body.proposalDigest ||
      request.decision !== decision.decision ||
      !attempts ||
      typeof attempts.producer !== "string" ||
      typeof attempts.reviewer !== "string" ||
      attempts.producer === attempts.reviewer ||
      context.tenantId !== tenantId ||
      context.operationId !== decision.decision_operation_id ||
      context.attemptId !== this.configuration.reviewerAttemptId ||
      context.attemptId === this.configuration.attemptId ||
      receipt.body.decisionId !== decision.id ||
      receipt.body.proposalId !== prepared.body.proposalId ||
      receipt.body.guardedDigest !== prepared.body.proposalDigest ||
      receipt.body.decision !== decision.decision ||
      !sameActorIdentity(String(decision.reviewer_identity), actor.id) ||
      decision.guarded_sha256 !== String(prepared.body.proposalDigest).slice(7)
    )
      throw new Error("PROMOTION_REVIEW_PIN_MISMATCH");
    return { prepared, decision, receipt };
  }

  async readReview(input: Parameters<PromotionSelectionApplicationPorts["readReview"]>[0]) {
    this.assertTenant(input.tenantId);
    const result = await this.review();
    if (
      input.selectionDigest !== this.proposal.selectionArtifact.digest ||
      input.prepared.operationId !== result.prepared.operation.operationId
    )
      throw new Error("PROMOTION_REVIEW_PREPARATION_MISMATCH");
    return {
      selectionDigest: this.proposal.selectionArtifact.digest,
      prepareOperationId: result.prepared.operation.operationId,
      reviewerIdentity: this.proposal.selection.requiredReviewer,
      decision:
        !result.decision || result.decision.current !== true
          ? ("pending" as const)
          : result.decision.decision === "accept"
            ? ("approve" as const)
            : result.decision.decision === "reject"
              ? ("reject" as const)
              : ("pending" as const),
    };
  }

  private async payload(work: PromotionWork): Promise<unknown> {
    if (work.stage === "prepare") return this.proposal;
    const review = await this.review();
    if (
      !review.decision ||
      !review.receipt ||
      review.decision.current !== true ||
      review.decision.decision !== "accept"
    )
      throw new Error("PROMOTION_INDEPENDENT_REVIEW_PENDING");
    if (work.stage === "embed") {
      const pin = this.spaces.find((item) => item.space === work.targetSpace)!;
      const proposal = await this.configuration.governance.getProjectionProposal(
        this.proposal.selection.tenantId,
        String(review.prepared.body.proposalId),
      );
      if (!proposal) throw new Error("PROMOTION_PREPARATION_MISSING");
      const ids = await this.configuration.database.transaction(this.proposal.selection.tenantId, async (client) => {
        const row = (
          await client.query<Row>(
            "select projection_manifest from retrieval.content_promotion_proposal where tenant_id=$1 and id=$2",
            [this.proposal.selection.tenantId, proposal.proposalId],
          )
        ).rows[0];
        const bindings = (row?.projection_manifest as Row)?.projections as {
          projectionId: string;
          targetSpaces: string[];
        }[];
        return bindings
          .filter((binding) => binding.targetSpaces.includes(work.targetSpace))
          .map((binding) => binding.projectionId)
          .sort();
      });
      const context = await this.configuration.governance.loadEmbeddingContext(
        this.proposal.selection.tenantId,
        pin.vectorSpaceVersionId,
        String(review.decision.id),
        ids,
      );
      if (
        context.vectorSpaceKey !== pin.space ||
        context.modelSlug !== pin.modelSlug ||
        context.selectionDigest !== this.proposal.selectionArtifact.digest
      )
        throw new Error("PROMOTION_EMBEDDING_PIN_MISMATCH");
      return {
        schemaVersion: "knowledge.embedding-run/v1",
        vectorSpaceVersionId: pin.vectorSpaceVersionId,
        promotionDecisionId: review.decision.id,
        projectionIds: ids,
        providerRoute: [...pin.providerRoute],
        expectedDimensions: 1536,
        modelSlug: pin.modelSlug,
      };
    }
    const embeddings = [];
    for (const pin of this.spaces) {
      const result = await this.readStage({ stage: "embed", targetSpace: pin.space });
      if (!result?.body || !result.operation.receiptId) throw new Error("PROMOTION_EMBEDDING_PENDING");
      const payload = (await this.payload({ stage: "embed", targetSpace: pin.space })) as Row;
      embeddings.push({
        operationId: result.operation.operationId,
        receiptId: result.operation.receiptId,
        embeddingRunId: result.body.embeddingRunId,
        vectorSpaceVersionId: pin.vectorSpaceVersionId,
        projectionIds: payload.projectionIds,
      });
    }
    return SelectedCandidateIndexInputSchema.parse({
      schemaVersion: "knowledge.selected-candidate-index/v1",
      selection: this.proposal.selection,
      selectionArtifact: this.proposal.selectionArtifact,
      preparation: {
        operationId: review.prepared.operation.operationId,
        receiptId: review.prepared.operation.receiptId,
        proposalId: review.prepared.body.proposalId,
      },
      review: {
        operationId: review.decision.decision_operation_id,
        receiptId: review.receipt.id,
        decisionId: review.decision.id,
      },
      embeddings,
    });
  }

  private async receipt(
    operationId: string,
    kind: OperationKind,
    receiptKind: string,
  ): Promise<{ id: string; body: Row } | null> {
    return this.configuration.database.transaction(this.proposal.selection.tenantId, async (client) => {
      const rows = (
        await client.query<Row>(
          `select r.id,r.body,r.output_sha256 from knowledge_service.receipt r
        join knowledge_service.operation o on o.tenant_id=r.tenant_id and o.id=r.operation_id and o.status='succeeded'
        join knowledge_service.operation_step s on s.tenant_id=r.tenant_id and s.id=r.step_id and s.operation_id=o.id
          and s.status='succeeded' and s.input_sha256=r.input_sha256
        join knowledge_service.operation_event e on e.tenant_id=r.tenant_id and e.operation_id=o.id and e.step_id=s.id
          and e.id::text=r.body->>'eventId' and e.event_kind='step.succeeded' and e.guarded_sha256=r.output_sha256
          and e.payload->>'fencingToken'=r.body->>'fencingToken'
        where r.tenant_id=$1 and r.operation_id=$2 and o.operation_kind=$3 and r.receipt_kind=$4 and r.outcome='succeeded'`,
          [this.proposal.selection.tenantId, operationId, kind, receiptKind],
        )
      ).rows;
      if (!rows.length) return null;
      if (rows.length !== 1) throw new Error("PROMOTION_RECEIPT_CENSUS_MISMATCH");
      const row = rows[0]!,
        { eventId, fencingToken, ...body } = row.body as Row;
      if (
        typeof eventId !== "string" ||
        !Number.isSafeInteger(fencingToken) ||
        Number(fencingToken) < 1 ||
        digest(body).slice(7) !== row.output_sha256
      )
        throw new Error("PROMOTION_RECEIPT_DIGEST_MISMATCH");
      return { id: String(row.id), body };
    });
  }
}
