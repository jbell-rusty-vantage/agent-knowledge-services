import {
  OperationContextSchema,
  ParseArtifactRequestSchema,
  VerificationParseArtifactResultSchema,
  type OperationContext,
  type ParseArtifactRequest,
  type VerificationArtifactHandle,
  type VerificationParseArtifactResult,
} from "@aiengineer/knowledge-contracts";
import { canonicalizeJson, digestCanonicalJson } from "@aiengineer/knowledge-verification";
import type {
  ProjectionAdmissionReceipt,
  RegisterAdmissionArtifactInput,
  VerificationAdmissionService,
} from "../admission/verification-admission.js";

type Digest = `sha256:${string}`;
export interface ParseArtifactLease {
  readonly stepId: string;
  readonly leaseToken: string;
  readonly fencingToken: number;
  readonly holderIdentity: string;
}
export interface ParseArtifactRepository {
  /** Native repository lookup of the immutable registered capture content handle. */
  getRegisteredCapture(input: {
    readonly tenantId: string;
    readonly captureId: string;
  }): Promise<{ readonly capture: { readonly contentArtifact: VerificationArtifactHandle } }>;
  /** Native implementation must atomically reject stale lease/fence before persisting the result. */
  registerFencedContentAddressedArtifact(input: {
    readonly artifact: RegisterAdmissionArtifactInput;
    readonly lease: ParseArtifactLease;
  }): Promise<VerificationArtifactHandle>;
}
export interface ParseArtifactConfig {
  readonly storageBucket: string;
  readonly producerVersion: string;
  readonly encryptionClass: string;
  readonly retentionClass: string;
  readonly now: () => string;
}

/** Thin durable composition over VerificationAdmissionService; it owns all parser and projection admission mechanics. */
export class ParseArtifactApplicationService {
  constructor(
    private readonly repository: ParseArtifactRepository,
    private readonly admission: Pick<VerificationAdmissionService, "parseAndAdmit">,
    private readonly config: ParseArtifactConfig,
  ) {}

  async execute(input: {
    readonly context: OperationContext;
    readonly request: ParseArtifactRequest;
    readonly kind: "html" | "pdf";
    readonly lease: ParseArtifactLease;
    readonly signal?: AbortSignal;
  }): Promise<VerificationParseArtifactResult> {
    const context = OperationContextSchema.parse(input.context),
      request = ParseArtifactRequestSchema.parse(input.request);
    const binding = await this.repository.getRegisteredCapture({
      tenantId: context.tenantId,
      captureId: request.captureId,
    });
    if (
      binding.capture.contentArtifact.tenantId !== context.tenantId ||
      canonicalizeJson(binding.capture.contentArtifact) !== canonicalizeJson(request.sourceArtifact)
    )
      throw new Error("PARSE_ARTIFACT_SOURCE_BINDING_INVALID");
    const receipts = await this.admission.parseAndAdmit({
      tenantId: context.tenantId,
      captureId: request.captureId,
      expectedSourceArtifact: {
        artifactId: request.sourceArtifact.artifactId,
        digest: request.sourceArtifact.digest as Digest,
      },
      kind: input.kind,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (receipts.length < 1 || receipts.length > 2) throw new Error("PARSE_ARTIFACT_PROJECTION_COUNT_INVALID");
    const source = receipts[0]!.sourceArtifact;
    if (
      canonicalizeJson(source) !== canonicalizeJson(request.sourceArtifact) ||
      source.tenantId !== context.tenantId ||
      receipts.some(
        (item) =>
          item.captureId !== request.captureId || canonicalizeJson(item.sourceArtifact) !== canonicalizeJson(source),
      )
    )
      throw new Error("PARSE_ARTIFACT_RECEIPT_BINDING_INVALID");
    const requestDigest = digestCanonicalJson(request);
    const parentArtifactIds = unique([
      source.artifactId,
      ...receipts.flatMap((item) => [
        item.nativeOutputArtifact.artifactId,
        item.projectionArtifact.artifactId,
        item.transformationArtifact.artifactId,
      ]),
    ]);
    const body = {
      schemaVersion: "verification-operation-result.v1" as const,
      operationId: context.operationId,
      useCase: "parseArtifact" as const,
      requestDigest,
      sourceArtifact: source,
      output: { status: "canonical_projection_admitted" as const, projections: receipts },
    };
    VerificationParseArtifactResultSchema.omit({ resultArtifact: true }).parse(body);
    if (input.signal?.aborted) throw new Error("PARSE_ARTIFACT_CANCELLED");
    const bytes = new TextEncoder().encode(canonicalizeJson(body));
    const resultArtifact = await this.repository.registerFencedContentAddressedArtifact({
      artifact: {
        tenantId: context.tenantId,
        producerAttemptId: context.attemptId,
        ...(context.missionId ? { missionId: context.missionId } : {}),
        bytes,
        mediaType: "application/vnd.aiengineer.verification-operation-result+json",
        createdAt: new Date(this.config.now()).toISOString(),
        producerActivityId: "verification-service:parseArtifact",
        producerVersion: this.config.producerVersion,
        encryptionClass: this.config.encryptionClass,
        retentionClass: this.config.retentionClass,
        dataClassification: source.dataClassification,
        parentArtifactIds,
        transformationSignature: digestCanonicalJson({
          relation: "verification_service_result",
          operationId: context.operationId,
          useCase: "parseArtifact",
          requestDigest,
          parentArtifactIds,
        }),
        artifactType: "verification_parse_result",
        bucketClass: "ledger",
        storageBucket: this.config.storageBucket,
      },
      lease: input.lease,
    });
    return VerificationParseArtifactResultSchema.parse({ ...body, resultArtifact });
  }
}
function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
