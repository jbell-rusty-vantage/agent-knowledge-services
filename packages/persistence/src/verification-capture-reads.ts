import {
  CaptureSourceRequestSchema,
  OperationContextSchema,
  UuidSchema,
  VerificationArtifactHandleSchema,
  VerificationParseArtifactResultSchema,
  type OperationContext,
  type VerificationArtifactHandle,
  type VerificationSource,
  type VerificationSourceCapture,
} from "@aiengineer/knowledge-contracts";
import {
  KNOWLEDGE_OPERATION_REQUEST_SCHEMA_VERSION,
  VerificationAcquisitionReceiptSchema,
  type VerificationAdmissionService,
} from "@aiengineer/knowledge-application";
import { deepFreeze } from "@aiengineer/knowledge-core";
import { deterministicUuid } from "@aiengineer/knowledge-core";
import {
  canonicalizeJson,
  digestCanonicalJson,
  sha256Digest,
  type TrustedArtifactResolver,
} from "@aiengineer/knowledge-verification";
import { z } from "zod";
import type { PostgresCanonicalRepository } from "./postgres.js";
import type { PostgresVerificationRepository } from "./verification.js";

type Row = Record<string, unknown>;
const same = (left: unknown, right: unknown) => canonicalizeJson(left) === canonicalizeJson(right);
const decoder = new TextDecoder("utf-8", { fatal: true });
const serviceInput = z.strictObject({
  schemaVersion: z.literal("verification-service-request.v1"),
  useCase: z.literal("captureSource"),
  request: CaptureSourceRequestSchema,
});
const durableSchema = z.strictObject({
  schemaVersion: z.literal(KNOWLEDGE_OPERATION_REQUEST_SCHEMA_VERSION),
  kind: z.literal("verification_capture"),
  input: serviceInput,
  expectedVersions: z.record(z.string(), z.string().min(1)),
  authenticatedContext: OperationContextSchema,
});
const stepSchema = z.strictObject({
  schemaVersion: z.literal(KNOWLEDGE_OPERATION_REQUEST_SCHEMA_VERSION),
  kind: z.literal("verification_capture"),
  operationInput: serviceInput,
  expectedVersions: z.record(z.string(), z.string().min(1)),
  context: OperationContextSchema,
  step: z.strictObject({ name: z.literal("register_and_admit"), ordinal: z.literal(0) }),
});
const projectionSchema = z.discriminatedUnion("projectionKind", [
  VerificationParseArtifactResultSchema.shape.output.shape.projections.element.extend({
    projectionKind: z.literal("html_dom"),
    projectionOrdinal: z.literal(0),
  }),
  VerificationParseArtifactResultSchema.shape.output.shape.projections.element.extend({
    projectionKind: z.literal("pdf_text"),
    projectionOrdinal: z.literal(0),
  }),
  VerificationParseArtifactResultSchema.shape.output.shape.projections.element.extend({
    projectionKind: z.literal("geometry"),
    projectionOrdinal: z.literal(1),
  }),
]);
const resultSchema = z.strictObject({
  schemaVersion: z.literal("verification-operation-result.v1"),
  operationId: UuidSchema,
  useCase: z.literal("captureSource"),
  requestDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  boundArtifacts: z.array(VerificationArtifactHandleSchema).min(4).max(7),
  output: z.strictObject({
    request: CaptureSourceRequestSchema,
    capture: z.any(),
    projections: z.array(projectionSchema).min(1).max(2),
    acquisitionReceipt: VerificationArtifactHandleSchema.optional(),
  }),
  resultArtifact: VerificationArtifactHandleSchema,
});
type Result = z.infer<typeof resultSchema>;
type CaptureReadState = "pending" | "failed" | "cancelled" | "succeeded";
type Succeeded = {
  readonly state: "succeeded";
  readonly result: Result;
  readonly context: OperationContext;
  readonly artifactId: string;
};
type Snapshot = { readonly state: "pending" | "failed" | "cancelled" } | Succeeded;

