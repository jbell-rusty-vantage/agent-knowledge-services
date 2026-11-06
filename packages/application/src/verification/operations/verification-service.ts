import {
  ExtractStructuredDataRequestSchema,
  VerificationExtractionFieldEvidenceResultSchema,
} from "@aiengineer/knowledge-contracts";
import type { TrustedVerificationSourceAcquirer } from "../source-acquisition/verification-source-acquisition.js";
import {
  CaptureSourceRequestSchema,
  JsonValueSchema,
  OperationContextSchema,
  ReplayRunRequestSchema,
  VerificationArtifactHandleSchema,
  VerificationSourceSchema,
  VerificationSelectorSchema,
  VerifyExtractionRequestSchema,
  RunBenchmarkRequestSchema,
  CompareBenchmarkRunsRequestSchema,
  ParseArtifactRequestSchema,
  type CaptureSourceRequest,
  type JsonValue,
  type OperationContext,
  type VerificationArtifactHandle,
  type VerificationSource,
  type VerificationSourceCapture,
  type VerifyExtractionRequest,
  type ReplayRunRequest,
  type ParseArtifactRequest,
} from "@aiengineer/knowledge-contracts";
import { deterministicUuid } from "@aiengineer/knowledge-core";
import {
  admitExtractionSchema,
  canonicalizeJson,
  digestCanonicalJson,
  sha256Digest,
  type CrossFieldTotalRule,
  type DuplicateRecordRule,
  type ExtractionFieldRule,
  type ExtractionNormalizationRule,
} from "@aiengineer/knowledge-verification";
import { z } from "zod";
import {
  VerificationAdmissionService,
  type AdmittedExtractionEvidence,
  type ProjectionAdmissionReceipt,
  type VerificationAdmissionRepositoryPort,
} from "../admission/verification-admission.js";
import { type KnowledgeOperationPort } from "../../operations/surface.js";

export const VERIFICATION_SERVICE_REQUEST_VERSION = "verification-service-request.v1" as const;
export const verificationServiceOperationKinds = Object.freeze([
  "verification_capture",
  "verification_extraction",
  "verification_replay",
] as const);
export const verificationOwnedOperationKinds = Object.freeze([
  ...verificationServiceOperationKinds,
  "verification_parse_artifact",
  "verification_benchmark",
  "verification_benchmark_compare",
  "verification_structured_extraction",
] as const);

type VerificationServiceOperationKind =
  | (typeof verificationServiceOperationKinds)[number]
  | "verification_parse_artifact";
type Digest = `sha256:${string}`;

const artifactInputSchema = z.strictObject({
  artifactId: z.uuid(),
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
});
const acquisitionUriSchema = z
  .string()
  .max(4096)
  .refine((value) => {
    try {
      const uri = new URL(value);
      return (
        uri.protocol === "https:" && !uri.username && !uri.password && !uri.hash && !uri.port && uri.href === value
      );
    } catch {
      return false;
    }
  });
/** Canonical, server-generated metadata retained with an acquired source. */
export const VerificationAcquisitionReceiptSchema = z.strictObject({
  schemaVersion: z.literal("verification-source-acquisition-receipt.v1"),
  tenantId: z.uuid(),
  operationId: z.uuid(),
  sourceId: z.uuid(),
  contentDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  response: z.strictObject({
    sourceKey: z.string().min(1).max(128),
    sourceUri: acquisitionUriSchema,
    finalUri: acquisitionUriSchema,
    redirectUris: z.array(acquisitionUriSchema).max(8),
    status: z.int().min(200).max(299),
    mediaType: z.enum(["text/html", "application/pdf"]),
    capturedAt: z.iso.datetime({ offset: true }),
    responseMetadata: z.strictObject({
      contentLength: z
        .int()
        .min(0)
        .max(50 * 1024 * 1024)
        .optional(),
      etag: z.string().max(4096).optional(),
      lastModified: z.string().max(4096).optional(),
    }),
  }),
});
const fieldRuleSchema = z.strictObject({
  path: z.string().min(1).max(4_096),
  comparison: z.enum([
    "exact",
    "normalized_text",
    "decimal",
    "percentage",
    "currency",
    "unit",
    "date",
    "datetime",
    "enum",
    "identifier",
    "checksum",
  ]),
  normalizationId: z.string().min(1).max(255).optional(),
  allowedValues: z.array(z.string().max(1_024)).max(256).optional(),
  minimum: z.string().max(128).optional(),
  maximum: z.string().max(128).optional(),
  identifierKind: z.enum(["uuid", "sha256", "cve", "currency_code_token"]).optional(),
  checksum: z.enum(["luhn", "isbn13"]).optional(),
  sourceComponent: z.enum(["table_cell_value", "geometry_token_text", "transcript_text"]).optional(),
  sourceJoiner: z.enum(["space", "none"]).optional(),
});
const evidenceSchema = z.strictObject({
  path: z.string().min(1).max(4_096),
  captureId: z.string().min(1).max(255),
  projectionArtifactId: z.uuid(),
  transformationArtifactId: z.uuid(),
  selector: VerificationSelectorSchema,
  expectedSelectedContentDigest: z
    .string()
    .regex(/^sha256:[a-f0-9]{64}$/u)
    .optional(),
});
const normalizationSchema = z.strictObject({
  id: z.string().min(1).max(255),
  operation: z.enum(["trim_ascii", "ascii_whitespace_collapsed"]),
});
const duplicateSchema = z.strictObject({
  arrayPath: z.string().min(1).max(4_096),
  keyPaths: z.array(z.string().min(1).max(4_096)).min(1).max(32),
});
const totalSchema = z.strictObject({
  resultPath: z.string().min(1).max(4_096),
  operandPaths: z.array(z.string().min(1).max(4_096)).min(1).max(32),
  operation: z.enum(["identity", "sum", "difference", "product", "ratio", "percent_change"]),
  tolerance: z.string().max(128).optional(),
});

