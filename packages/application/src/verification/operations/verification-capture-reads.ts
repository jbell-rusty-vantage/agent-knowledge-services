import { z } from "zod";
import {
  CaptureSourceRequestSchema,
  VerificationArtifactHandleSchema,
  VerificationCaptureTerminalResourceSchema,
  VerificationParseArtifactResultSchema,
  VerificationSourceCaptureSchema,
  VerificationSourceSchema,
  type VerificationCaptureTerminalResource,
} from "@aiengineer/knowledge-contracts";
import { canonicalizeJson, digestCanonicalJson } from "@aiengineer/knowledge-verification";

const admittedProjection = VerificationParseArtifactResultSchema.shape.output.shape.projections.element;
const projectionSchema = z.discriminatedUnion("projectionKind", [
  admittedProjection.extend({ projectionKind: z.literal("html_dom"), projectionOrdinal: z.literal(0) }),
  admittedProjection.extend({ projectionKind: z.literal("pdf_text"), projectionOrdinal: z.literal(0) }),
  admittedProjection.extend({ projectionKind: z.literal("geometry"), projectionOrdinal: z.literal(1) }),
]);
const outputSchema = z.strictObject({
  request: CaptureSourceRequestSchema,
  capture: VerificationSourceCaptureSchema,
  projections: z.array(projectionSchema).min(1).max(2),
  acquisitionReceipt: VerificationArtifactHandleSchema.optional(),
});
const resultSchema = z.strictObject({
  schemaVersion: z.literal("verification-operation-result.v1"),
  operationId: z.uuid(),
  useCase: z.literal("captureSource"),
  requestDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  boundArtifacts: z.array(VerificationArtifactHandleSchema).min(4).max(7),
  output: outputSchema,
  resultArtifact: VerificationArtifactHandleSchema,
});
const registeredSourceSchema = z.strictObject({
  source: VerificationSourceSchema,
  capture: VerificationSourceCaptureSchema,
});

export type VerificationCaptureReadState = "pending" | "failed" | "cancelled" | "succeeded";
export interface VerifiedCaptureTerminalLoader {
  /** Native authorization, bytes, result receipt, and operation state are verified by the runtime adapter before this call returns. */
  loadVerifiedCapture(
    tenantId: string,
    operationId: string,
  ): Promise<{
    readonly state: VerificationCaptureReadState;
    readonly result?: unknown;
    readonly registeredSource?: unknown;
  }>;
}

export interface VerificationCaptureReadService {
  getCapture(input: {
    readonly tenantId: string;
    readonly operationId: string;
  }): Promise<VerificationCaptureTerminalResource>;
}

const same = (left: unknown, right: unknown) => canonicalizeJson(left) === canonicalizeJson(right);
const reference = (handle: z.infer<typeof VerificationArtifactHandleSchema>) => ({
  artifactId: handle.artifactId,
  digest: handle.digest,
  mediaType: handle.mediaType,
  sizeBytes: handle.byteLength,
});
function requireTenant(tenantId: string, ...handles: readonly z.infer<typeof VerificationArtifactHandleSchema>[]) {
  if (handles.some((handle) => handle.tenantId !== tenantId))
    throw new Error("VERIFICATION_CAPTURE_READ_TENANT_BINDING");
}
function requireExactHandles(
  actual: readonly z.infer<typeof VerificationArtifactHandleSchema>[],
  expected: readonly z.infer<typeof VerificationArtifactHandleSchema>[],
) {
  if (
    actual.length !== expected.length ||
    new Set(actual.map((handle) => handle.artifactId)).size !== actual.length ||
    actual.some((handle, index) => !same(handle, expected[index]))
  )
    throw new Error("VERIFICATION_CAPTURE_READ_BOUND_ARTIFACTS");
}
function projectionSet(sourceKind: string, projections: readonly z.infer<typeof projectionSchema>[]) {
  if (
    sourceKind === "web_page" &&
    projections.length === 1 &&
    projections[0]!.projectionKind === "html_dom" &&
    projections[0]!.projectionOrdinal === 0
  )
    return "html" as const;
  if (
    sourceKind === "pdf" &&
    projections.length === 2 &&
    projections[0]!.projectionKind === "pdf_text" &&
    projections[0]!.projectionOrdinal === 0 &&
    projections[1]!.projectionKind === "geometry" &&
    projections[1]!.projectionOrdinal === 1
  )
    return "pdf" as const;
  throw new Error("VERIFICATION_CAPTURE_READ_PROJECTION_SET");
}
function expectedBound(
  receipt: z.infer<typeof VerificationArtifactHandleSchema> | undefined,
  capture: z.infer<typeof VerificationSourceCaptureSchema>,
  projections: readonly z.infer<typeof projectionSchema>[],
) {
  const candidates = [
    ...(receipt ? [receipt] : []),
    capture.contentArtifact,
    ...projections.flatMap((projection) => [
      projection.nativeOutputArtifact,
      projection.projectionArtifact,
      projection.transformationArtifact,
    ]),
  ];
  return candidates.filter(
    (handle, index) => candidates.findIndex((candidate) => candidate.artifactId === handle.artifactId) === index,
  );
}

/** Compact terminal read projection. It never hydrates or returns raw bytes, object keys, headers, or receipt body. */
export class VerificationCaptureReadApplicationService implements VerificationCaptureReadService {
  constructor(private readonly loader: VerifiedCaptureTerminalLoader) {}