export class CaptureReadPersistenceError extends Error {
  constructor(
    readonly code: "INVALID" | "NOT_FOUND" | "INTEGRITY",
    cause?: unknown,
  ) {
    super(`VERIFICATION_CAPTURE_READ_${code}`, cause === undefined ? undefined : { cause });
  }
}

/** Verifies native terminal capture custody before the application projects a compact public resource. */
export class PostgresCaptureReadRepository {
  constructor(
    private readonly database: Pick<PostgresCanonicalRepository, "transaction">,
    private readonly repository: Pick<
      PostgresVerificationRepository,
      "createTrustedArtifactResolver" | "getRegisteredCapture"
    >,
    private readonly admission: Pick<VerificationAdmissionService, "hydrateAdmittedProjection">,
  ) {}

  async loadVerifiedCapture(
    tenantId: string,
    operationId: string,
  ): Promise<{ readonly state: CaptureReadState; readonly result?: unknown; readonly registeredSource?: unknown }> {
    if (!UuidSchema.safeParse(tenantId).success || !UuidSchema.safeParse(operationId).success)
      throw new CaptureReadPersistenceError("INVALID");
    try {
      const snapshot = await this.#snapshot(tenantId, operationId);
      if (snapshot.state !== "succeeded") return snapshot;
      const result = snapshot.result;
      const registeredSource = await this.repository.getRegisteredCapture({
        tenantId,
        captureId: result.output.capture.captureId,
      });
      if (
        !same(registeredSource.capture, result.output.capture) ||
        registeredSource.source.sourceId !== result.output.capture.sourceId
      )
        throw new Error("REGISTERED_CAPTURE_BINDING");
      await this.#verifyResultBytes(tenantId, result);
      await this.#verifyAcquisitionReceipt(tenantId, result);
      for (const projection of result.output.projections) {
        const readmitted = await this.admission.hydrateAdmittedProjection({
          tenantId,
          captureId: result.output.capture.captureId,
          expectedSourceArtifact: {
            artifactId: result.output.capture.contentArtifact.artifactId,
            digest: result.output.capture.contentArtifact.digest,
          },
          transformationArtifactId: projection.transformationArtifact.artifactId,
          projectionArtifactId: projection.projectionArtifact.artifactId,
        });
        if (!same(readmitted.receipt, projection)) throw new Error("PROJECTION_READMISSION_BINDING");
      }
      const after = await this.#snapshot(tenantId, operationId);
      if (!same(after, snapshot)) throw new Error("TERMINAL_DRIFT");
      return deepFreeze({ state: "succeeded" as const, result, registeredSource });
    } catch (error) {
      if (error instanceof CaptureReadPersistenceError) throw error;
      throw new CaptureReadPersistenceError("INTEGRITY", error);
    }
  }