/** Immutable registered profile; it is trusted only after exact artifact hydration and catalog grant matching. */
export const VerificationExtractionProfileSchema = z.strictObject({
  schemaVersion: z.literal("verification-extraction-profile.v1"),
  sourceArtifact: artifactInputSchema,
  extractionSchema: z.strictObject({
    schemaId: z.string().min(1).max(255),
    schemaVersion: z.string().min(1).max(255),
    schema: JsonValueSchema,
  }),
  fields: z.array(fieldRuleSchema).min(1).max(256),
  evidence: z.array(evidenceSchema).min(1).max(10_000),
  normalizations: z.array(normalizationSchema).max(64).default([]),
  duplicates: z.array(duplicateSchema).max(64).default([]),
  totals: z.array(totalSchema).max(64).default([]),
});
export type VerificationExtractionProfile = z.infer<typeof VerificationExtractionProfileSchema>;

export interface VerificationCaptureGrant {
  readonly source: VerificationSource;
  readonly contentArtifact: { readonly artifactId: string; readonly digest: Digest };
  readonly capturedAt: string;
  readonly captureMethod: string;
  readonly captureMethodVersion: string;
  readonly parserKind: "html";
  readonly projectionKinds: readonly ["html_dom"];
}
export interface VerificationParseArtifactGrant {
  readonly captureId: string;
  readonly sourceArtifact: VerificationArtifactHandle;
  readonly parserKind: "html" | "pdf";
}

export interface VerificationServiceCatalogInput {
  readonly captureGrants: readonly VerificationCaptureGrant[];
  readonly acquisitionGrants?: readonly {
    readonly tenantId: string;
    readonly sourceKey: string;
    readonly source: VerificationSource;
  }[];
  readonly extractionProfileArtifacts: readonly { readonly artifactId: string; readonly digest: Digest }[];
  /** Full immutable grant used by the parseArtifact public capability. */
  readonly parseArtifactGrants?: readonly VerificationParseArtifactGrant[];
}

function immutable<T>(value: T): T {
  const copy = structuredClone(value);
  const visit = (candidate: unknown): void => {
    if (!candidate || typeof candidate !== "object" || Object.isFrozen(candidate)) return;
    for (const child of Object.values(candidate as Record<string, unknown>)) visit(child);
    Object.freeze(candidate);
  };
  visit(copy);
  return copy;
}