  async getCapture(input: {
    readonly tenantId: string;
    readonly operationId: string;
  }): Promise<VerificationCaptureTerminalResource> {
    const loaded = await this.loader.loadVerifiedCapture(input.tenantId, input.operationId);
    if (loaded.state !== "succeeded")
      throw Object.assign(new Error("VERIFICATION_CAPTURE_READ_NOT_TERMINAL"), { code: loaded.state.toUpperCase() });
    if (loaded.result === undefined || loaded.registeredSource === undefined)
      throw new Error("VERIFICATION_CAPTURE_READ_TERMINAL_MISSING");
    const result = resultSchema.parse(loaded.result);
    const registered = registeredSourceSchema.parse(loaded.registeredSource);
    const { request, capture, projections, acquisitionReceipt } = result.output;
    const mode = projectionSet(registered.source.kind, projections);
    const requestedKinds = projections.map((projection) => projection.projectionKind);
    if (
      result.operationId !== input.operationId ||
      result.requestDigest !== digestCanonicalJson(request) ||
      registered.source.kind !== request.source.sourceKind ||
      request.requestedProjectionKinds.length !== requestedKinds.length ||
      request.requestedProjectionKinds.some((kind, index) => kind !== requestedKinds[index]) ||
      (request.source.mode === "acquire" && registered.source.canonicalUri !== request.source.sourceUri)
    )
      throw new Error("VERIFICATION_CAPTURE_READ_REQUEST_BINDING");
    if (
      !same(registered.capture, capture) ||
      capture.sourceId !== registered.source.sourceId ||
      projections.some(
        (projection) =>
          !same(capture.contentArtifact, projection.sourceArtifact) || projection.captureId !== capture.captureId,
      )
    )
      throw new Error("VERIFICATION_CAPTURE_READ_CAPTURE_BINDING");
    if (mode === "html" && capture.contentArtifact.mediaType !== "text/html")
      throw new Error("VERIFICATION_CAPTURE_READ_SOURCE_BINDING");
    if (
      mode === "pdf" &&
      (capture.contentArtifact.mediaType !== "application/pdf" ||
        !same(projections[0]!.nativeOutputArtifact, projections[1]!.nativeOutputArtifact) ||
        projections[0]!.parserVersion !== projections[1]!.parserVersion ||
        projections[0]!.imageDigest !== projections[1]!.imageDigest ||
        projections[0]!.parserOptionsDigest !== projections[1]!.parserOptionsDigest ||
        projections[0]!.parserTransformationSignature !== projections[1]!.parserTransformationSignature ||
        projections[0]!.residualsDigest !== projections[1]!.residualsDigest)
    )
      throw new Error("VERIFICATION_CAPTURE_READ_SOURCE_BINDING");
    const bound = expectedBound(acquisitionReceipt, capture, projections);
    requireTenant(input.tenantId, result.resultArtifact, capture.contentArtifact, ...bound);
    for (const projection of projections)
      if (
        !same(projection.transformationArtifact.parentArtifactIds, [
          capture.contentArtifact.artifactId,
          projection.nativeOutputArtifact.artifactId,
          projection.projectionArtifact.artifactId,
        ])
      )
        throw new Error("VERIFICATION_CAPTURE_READ_TRANSFORMATION_BINDING");
    requireExactHandles(result.boundArtifacts, bound);
    if (
      !same(
        result.resultArtifact.parentArtifactIds,
        bound.map((handle) => handle.artifactId),
      )
    )
      throw new Error("VERIFICATION_CAPTURE_READ_RESULT_LINEAGE");
    if (acquisitionReceipt) {
      if (
        request.source.mode !== "acquire" ||
        !same(capture.contentArtifact.parentArtifactIds, [acquisitionReceipt.artifactId]) ||
        acquisitionReceipt.parentArtifactIds.length !== 0
      )
        throw new Error("VERIFICATION_CAPTURE_READ_ACQUISITION_LINEAGE");
    } else if (request.source.mode !== "register" || mode !== "html")
      throw new Error("VERIFICATION_CAPTURE_READ_MODE_BINDING");
    const base = {
      verificationContractVersion: request.verificationContractVersion,
      tenantId: input.tenantId,
      operationId: result.operationId,
      state: "succeeded" as const,
      disposition: "captured_without_admission" as const,
      requestDigest: result.requestDigest,
      source: registered.source,
      capture: {
        captureId: capture.captureId,
        sourceId: capture.sourceId,
        capturedAt: capture.capturedAt,
        captureMethod: capture.captureMethod,
        captureMethodVersion: capture.captureMethodVersion,
        contentArtifact: reference(capture.contentArtifact),
      },
      projections: projections.map((projection) => ({
        schemaVersion: projection.schemaVersion,
        captureId: projection.captureId,
        projectionKind: projection.projectionKind,
        projectionOrdinal: projection.projectionOrdinal,
        sourceArtifact: reference(projection.sourceArtifact),
        nativeOutputArtifact: reference(projection.nativeOutputArtifact),
        projectionArtifact: reference(projection.projectionArtifact),
        transformationArtifact: reference(projection.transformationArtifact),
        parserVersion: projection.parserVersion,
        imageDigest: projection.imageDigest,
        parserOptionsDigest: projection.parserOptionsDigest,
        parserTransformationSignature: projection.parserTransformationSignature,
        residualsDigest: projection.residualsDigest,
      })),
      resultArtifact: reference(result.resultArtifact),
    };
    return VerificationCaptureTerminalResourceSchema.parse(
      acquisitionReceipt
        ? { ...base, captureMode: "acquire", acquisitionReceipt: reference(acquisitionReceipt) }
        : { ...base, captureMode: "register" },
    );
  }
}