  async #verifyResultBytes(tenantId: string, result: Result): Promise<void> {
    const expected = result.resultArtifact;
    const resolver = this.repository.createTrustedArtifactResolver();
    await resolver.authorizeArtifact({ tenantId, artifactId: expected.artifactId, purpose: "verification_replay" });
    const hydrated = await resolver.hydrateRegisteredArtifact({ tenantId, artifactId: expected.artifactId });
    const registration = VerificationArtifactHandleSchema.parse(hydrated.registration);
    if (
      !same(registration, expected) ||
      hydrated.bytes.byteLength !== expected.byteLength ||
      sha256Digest(hydrated.bytes) !== expected.digest
    )
      throw new Error("RESULT_ARTIFACT_BYTES");
    const raw = decoder.decode(hydrated.bytes),
      decoded: unknown = JSON.parse(raw);
    const { resultArtifact: _resultArtifact, ...stored } = result;
    if (canonicalizeJson(decoded) !== raw || !same(decoded, stored)) throw new Error("RESULT_BODY_BYTES");
  }

  /** Acquire-mode source custody includes a separately stored, bounded HTTP receipt. */
  async #verifyAcquisitionReceipt(tenantId: string, result: Result): Promise<void> {
    const receipt = result.output.acquisitionReceipt;
    if (receipt === undefined) return;
    const capture = result.output.capture;
    const requestSource = result.output.request.source;
    if (requestSource.mode !== "acquire") throw new Error("ACQUISITION_RECEIPT_REQUEST");
    const resolver = this.repository.createTrustedArtifactResolver();
    await resolver.authorizeArtifact({ tenantId, artifactId: receipt.artifactId, purpose: "verification_replay" });
    const hydrated = await resolver.hydrateRegisteredArtifact({ tenantId, artifactId: receipt.artifactId });
    const registration = VerificationArtifactHandleSchema.parse(hydrated.registration);
    if (
      !same(registration, receipt) ||
      hydrated.bytes.byteLength > 65_536 ||
      hydrated.bytes.byteLength !== receipt.byteLength ||
      sha256Digest(hydrated.bytes) !== receipt.digest ||
      receipt.mediaType !== "application/vnd.aiengineer.verification-source-acquisition-receipt+json" ||
      receipt.parentArtifactIds.length !== 0
    )
      throw new Error("ACQUISITION_RECEIPT_BYTES");
    const raw = decoder.decode(hydrated.bytes);
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      throw new Error("ACQUISITION_RECEIPT_JSON");
    }
    if (canonicalizeJson(decoded) !== raw) throw new Error("ACQUISITION_RECEIPT_CANONICAL");
    const metadata = VerificationAcquisitionReceiptSchema.parse(decoded),
      response = metadata.response;
    if (
      metadata.tenantId !== tenantId ||
      metadata.operationId !== result.operationId ||
      metadata.sourceId !== capture.sourceId ||
      metadata.contentDigest !== capture.contentArtifact.digest ||
      response.sourceUri !== requestSource.sourceUri ||
      response.capturedAt !== capture.capturedAt ||
      response.finalUri !== (response.redirectUris.at(-1) ?? response.sourceUri) ||
      (response.responseMetadata.contentLength !== undefined &&
        response.responseMetadata.contentLength !== capture.contentArtifact.byteLength) ||
      response.mediaType !== capture.contentArtifact.mediaType ||
      registration.transformationSignature !==
        digestCanonicalJson({ relation: "verification_source_acquisition_receipt.v1", ...metadata }) ||
      capture.contentArtifact.transformationSignature !==
        digestCanonicalJson({
          relation: "verification_source_acquisition.v1",
          receipt: registration,
          contentDigest: capture.contentArtifact.digest,
        })
    )
      throw new Error("ACQUISITION_RECEIPT_BINDING");
  }

  async #snapshot(tenantId: string, operationId: string): Promise<Snapshot> {
    return this.database.transaction(tenantId, async (client) => {
      const rows = (
        await client.query<Row>(
          `select o.status,o.request,o.request_sha256,o.idempotency_key,o.actor_identity,o.attempt_id,o.mission_id,o.work_item_id,o.correlation_id,o.causation_id,o.ownership_mode,o.external_run_id,
        s.id step_id,s.status step_status,s.step_key,s.step_kind,s.input,s.input_sha256,
        r.id receipt_id,r.receipt_kind,r.outcome,r.input_sha256 receipt_input_sha256,r.output_sha256,r.body,
        e.id event_id,e.operation_id event_operation_id,e.step_id event_step_id,e.event_kind,e.from_state event_from_state,e.to_state event_to_state,e.guarded_sha256 event_guarded_sha256,e.payload event_payload,
        a.id artifact_id,a.artifact_type,a.bucket_class
        from knowledge_service.operation o
        left join knowledge_service.operation_step s on s.tenant_id=o.tenant_id and s.operation_id=o.id
        left join knowledge_service.receipt r on r.tenant_id=o.tenant_id and r.operation_id=o.id and r.step_id=s.id
        left join knowledge_service.operation_event e on e.tenant_id=o.tenant_id and e.id=(r.body->>'eventId')::uuid
        left join orchestration.artifact a on a.tenant_id=o.tenant_id and a.id=(r.body->'resultArtifact'->>'artifactId')::uuid
        where o.tenant_id=$1 and o.id=$2 and o.operation_kind='verification_capture'`,
          [tenantId, operationId],
        )
      ).rows;
      if (!rows.length) throw new CaptureReadPersistenceError("NOT_FOUND");
      if (rows.length !== 1) throw new Error("TERMINAL_COUNT");
      const row = rows[0]!,
        status = String(row.status);
      if (["queued", "running", "needs_review", "quarantined"].includes(status))
        return deepFreeze({ state: "pending" as const });
      if (status === "failed") return deepFreeze({ state: "failed" as const });
      if (status === "cancelled") return deepFreeze({ state: "cancelled" as const });
      if (status !== "succeeded") throw new Error("OPERATION_STATE");
      const durable = durableSchema.parse(row.request),
        step = stepSchema.parse(row.input);
      if (
        !same(durable.input, step.operationInput) ||
        !same(durable.expectedVersions, step.expectedVersions) ||
        !same(durable.authenticatedContext, step.context) ||
        step.context.tenantId !== tenantId ||
        step.context.operationId !== operationId ||
        row.idempotency_key !== step.context.idempotencyKey ||
        row.actor_identity !== `${step.context.actor.kind}:${step.context.actor.id}` ||
        row.attempt_id !== step.context.attemptId ||
        (row.mission_id ?? undefined) !== step.context.missionId ||
        (row.work_item_id ?? undefined) !== step.context.workItemId ||
        row.correlation_id !== databaseUuid("correlation", step.context.correlationId) ||
        (row.causation_id ?? undefined) !==
          (step.context.causationId ? databaseUuid("causation", step.context.causationId) : undefined) ||
        row.ownership_mode !== ownership(step.context) ||
        (row.external_run_id ?? undefined) !== step.context.externalExecution?.runId ||
        digestCanonicalJson(durable) !== `sha256:${String(row.request_sha256)}` ||
        digestCanonicalJson(step) !== `sha256:${String(row.input_sha256)}` ||
        row.step_status !== "succeeded" ||
        row.step_key !== "register_and_admit" ||
        row.step_kind !== "register_and_admit" ||
        row.receipt_kind !== "register_and_admit.succeeded" ||
        row.outcome !== "succeeded" ||
        row.receipt_input_sha256 !== row.input_sha256 ||
        !UuidSchema.safeParse(row.step_id).success ||
        !UuidSchema.safeParse(row.receipt_id).success
      )
        throw new Error("TERMINAL_BINDING");
      if (!row.body || typeof row.body !== "object" || Array.isArray(row.body)) throw new Error("RECEIPT_BODY");
      const { eventId, fencingToken, ...body } = row.body as Row;
      const result = resultSchema.parse(body),
        fence = Number(fencingToken);
      if (
        !UuidSchema.safeParse(eventId).success ||
        !Number.isSafeInteger(fence) ||
        fence < 1 ||
        row.event_id !== eventId ||
        row.event_operation_id !== operationId ||
        row.event_step_id !== row.step_id ||
        row.event_kind !== "step.succeeded" ||
        row.event_from_state !== "running" ||
        row.event_to_state !== "succeeded" ||
        row.event_guarded_sha256 !== row.output_sha256 ||
        !same(row.event_payload, { outputSha256: row.output_sha256, fencingToken: String(fence) }) ||
        result.operationId !== operationId ||
        result.requestDigest !== digestCanonicalJson(durable.input.request) ||
        result.resultArtifact.artifactId !== row.artifact_id ||
        row.artifact_type !== "verification_bundle" ||
        row.bucket_class !== "ledger" ||
        digestCanonicalJson(result) !== `sha256:${String(row.output_sha256)}`
      )
        throw new Error("RECEIPT_BINDING");
      verifyResultLineage(result, tenantId, durable.input.request);
      return deepFreeze({
        state: "succeeded" as const,
        result,
        context: step.context,
        artifactId: String(row.artifact_id),
      });
    });
  }
}