/** Server-created grant catalog. No authority token or mutable map is exposed to callers. */
export class VerificationServiceCatalog {
  readonly #captures = new Map<string, VerificationCaptureGrant>();
  readonly #profiles = new Map<string, { readonly artifactId: string; readonly digest: Digest }>();
  readonly #parseArtifacts = new Map<string, VerificationParseArtifactGrant>();
  readonly #acquisitions = new Map<
    string,
    { readonly tenantId: string; readonly sourceKey: string; readonly source: VerificationSource }
  >();
  constructor(input: VerificationServiceCatalogInput) {
    if ((input.acquisitionGrants?.length ?? 0) > 128) throw new Error("VERIFICATION_ACQUISITION_GRANT_LIMIT");
    for (const value of input.acquisitionGrants ?? []) {
      const grant = immutable(
        z
          .strictObject({ tenantId: z.uuid(), sourceKey: z.string().min(1).max(128), source: VerificationSourceSchema })
          .parse(value),
      );
      z.uuid().parse(grant.source.sourceId);
      const uri = new URL(grant.source.canonicalUri);
      if (
        !["web_page", "pdf"].includes(grant.source.kind) ||
        uri.protocol !== "https:" ||
        uri.username ||
        uri.password ||
        uri.hash ||
        uri.href !== grant.source.canonicalUri
      )
        throw new Error("VERIFICATION_ACQUISITION_SOURCE_INVALID");
      const key = `${grant.tenantId}:${grant.source.canonicalUri}`;
      if (this.#acquisitions.has(key)) throw new Error("DUPLICATE_VERIFICATION_ACQUISITION_GRANT");
      this.#acquisitions.set(key, grant);
    }
    for (const grantValue of input.captureGrants) {
      const grant = immutable(captureGrantSchema.parse(grantValue)) as VerificationCaptureGrant;
      const key = `${grant.source.sourceId}:${grant.contentArtifact.artifactId}:${grant.contentArtifact.digest}`;
      if (this.#captures.has(key)) throw new Error("DUPLICATE_VERIFICATION_CAPTURE_GRANT");
      this.#captures.set(key, grant);
    }
    for (const profileValue of input.extractionProfileArtifacts) {
      const parsed = artifactInputSchema.parse(profileValue),
        profile = immutable({ artifactId: parsed.artifactId, digest: parsed.digest as Digest });
      const key = `${profile.artifactId}:${profile.digest}`;
      if (this.#profiles.has(key)) throw new Error("DUPLICATE_VERIFICATION_PROFILE_GRANT");
      this.#profiles.set(key, profile);
    }
    for (const value of input.parseArtifactGrants ?? []) {
      const grant = immutable(parseArtifactGrantSchema.parse(value)) as VerificationParseArtifactGrant;
      const key = this.#parseArtifactKey(grant.captureId, grant.sourceArtifact);
      if (this.#parseArtifacts.has(key)) throw new Error("DUPLICATE_VERIFICATION_PARSE_ARTIFACT_GRANT");
      this.#parseArtifacts.set(key, grant);
    }
    Object.freeze(this);
  }
  capture(sourceId: string, artifact: { artifactId: string; digest: string }): VerificationCaptureGrant {
    const grant = this.#captures.get(`${sourceId}:${artifact.artifactId}:${artifact.digest}`);
    if (!grant) throw new Error("VERIFICATION_CAPTURE_GRANT_REQUIRED");
    return grant;
  }
  acquisition(tenantId: string, sourceUri: string) {
    const grant = this.#acquisitions.get(`${tenantId}:${sourceUri}`);
    if (!grant) throw new Error("VERIFICATION_ACQUISITION_GRANT_REQUIRED");
    return grant;
  }
  hasAcquisitionGrants(): boolean {
    return this.#acquisitions.size > 0;
  }
  /** Exact public parse grant; native capture binding is repeated by the worker before parser use. */
  parseArtifact(captureId: string, sourceArtifact: VerificationArtifactHandle): VerificationParseArtifactGrant {
    const grant = this.#parseArtifacts.get(this.#parseArtifactKey(captureId, sourceArtifact));
    if (!grant) throw new Error("VERIFICATION_PARSE_ARTIFACT_GRANT_REQUIRED");
    return grant;
  }
  admitsParseArtifact(request: ParseArtifactRequest): boolean {
    return this.#parseArtifacts.has(this.#parseArtifactKey(request.captureId, request.sourceArtifact));
  }
  hasParseArtifactGrants(): boolean {
    return this.#parseArtifacts.size > 0;
  }
  #parseArtifactKey(captureId: string, sourceArtifact: VerificationArtifactHandle): string {
    return `${captureId}:${canonicalizeJson(sourceArtifact)}`;
  }
  profile(artifact: { artifactId: string; digest: string }): { readonly artifactId: string; readonly digest: Digest } {
    const grant = this.#profiles.get(`${artifact.artifactId}:${artifact.digest}`);
    if (!grant) throw new Error("VERIFICATION_EXTRACTION_PROFILE_GRANT_REQUIRED");
    return grant;
  }
}

export interface VerificationOperationRepositoryPort extends VerificationAdmissionRepositoryPort {
  recordCapture(input: {
    tenantId: string;
    source: VerificationSource;
    capture: VerificationSourceCapture;
    producerAttemptId: string;
  }): Promise<void>;
}

export interface CompletedVerificationResultPort {
  loadResultArtifact(input: {
    readonly tenantId: string;
    readonly operationId: string;
  }): Promise<VerificationArtifactHandle>;
}

export interface VerificationOperationStatePort {
  assertActive(input: { readonly tenantId: string; readonly operationId: string }): Promise<void>;
}

export interface VerificationExecutorConfig {
  readonly storageBucket: string;
  readonly producerVersion: string;
  readonly encryptionClass: string;
  readonly retentionClass: string;
  readonly now: () => string;
  readonly cancellationPollMs?: number;
}

const captureGrantSchema = z.strictObject({
  source: VerificationSourceSchema,
  contentArtifact: artifactInputSchema,
  capturedAt: z.iso.datetime({ offset: true }),
  captureMethod: z.string().min(1).max(255),
  captureMethodVersion: z.string().min(1).max(255),
  parserKind: z.literal("html"),
  projectionKinds: z.tuple([z.literal("html_dom")]),
});
const parseArtifactGrantSchema = z.strictObject({
  captureId: z.uuid(),
  sourceArtifact: VerificationArtifactHandleSchema,
  parserKind: z.enum(["html", "pdf"]),
});

const requestSchemas = {
  verification_capture: CaptureSourceRequestSchema,
  verification_extraction: VerifyExtractionRequestSchema,
  verification_replay: ReplayRunRequestSchema,
  verification_parse_artifact: ParseArtifactRequestSchema,
} as const;

const useCases = {
  verification_capture: "captureSource",
  verification_extraction: "verifyExtraction",
  verification_replay: "replayRun",
  verification_parse_artifact: "parseArtifact",
} as const;

/** Shared submit boundary for HTTP, client, CLI and MCP. */
export class VerificationOperationApplicationService {
  constructor(
    private readonly operations: KnowledgeOperationPort,
    private readonly origin: string,
    private readonly captureCatalog?: VerificationServiceCatalog,
  ) {}
  submitCaptureSource(request: unknown, contextValue: unknown) {
    return this.#submit("verification_capture", request, contextValue);
  }
  submitVerifyExtraction(request: unknown, contextValue: unknown) {
    return this.#submit("verification_extraction", request, contextValue);
  }
  submitReplayRun(request: unknown, contextValue: unknown) {
    return this.#submit("verification_replay", request, contextValue);
  }
  submitParseArtifact(request: unknown, contextValue: unknown) {
    return this.#submit("verification_parse_artifact", request, contextValue);
  }
  submitExtractStructuredData(requestValue: unknown, contextValue: unknown) {
    const context = OperationContextSchema.parse(contextValue),
      request = ExtractStructuredDataRequestSchema.parse(requestValue);
    return this.operations.submit(
      "verification_structured_extraction",
      {
        context,
        input: { schemaVersion: VERIFICATION_SERVICE_REQUEST_VERSION, useCase: "extractStructuredData", request },
        expectedVersions: { verification: "verification.v1", service: VERIFICATION_SERVICE_REQUEST_VERSION },
      },
      this.origin,
    );
  }
  submitRunBenchmark(requestValue: unknown, contextValue: unknown) {
    const context = OperationContextSchema.parse(contextValue),
      request = RunBenchmarkRequestSchema.parse(requestValue);
    return this.operations.submit(
      "verification_benchmark",
      {
        context,
        input: { schemaVersion: VERIFICATION_SERVICE_REQUEST_VERSION, useCase: "runBenchmark", request },
        expectedVersions: { verification: "verification.v1", service: VERIFICATION_SERVICE_REQUEST_VERSION },
      },
      this.origin,
    );
  }
  submitCompareBenchmarkRuns(requestValue: unknown, contextValue: unknown) {
    const context = OperationContextSchema.parse(contextValue),
      request = CompareBenchmarkRunsRequestSchema.parse(requestValue);
    return this.operations.submit(
      "verification_benchmark_compare",
      {
        context,
        input: { schemaVersion: VERIFICATION_SERVICE_REQUEST_VERSION, useCase: "compareBenchmarkRuns", request },
        expectedVersions: { verification: "verification.v1", service: VERIFICATION_SERVICE_REQUEST_VERSION },
      },
      this.origin,
    );
  }
  #submit(kind: VerificationServiceOperationKind, requestValue: unknown, contextValue: unknown) {
    const context = OperationContextSchema.parse(contextValue);
    const request = requestSchemas[kind].parse(requestValue);
    if (kind === "verification_capture") {
      const capture = request as CaptureSourceRequest;
      if (!admittedCaptureShape(capture) || (capture.source.mode === "acquire" && !this.captureCatalog)) {
        throw new Error("VERIFICATION_CAPTURE_MODE_NOT_ADMITTED");
      }
      if (
        capture.source.mode === "acquire" &&
        this.captureCatalog!.acquisition(context.tenantId, capture.source.sourceUri).source.kind !==
          capture.source.sourceKind
      )
        throw new Error("VERIFICATION_CAPTURE_MODE_NOT_ADMITTED");
    }
    if (kind === "verification_extraction" && (request as VerifyExtractionRequest).captureIds.length !== 1)
      throw new Error("VERIFICATION_EXTRACTION_SINGLE_CAPTURE_REQUIRED");
    const input = {
      schemaVersion: VERIFICATION_SERVICE_REQUEST_VERSION,
      useCase: useCases[kind],
      request,
    } as unknown as JsonValue;
    return this.operations.submit(
      kind,
      {
        context,
        input,
        expectedVersions: { verification: "verification.v1", service: VERIFICATION_SERVICE_REQUEST_VERSION },
      },
      this.origin,
    );
  }
}

function admittedCaptureShape(request: CaptureSourceRequest): boolean {
  const kinds = request.requestedProjectionKinds;
  return (
    (request.source.sourceKind === "web_page" && kinds.length === 1 && kinds[0] === "html_dom") ||
    (request.source.mode === "acquire" &&
      request.source.sourceKind === "pdf" &&
      kinds.length === 2 &&
      kinds[0] === "pdf_text" &&
      kinds[1] === "geometry")
  );
}

const operationInputSchema = z.discriminatedUnion("useCase", [
  z.strictObject({
    schemaVersion: z.literal(VERIFICATION_SERVICE_REQUEST_VERSION),
    useCase: z.literal("captureSource"),
    request: CaptureSourceRequestSchema,
  }),
  z.strictObject({
    schemaVersion: z.literal(VERIFICATION_SERVICE_REQUEST_VERSION),
    useCase: z.literal("verifyExtraction"),
    request: VerifyExtractionRequestSchema,
  }),
  z.strictObject({
    schemaVersion: z.literal(VERIFICATION_SERVICE_REQUEST_VERSION),
    useCase: z.literal("replayRun"),
    request: ReplayRunRequestSchema,
  }),
]);

const resultArtifactSchema = z.strictObject({
  schemaVersion: z.literal("verification-operation-result.v1"),
  operationId: z.uuid(),
  useCase: z.enum(["captureSource", "verifyExtraction", "replayRun"]),
  requestDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  sourceOperationId: z.uuid().optional(),
  boundArtifacts: z.array(VerificationArtifactHandleSchema),
  output: JsonValueSchema,
});
const legacyExtractionResultSchema = z.strictObject({
  valid: z.boolean(),
  candidateValid: z.boolean(),
  checks: z.array(
    z.strictObject({ code: z.string(), path: z.string(), status: z.enum(["passed", "failed"]), detail: z.string() }),
  ),
});

export type VerificationOperationExecutionOutput = z.infer<typeof resultArtifactSchema> & {
  readonly resultArtifact: VerificationArtifactHandle;
};

/**
 * Trusted worker executor. Native projection lineage is authenticated through
 * VerificationAdmissionService's transformation envelope. Parentless native
 * projection handles are deliberately not passed to the historical direct-parent audit path.
 */
export class VerificationOperationExecutor {
  readonly #config: VerificationExecutorConfig;
  constructor(
    private readonly repository: VerificationOperationRepositoryPort,
    private readonly admission: VerificationAdmissionService,
    private readonly completedResults: CompletedVerificationResultPort,
    private readonly state: VerificationOperationStatePort,
    private readonly catalog: VerificationServiceCatalog,
    config: VerificationExecutorConfig,
    private readonly sourceAcquirer?: Pick<TrustedVerificationSourceAcquirer, "acquire">,
  ) {
    const cancellationPollMs = config.cancellationPollMs ?? 250;
    if (!Number.isSafeInteger(cancellationPollMs) || cancellationPollMs < 25 || cancellationPollMs > 5_000)
      throw new Error("VERIFICATION_CANCELLATION_POLL_INVALID");
    this.#config = Object.freeze({
      storageBucket: config.storageBucket,
      producerVersion: config.producerVersion,
      encryptionClass: config.encryptionClass,
      retentionClass: config.retentionClass,
      now: config.now,
      cancellationPollMs,
    });
  }

  async execute(
    kind: VerificationServiceOperationKind,
    operationInput: unknown,
    contextValue: unknown,
  ): Promise<VerificationOperationExecutionOutput> {
    const context = OperationContextSchema.parse(contextValue);
    const input = operationInputSchema.parse(operationInput);
    if (useCases[kind] !== input.useCase) throw new Error("VERIFICATION_OPERATION_KIND_MISMATCH");
    await this.state.assertActive({ tenantId: context.tenantId, operationId: context.operationId });
    if (kind === "verification_capture") return this.#capture(input.request as CaptureSourceRequest, context);
    if (kind === "verification_extraction") return this.#verify(input.request as VerifyExtractionRequest, context);
    return this.#replay(input.request as ReplayRunRequest, context);
  }

  async #capture(
    request: CaptureSourceRequest,
    context: OperationContext,
  ): Promise<VerificationOperationExecutionOutput> {
    if (request.source.mode === "acquire") return this.#acquireCapture(request, context);
    if (
      request.source.mode !== "register" ||
      request.source.sourceKind !== "web_page" ||
      request.requestedProjectionKinds.length !== 1 ||
      request.requestedProjectionKinds[0] !== "html_dom"
    )
      throw new Error("VERIFICATION_CAPTURE_MODE_NOT_ADMITTED");
    const grant = this.catalog.capture(request.source.sourceId, request.source.contentArtifact);
    const sourceArtifact = await this.#hydrateExact(context.tenantId, grant.contentArtifact);
    await this.state.assertActive({ tenantId: context.tenantId, operationId: context.operationId });
    const captureId = deterministicUuid(
      "verification-service-capture",
      `${context.tenantId}:${context.operationId}:${grant.source.sourceId}:${sourceArtifact.registration.digest}`,
    );
    const capture: VerificationSourceCapture = {
      captureId,
      sourceId: grant.source.sourceId,
      capturedAt: new Date(grant.capturedAt).toISOString(),
      captureMethod: grant.captureMethod,
      captureMethodVersion: grant.captureMethodVersion,
      contentArtifact: sourceArtifact.registration,
    };
    await this.repository.recordCapture({
      tenantId: context.tenantId,
      source: grant.source,
      capture,
      producerAttemptId: context.attemptId,
    });
    await this.state.assertActive({ tenantId: context.tenantId, operationId: context.operationId });
    const projections = await this.#parseWithCancellation({
      tenantId: context.tenantId,
      operationId: context.operationId,
      captureId,
      expectedSourceArtifact: grant.contentArtifact,
      kind: grant.parserKind,
    });
    if (projections.length !== 1 || projections[0]!.projectionKind !== "html_dom")
      throw new Error("VERIFICATION_CAPTURE_PROJECTION_MISMATCH");
    const registered = [
      sourceArtifact.registration,
      ...projections.flatMap((item) => [
        item.nativeOutputArtifact,
        item.projectionArtifact,
        item.transformationArtifact,
      ]),
    ];
    return this.#registerResult(context, "captureSource", request, registered, { capture, projections });
  }

  async #acquireCapture(
    request: CaptureSourceRequest,
    context: OperationContext,
  ): Promise<VerificationOperationExecutionOutput> {
    if (request.source.mode !== "acquire" || !admittedCaptureShape(request) || !this.sourceAcquirer)
      throw new Error("VERIFICATION_CAPTURE_MODE_NOT_ADMITTED");
    const grant = this.catalog.acquisition(context.tenantId, request.source.sourceUri);
    if (grant.source.kind !== request.source.sourceKind) throw new Error("VERIFICATION_CAPTURE_MODE_NOT_ADMITTED");
    const parserKind = grant.source.kind === "pdf" ? "pdf" : "html";
    const mediaType = parserKind === "pdf" ? "application/pdf" : "text/html";
    const captureId = deterministicUuid(
      "verification-live-capture",
      `${context.tenantId}:${context.operationId}:${grant.source.sourceId}`,
    );
    let existing: Awaited<ReturnType<VerificationOperationRepositoryPort["getRegisteredCapture"]>> | undefined;
    try {
      existing = await this.repository.getRegisteredCapture({ tenantId: context.tenantId, captureId });
    } catch (error) {
      if (!(error instanceof Error && error.message === "CAPTURE_NOT_REGISTERED")) throw error;
    }
    let sourceArtifact: VerificationArtifactHandle, capture: VerificationSourceCapture;
    if (existing) {
      await this.state.assertActive({ tenantId: context.tenantId, operationId: context.operationId });
      if (
        canonicalizeJson(existing.source) !== canonicalizeJson(grant.source) ||
        existing.capture.captureMethod !== "https_acquire" ||
        existing.capture.captureMethodVersion !== "verification-source-acquisition.v1"
      )
        throw new Error("VERIFICATION_ACQUISITION_RECOVERY_BINDING");
      sourceArtifact = (await this.#hydrateExact(context.tenantId, existing.capture.contentArtifact)).registration;
      if (canonicalizeJson(sourceArtifact) !== canonicalizeJson(existing.capture.contentArtifact))
        throw new Error("VERIFICATION_ACQUISITION_RECOVERY_BINDING");
      capture = existing.capture;
    } else {
      const acquired = await this.#withCancellation(context, (signal) =>
        this.sourceAcquirer!.acquire({ sourceKey: grant.sourceKey, signal }),
      );
      if (
        acquired.sourceKey !== grant.sourceKey ||
        acquired.sourceUri !== grant.source.canonicalUri ||
        acquired.mediaType !== mediaType
      )
        throw new Error("VERIFICATION_ACQUISITION_RESPONSE_BINDING");
      await this.state.assertActive({ tenantId: context.tenantId, operationId: context.operationId });
      const { bytes, ...response } = acquired;
      const contentDigest = sha256Digest(bytes);
      const parsedResponse = VerificationAcquisitionReceiptSchema.safeParse({
        schemaVersion: "verification-source-acquisition-receipt.v1",
        tenantId: context.tenantId,
        operationId: context.operationId,
        sourceId: grant.source.sourceId,
        contentDigest,
        response,
      });
      if (!parsedResponse.success) throw new Error("VERIFICATION_ACQUISITION_RESPONSE_BINDING");
      const metadata = parsedResponse.data;
      const common = {
        tenantId: context.tenantId,
        producerAttemptId: context.attemptId,
        ...(context.missionId ? { missionId: context.missionId } : {}),
        createdAt: acquired.capturedAt,
        producerActivityId: "verification-service:captureSource",
        producerVersion: this.#config.producerVersion,
        encryptionClass: this.#config.encryptionClass,
        retentionClass: this.#config.retentionClass,
        dataClassification: "restricted" as const,
        storageBucket: this.#config.storageBucket,
      };
      const receipt = await this.repository.registerContentAddressedArtifact({
        ...common,
        bytes: new TextEncoder().encode(canonicalizeJson(metadata)),
        mediaType: "application/vnd.aiengineer.verification-source-acquisition-receipt+json",
        artifactType: "verification_bundle",
        bucketClass: "ledger",
        transformationSignature: digestCanonicalJson({
          relation: "verification_source_acquisition_receipt.v1",
          ...metadata,
        }),
      });
      sourceArtifact = await this.repository.registerContentAddressedArtifact({
        ...common,
        bytes,
        mediaType: acquired.mediaType,
        artifactType: "source_capture",
        bucketClass: "source_captures",
        parentArtifactIds: [receipt.artifactId],
        transformationSignature: digestCanonicalJson({
          relation: "verification_source_acquisition.v1",
          receipt,
          contentDigest,
        }),
      });
      capture = {
        captureId,
        sourceId: grant.source.sourceId,
        capturedAt: acquired.capturedAt,
        captureMethod: "https_acquire",
        captureMethodVersion: "verification-source-acquisition.v1",
        contentArtifact: sourceArtifact,
      };
      await this.state.assertActive({ tenantId: context.tenantId, operationId: context.operationId });
      await this.repository.recordCapture({
        tenantId: context.tenantId,
        source: grant.source,
        capture,
        producerAttemptId: context.attemptId,
      });
    }
    if (
      sourceArtifact.parentArtifactIds.length !== 1 ||
      sourceArtifact.mediaType !== mediaType ||
      sourceArtifact.contentEncoding !== undefined
    )
      throw new Error("VERIFICATION_ACQUISITION_RECEIPT_REQUIRED");
    const resolver = this.repository.createTrustedArtifactResolver(),
      receiptId = sourceArtifact.parentArtifactIds[0]!;
    await resolver.authorizeArtifact({
      tenantId: context.tenantId,
      artifactId: receiptId,
      purpose: "verification_admission",
    });
    const retained = await resolver.hydrateRegisteredArtifact({ tenantId: context.tenantId, artifactId: receiptId });
    if (
      retained.registration.artifactId !== receiptId ||
      retained.registration.tenantId !== context.tenantId ||
      retained.registration.digest !== sha256Digest(retained.bytes) ||
      retained.registration.byteLength !== retained.bytes.byteLength ||
      retained.registration.mediaType !== "application/vnd.aiengineer.verification-source-acquisition-receipt+json"
    )
      throw new Error("VERIFICATION_ACQUISITION_RECEIPT_INVALID");
    if (retained.registration.parentArtifactIds.length !== 0 || retained.bytes.byteLength > 65536)
      throw new Error("VERIFICATION_ACQUISITION_RECEIPT_INVALID");
    const parsedMetadata = VerificationAcquisitionReceiptSchema.safeParse(parseCanonicalJson(retained.bytes));
    if (!parsedMetadata.success) throw new Error("VERIFICATION_ACQUISITION_RECEIPT_INVALID");
    const metadata = parsedMetadata.data,
      response = metadata.response;
    if (response.mediaType !== mediaType) throw new Error("VERIFICATION_ACQUISITION_RECOVERY_BINDING");
    if (
      metadata.schemaVersion !== "verification-source-acquisition-receipt.v1" ||
      metadata.tenantId !== context.tenantId ||
      metadata.operationId !== context.operationId ||
      metadata.sourceId !== grant.source.sourceId ||
      metadata.contentDigest !== sourceArtifact.digest ||
      response?.sourceKey !== grant.sourceKey ||
      response.sourceUri !== grant.source.canonicalUri ||
      response.capturedAt !== capture.capturedAt
    )
      throw new Error("VERIFICATION_ACQUISITION_RECOVERY_BINDING");
    if (
      sourceArtifact.transformationSignature !==
      digestCanonicalJson({
        relation: "verification_source_acquisition.v1",
        receipt: retained.registration,
        contentDigest: sourceArtifact.digest,
      })
    )
      throw new Error("VERIFICATION_ACQUISITION_RECOVERY_BINDING");
    if (
      response.finalUri !== (response.redirectUris.at(-1) ?? response.sourceUri) ||
      (response.responseMetadata.contentLength !== undefined &&
        response.responseMetadata.contentLength !== sourceArtifact.byteLength) ||
      retained.registration.transformationSignature !==
        digestCanonicalJson({ relation: "verification_source_acquisition_receipt.v1", ...metadata })
    )
      throw new Error("VERIFICATION_ACQUISITION_RECOVERY_BINDING");
    await this.state.assertActive({ tenantId: context.tenantId, operationId: context.operationId });
    const projections = await this.#parseWithCancellation({
      tenantId: context.tenantId,
      operationId: context.operationId,
      captureId,
      expectedSourceArtifact: { artifactId: sourceArtifact.artifactId, digest: sourceArtifact.digest as Digest },
      kind: parserKind,
    });
    if (
      projections.length !== request.requestedProjectionKinds.length ||
      projections.some(
        (item, index) =>
          item.projectionKind !== request.requestedProjectionKinds[index] || item.projectionOrdinal !== index,
      )
    )
      throw new Error("VERIFICATION_CAPTURE_PROJECTION_MISMATCH");
    const artifacts = new Map<string, VerificationArtifactHandle>();
    for (const artifact of [
      retained.registration,
      sourceArtifact,
      ...projections.flatMap((item) => [
        item.nativeOutputArtifact,
        item.projectionArtifact,
        item.transformationArtifact,
      ]),
    ]) {
      const prior = artifacts.get(artifact.artifactId);
      if (prior && canonicalizeJson(prior) !== canonicalizeJson(artifact))
        throw new Error("VERIFICATION_CAPTURE_PROJECTION_MISMATCH");
      artifacts.set(artifact.artifactId, artifact);
    }
    return this.#registerResult(context, "captureSource", request, [...artifacts.values()], {
      capture,
      projections,
      acquisitionReceipt: retained.registration,
    });
  }

  async #withCancellation<T>(context: OperationContext, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let watchError: unknown,
      checking = false;
    const timer = setInterval(() => {
      if (checking || watchError !== undefined) return;
      checking = true;
      void this.state
        .assertActive({ tenantId: context.tenantId, operationId: context.operationId })
        .catch((error) => {
          watchError = error;
          controller.abort();
        })
        .finally(() => {
          checking = false;
        });
    }, this.#config.cancellationPollMs);
    try {
      const result = await run(controller.signal);
      if (watchError !== undefined) throw watchError;
      await this.state.assertActive({ tenantId: context.tenantId, operationId: context.operationId });
      return result;
    } catch (error) {
      if (watchError !== undefined) throw watchError;
      throw error;
    } finally {
      clearInterval(timer);
    }
  }

  async #verify(
    request: VerifyExtractionRequest,
    context: OperationContext,
  ): Promise<VerificationOperationExecutionOutput> {
    if (request.captureIds.length !== 1) throw new Error("VERIFICATION_EXTRACTION_SINGLE_CAPTURE_REQUIRED");
    const profileGrant = this.catalog.profile(request.extractionSchema);
    const [profileArtifact, candidateArtifact] = await Promise.all([
      this.#hydrateExact(context.tenantId, profileGrant),
      this.#hydrateExact(context.tenantId, request.extractionOutput),
    ]);
    await this.state.assertActive({ tenantId: context.tenantId, operationId: context.operationId });
    const profile = VerificationExtractionProfileSchema.parse(parseCanonicalJson(profileArtifact.bytes));
    if (profile.evidence.some((edge) => edge.captureId !== request.captureIds[0]))
      throw new Error("VERIFICATION_EXTRACTION_CAPTURE_BINDING_MISMATCH");
    const boundSource = {
      artifactId: profile.sourceArtifact.artifactId,
      digest: profile.sourceArtifact.digest as Digest,
    };
    const sourceArtifact = await this.#hydrateExact(context.tenantId, boundSource);
    const candidate = parseCanonicalJson(candidateArtifact.bytes);
    const admission = admitExtractionSchema(profile.extractionSchema);
    if (!admission.admitted || !admission.schema) throw new Error("VERIFICATION_EXTRACTION_SCHEMA_NOT_ADMITTED");
    const enriched = await this.admission.verifyExtractionWithEvidence({
      tenantId: context.tenantId,
      expectedSourceArtifact: boundSource,
      schema: admission.schema,
      candidate,
      fields: profile.fields as readonly ExtractionFieldRule[],
      evidence: profile.evidence as readonly AdmittedExtractionEvidence[],
      normalizations: profile.normalizations as readonly ExtractionNormalizationRule[],
      duplicates: profile.duplicates as readonly DuplicateRecordRule[],
      totals: profile.totals as readonly CrossFieldTotalRule[],
    });
    await this.state.assertActive({ tenantId: context.tenantId, operationId: context.operationId });
    return this.#registerResult(
      context,
      "verifyExtraction",
      request,
      this.#deduplicateArtifacts([
        profileArtifact.registration,
        candidateArtifact.registration,
        sourceArtifact.registration,
        ...enriched.boundArtifacts,
      ]),
      { result: enriched.result },
    );
  }

  async #replay(request: ReplayRunRequest, context: OperationContext): Promise<VerificationOperationExecutionOutput> {
    if (request.replayMode !== "deterministic_only" && request.replayMode !== "recorded_provider_outputs")
      throw new Error("VERIFICATION_REPLAY_MODE_NOT_ADMITTED");
    const originalHandle = await this.completedResults.loadResultArtifact({
      tenantId: context.tenantId,
      operationId: request.runId,
    });
    const originalArtifact = await this.#hydrateExact(context.tenantId, {
      artifactId: originalHandle.artifactId,
      digest: originalHandle.digest as Digest,
    });
    const original = resultArtifactSchema.parse(parseCanonicalJson(originalArtifact.bytes));
    if (original.operationId !== request.runId || original.useCase !== "verifyExtraction")
      throw new Error("VERIFICATION_REPLAY_SOURCE_NOT_EXTRACTION");
    const originalRequest = VerifyExtractionRequestSchema.parse((original.output as Record<string, unknown>).request);
    const replayContext = { ...context, operationId: context.operationId };
    const previousResult = (original.output as Record<string, unknown>).result;
    const enriched = VerificationExtractionFieldEvidenceResultSchema.safeParse(previousResult);
    const legacy = legacyExtractionResultSchema.safeParse(previousResult);
    if (!enriched.success && !legacy.success) throw new Error("VERIFICATION_REPLAY_RESULT_SHAPE_UNSUPPORTED");
    const replayed = await this.#recomputeExtraction(originalRequest, replayContext, enriched.success);
    if (canonicalizeJson(previousResult) !== canonicalizeJson(replayed.result))
      throw new Error("VERIFICATION_REPLAY_RESULT_DRIFT");
    await this.state.assertActive({ tenantId: context.tenantId, operationId: context.operationId });
    return this.#registerResult(
      context,
      "replayRun",
      request,
      [originalArtifact.registration, ...replayed.inputs],
      { sourceOperationId: request.runId, result: replayed.result, replayMatched: true },
      request.runId,
    );
  }

  async #recomputeExtraction(
    request: VerifyExtractionRequest,
    context: OperationContext,
    enriched = false,
  ): Promise<{ result: unknown; inputs: VerificationArtifactHandle[] }> {
    const profileGrant = this.catalog.profile(request.extractionSchema);
    const [profileArtifact, candidateArtifact] = await Promise.all([
      this.#hydrateExact(context.tenantId, profileGrant),
      this.#hydrateExact(context.tenantId, request.extractionOutput),
    ]);
    const profile = VerificationExtractionProfileSchema.parse(parseCanonicalJson(profileArtifact.bytes));
    if (request.captureIds.length !== 1 || profile.evidence.some((edge) => edge.captureId !== request.captureIds[0]))
      throw new Error("VERIFICATION_EXTRACTION_CAPTURE_BINDING_MISMATCH");
    const boundSource = {
      artifactId: profile.sourceArtifact.artifactId,
      digest: profile.sourceArtifact.digest as Digest,
    };
    const sourceArtifact = await this.#hydrateExact(context.tenantId, boundSource);
    const schema = admitExtractionSchema(profile.extractionSchema);
    if (!schema.admitted || !schema.schema) throw new Error("VERIFICATION_EXTRACTION_SCHEMA_NOT_ADMITTED");
    const extraction = {
      tenantId: context.tenantId,
      expectedSourceArtifact: boundSource,
      schema: schema.schema,
      candidate: parseCanonicalJson(candidateArtifact.bytes),
      fields: profile.fields as readonly ExtractionFieldRule[],
      evidence: profile.evidence as readonly AdmittedExtractionEvidence[],
      normalizations: profile.normalizations as readonly ExtractionNormalizationRule[],
      duplicates: profile.duplicates as readonly DuplicateRecordRule[],
      totals: profile.totals as readonly CrossFieldTotalRule[],
    };
    if (!enriched) {
      const result = await this.admission.verifyExtraction(extraction);
      return {
        result,
        inputs: [profileArtifact.registration, candidateArtifact.registration, sourceArtifact.registration],
      };
    }
    const verified = await this.admission.verifyExtractionWithEvidence(extraction);
    return {
      result: verified.result,
      inputs: this.#deduplicateArtifacts([
        profileArtifact.registration,
        candidateArtifact.registration,
        sourceArtifact.registration,
        ...verified.boundArtifacts,
      ]),
    };
  }

  #deduplicateArtifacts(artifacts: readonly VerificationArtifactHandle[]): VerificationArtifactHandle[] {
    const unique = new Map<string, VerificationArtifactHandle>();
    for (const artifact of artifacts) {
      const prior = unique.get(artifact.artifactId);
      if (prior && canonicalizeJson(prior) !== canonicalizeJson(artifact))
        throw new Error("VERIFICATION_ARTIFACT_PARENT_COLLISION");
      unique.set(artifact.artifactId, artifact);
    }
    return [...unique.values()];
  }

  async #hydrateExact(tenantId: string, expected: { artifactId: string; digest: string }) {
    const resolver = this.repository.createTrustedArtifactResolver();
    await resolver.authorizeArtifact({ tenantId, artifactId: expected.artifactId, purpose: "verification_admission" });
    const hydrated = await resolver.hydrateRegisteredArtifact({ tenantId, artifactId: expected.artifactId });
    if (
      hydrated.registration.artifactId !== expected.artifactId ||
      hydrated.registration.tenantId !== tenantId ||
      hydrated.registration.digest !== expected.digest ||
      sha256Digest(hydrated.bytes) !== expected.digest
    )
      throw new Error("VERIFICATION_ARTIFACT_BINDING_MISMATCH");
    return hydrated;
  }

  async #parseWithCancellation(input: {
    tenantId: string;
    operationId: string;
    captureId: string;
    expectedSourceArtifact: { artifactId: string; digest: Digest };
    kind: "html" | "pdf";
  }): Promise<readonly ProjectionAdmissionReceipt[]> {
    const controller = new AbortController();
    let watchError: unknown,
      checking = false;
    const timer = setInterval(() => {
      if (checking || watchError !== undefined) return;
      checking = true;
      void this.state
        .assertActive({ tenantId: input.tenantId, operationId: input.operationId })
        .catch((error) => {
          watchError = error;
          controller.abort();
        })
        .finally(() => {
          checking = false;
        });
    }, this.#config.cancellationPollMs);
    try {
      const result = await this.admission.parseAndAdmit({
        tenantId: input.tenantId,
        captureId: input.captureId,
        expectedSourceArtifact: input.expectedSourceArtifact,
        kind: input.kind,
        signal: controller.signal,
      });
      if (watchError !== undefined) throw watchError;
      return result;
    } catch (error) {
      if (watchError !== undefined) throw watchError;
      throw error;
    } finally {
      clearInterval(timer);
    }
  }

  async #registerResult(
    context: OperationContext,
    useCase: "captureSource" | "verifyExtraction" | "replayRun",
    request: unknown,
    inputs: VerificationArtifactHandle[],
    outputValue: unknown,
    sourceOperationId?: string,
  ): Promise<VerificationOperationExecutionOutput> {
    await this.state.assertActive({ tenantId: context.tenantId, operationId: context.operationId });
    const output = JsonValueSchema.parse({
      request,
      ...(JsonValueSchema.parse(outputValue as JsonValue) as Record<string, JsonValue>),
    });
    const body = resultArtifactSchema.omit({}).parse({
      schemaVersion: "verification-operation-result.v1",
      operationId: context.operationId,
      useCase,
      requestDigest: digestCanonicalJson(request),
      ...(sourceOperationId ? { sourceOperationId } : {}),
      boundArtifacts: inputs,
      output,
    });
    const bytes = new TextEncoder().encode(canonicalizeJson(body));
    const parentArtifactIds = [...new Set(inputs.map((item) => item.artifactId))];
    const resultArtifact = await this.repository.registerContentAddressedArtifact({
      tenantId: context.tenantId,
      producerAttemptId: context.attemptId,
      ...(context.missionId ? { missionId: context.missionId } : {}),
      bytes,
      mediaType: "application/vnd.aiengineer.verification-operation-result+json",
      createdAt: new Date(this.#config.now()).toISOString(),
      producerActivityId: `verification-service:${useCase}`,
      producerVersion: this.#config.producerVersion,
      encryptionClass: this.#config.encryptionClass,
      retentionClass: this.#config.retentionClass,
      dataClassification: inputs.some((item) => item.dataClassification !== "public") ? "restricted" : "public",
      parentArtifactIds,
      transformationSignature: digestCanonicalJson({
        relation: "verification_service_result",
        operationId: context.operationId,
        useCase,
        requestDigest: body.requestDigest,
        parentArtifactIds,
      }),
      artifactType: useCase === "captureSource" ? "verification_bundle" : "deterministic_verification_result",
      bucketClass: "ledger",
      storageBucket: this.#config.storageBucket,
    });
    await this.state.assertActive({ tenantId: context.tenantId, operationId: context.operationId });
    return { ...body, resultArtifact };
  }
}

function parseCanonicalJson(bytes: Uint8Array): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("VERIFICATION_ARTIFACT_JSON_INVALID");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("VERIFICATION_ARTIFACT_JSON_INVALID");
  }
  if (canonicalizeJson(value) !== text) throw new Error("VERIFICATION_ARTIFACT_JSON_NONCANONICAL");
  return value;
}