function databaseUuid(namespace: string, value: string): string {
  return UuidSchema.safeParse(value).success ? value : deterministicUuid(namespace, value);
}
function ownership(context: OperationContext): string {
  return context.externalExecution?.runtime === "eve"
    ? "eve"
    : context.externalExecution?.runtime === "mission_control"
      ? "mission_control"
      : "standalone";
}
function verifyResultLineage(
  result: Result,
  tenantId: string,
  request: z.infer<typeof CaptureSourceRequestSchema>,
): void {
  const { projections } = result.output,
    capture = result.output.capture,
    receipt = result.output.acquisitionReceipt;
  const html =
    projections.length === 1 &&
    projections[0]!.projectionKind === "html_dom" &&
    projections[0]!.projectionOrdinal === 0;
  const pdf =
    projections.length === 2 &&
    projections[0]!.projectionKind === "pdf_text" &&
    projections[0]!.projectionOrdinal === 0 &&
    projections[1]!.projectionKind === "geometry" &&
    projections[1]!.projectionOrdinal === 1;
  if (
    (!html && !pdf) ||
    !same(result.output.request, request) ||
    capture.contentArtifact.tenantId !== tenantId ||
    projections.some(
      (projection) =>
        projection.sourceArtifact.tenantId !== tenantId ||
        projection.captureId !== capture.captureId ||
        !same(projection.sourceArtifact, capture.contentArtifact),
    ) ||
    capture.sourceId !== (request.source.mode === "register" ? request.source.sourceId : capture.sourceId) ||
    (request.source.mode === "acquire") !== (receipt !== undefined) ||
    request.requestedProjectionKinds.length !== projections.length ||
    request.requestedProjectionKinds.some((kind, index) => kind !== projections[index]!.projectionKind) ||
    (pdf &&
      (request.source.sourceKind !== "pdf" ||
        capture.contentArtifact.mediaType !== "application/pdf" ||
        !same(projections[0]!.nativeOutputArtifact, projections[1]!.nativeOutputArtifact) ||
        projections[0]!.parserVersion !== projections[1]!.parserVersion ||
        projections[0]!.imageDigest !== projections[1]!.imageDigest ||
        projections[0]!.parserOptionsDigest !== projections[1]!.parserOptionsDigest ||
        projections[0]!.parserTransformationSignature !== projections[1]!.parserTransformationSignature ||
        projections[0]!.residualsDigest !== projections[1]!.residualsDigest)) ||
    (html && (request.source.sourceKind !== "web_page" || capture.contentArtifact.mediaType !== "text/html")) ||
    (!receipt && !html)
  )
    throw new Error("CAPTURE_REQUEST_BINDING");
  const candidates = [
    ...(receipt ? [receipt] : []),
    capture.contentArtifact,
    ...projections.flatMap((projection) => [
      projection.nativeOutputArtifact,
      projection.projectionArtifact,
      projection.transformationArtifact,
    ]),
  ];
  const inputs = candidates.filter(
    (handle, index) => candidates.findIndex((candidate) => candidate.artifactId === handle.artifactId) === index,
  );
  if (
    !same(result.boundArtifacts, inputs) ||
    !same(
      result.resultArtifact.parentArtifactIds,
      inputs.map((item) => item.artifactId),
    ) ||
    projections.some(
      (projection) =>
        !same(projection.transformationArtifact.parentArtifactIds, [
          capture.contentArtifact.artifactId,
          projection.nativeOutputArtifact.artifactId,
          projection.projectionArtifact.artifactId,
        ]),
    )
  )
    throw new Error("CAPTURE_LINEAGE");
  if (
    receipt &&
    (!same(capture.contentArtifact.parentArtifactIds, [receipt.artifactId]) || receipt.parentArtifactIds.length !== 0)
  )
    throw new Error("ACQUISITION_LINEAGE");
}
