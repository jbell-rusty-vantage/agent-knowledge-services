import { z } from "zod";

import { Sha256DigestSchema, UuidSchema } from "./index-primitives.js";
import { VerificationSourceCaptureSchema, VerificationSourceSchema } from "./model.js";
import { VerificationParseArtifactResultSchema } from "./parse.js";
import { VerificationContractVersionSchema } from "./primitives.js";
import { VerificationArtifactReferenceSchema } from "./reads.js";

/** Public terminal capture custody projection. It deliberately omits artifact locators and bytes. */
const ArtifactSchema = VerificationArtifactReferenceSchema;
const sameArtifact = (left: z.infer<typeof ArtifactSchema>, right: z.infer<typeof ArtifactSchema>) =>
  left.artifactId === right.artifactId &&
  left.digest === right.digest &&
  left.mediaType === right.mediaType &&
  left.sizeBytes === right.sizeBytes;
const CaptureSchema = VerificationSourceCaptureSchema.pick({
  captureId: true,
  sourceId: true,
  capturedAt: true,
  captureMethod: true,
  captureMethodVersion: true,
}).extend({ contentArtifact: ArtifactSchema });
const ProjectionReceiptSchema = VerificationParseArtifactResultSchema.shape.output.shape.projections.element;
const projection = (kind: "html_dom" | "pdf_text" | "geometry", ordinal: 0 | 1) =>
  z.strictObject({
    schemaVersion: ProjectionReceiptSchema.shape.schemaVersion,
    captureId: ProjectionReceiptSchema.shape.captureId,
    projectionKind: z.literal(kind),
    projectionOrdinal: z.literal(ordinal),
    sourceArtifact: ArtifactSchema,
    nativeOutputArtifact: ArtifactSchema,
    projectionArtifact: ArtifactSchema,
    transformationArtifact: ArtifactSchema,
    parserVersion: ProjectionReceiptSchema.shape.parserVersion,
    imageDigest: ProjectionReceiptSchema.shape.imageDigest,
    parserOptionsDigest: ProjectionReceiptSchema.shape.parserOptionsDigest,
    parserTransformationSignature: ProjectionReceiptSchema.shape.parserTransformationSignature,
    residualsDigest: ProjectionReceiptSchema.shape.residualsDigest,
  });
const HtmlProjectionSchema = projection("html_dom", 0);
const PdfTextProjectionSchema = projection("pdf_text", 0);
const GeometryProjectionSchema = projection("geometry", 1);
const TerminalBaseSchema = z.strictObject({
  verificationContractVersion: VerificationContractVersionSchema,
  tenantId: UuidSchema,
  operationId: UuidSchema,
  state: z.literal("succeeded"),
  /** Capture/projection custody exists; this does not admit benchmark, semantic, policy, or human quality. */
  disposition: z.literal("captured_without_admission"),
  requestDigest: Sha256DigestSchema,
  capture: CaptureSchema,
  resultArtifact: ArtifactSchema,
});
const HtmlBaseSchema = TerminalBaseSchema.extend({
  source: VerificationSourceSchema.extend({ kind: z.literal("web_page") }),
  projections: z.tuple([HtmlProjectionSchema]),
});
const PdfBaseSchema = TerminalBaseSchema.extend({
  source: VerificationSourceSchema.extend({ kind: z.literal("pdf") }),
  projections: z.tuple([PdfTextProjectionSchema, GeometryProjectionSchema]),
});

function requireCaptureBinding(
  value: z.infer<typeof HtmlBaseSchema> | z.infer<typeof PdfBaseSchema>,
  context: z.RefinementCtx,
) {
  const projections = value.projections;
  if (
    value.capture.sourceId !== value.source.sourceId ||
    projections.some(
      (projection) =>
        projection.captureId !== value.capture.captureId ||
        !sameArtifact(value.capture.contentArtifact, projection.sourceArtifact),
    )
  ) {
    context.addIssue({
      code: "custom",
      path: ["capture"],
      message: "Capture, source, and projection custody must bind exactly",
    });
  }
  if (value.source.kind === "web_page") {
    if (value.capture.contentArtifact.mediaType !== "text/html")
      context.addIssue({
        code: "custom",
        path: ["capture", "contentArtifact", "mediaType"],
        message: "Web captures require text/html content",
      });
    const html = projections[0]!;
    const roles = [
      value.capture.contentArtifact.artifactId,
      html.nativeOutputArtifact.artifactId,
      html.projectionArtifact.artifactId,
      html.transformationArtifact.artifactId,
      value.resultArtifact.artifactId,
    ];
    if (new Set(roles).size !== roles.length)
      context.addIssue({
        code: "custom",
        path: ["projections"],
        message: "HTML terminal artifact roles must be distinct",
      });
    return;
  }
  if (value.capture.contentArtifact.mediaType !== "application/pdf")
    context.addIssue({
      code: "custom",
      path: ["capture", "contentArtifact", "mediaType"],
      message: "PDF captures require application/pdf content",
    });
  const [text, geometry] = projections;
  if (!text || !geometry) {
    context.addIssue({ code: "custom", path: ["projections"], message: "PDF requires text and geometry projections" });
    return;
  }
  if (
    !sameArtifact(text.nativeOutputArtifact, geometry.nativeOutputArtifact) ||
    text.parserVersion !== geometry.parserVersion ||
    text.imageDigest !== geometry.imageDigest ||
    text.parserOptionsDigest !== geometry.parserOptionsDigest ||
    text.parserTransformationSignature !== geometry.parserTransformationSignature ||
    text.residualsDigest !== geometry.residualsDigest
  )
    context.addIssue({
      code: "custom",
      path: ["projections"],
      message: "PDF projections must share exact native parser identity",
    });
  const roles = [
    value.capture.contentArtifact.artifactId,
    text.nativeOutputArtifact.artifactId,
    text.projectionArtifact.artifactId,
    text.transformationArtifact.artifactId,
    geometry.projectionArtifact.artifactId,
    geometry.transformationArtifact.artifactId,
    value.resultArtifact.artifactId,
  ];
  if (new Set(roles).size !== roles.length)
    context.addIssue({
      code: "custom",
      path: ["projections"],
      message: "PDF terminal artifact roles must be distinct except for the shared native output",
    });
}
const AcquiredHtmlSchema = HtmlBaseSchema.extend({
  captureMode: z.literal("acquire"),
  acquisitionReceipt: ArtifactSchema,
});
const AcquiredPdfSchema = PdfBaseSchema.extend({
  captureMode: z.literal("acquire"),
  acquisitionReceipt: ArtifactSchema,
});

/** Exact compact acquired HTML or PDF terminal read, matching the native parser’s admitted projection set. */
export const VerificationAcquiredCaptureTerminalResourceSchema = z
  .union([AcquiredHtmlSchema, AcquiredPdfSchema])
  .superRefine((value, context) => {
    requireCaptureBinding(value, context);
    if (
      value.capture.captureMethod !== "https_acquire" ||
      value.capture.captureMethodVersion !== "verification-source-acquisition.v1"
    )
      context.addIssue({
        code: "custom",
        path: ["capture"],
        message: "Acquired capture must use the trusted acquisition method",
      });
    const projectionIds = value.projections.flatMap((projection) => [
      projection.nativeOutputArtifact.artifactId,
      projection.projectionArtifact.artifactId,
      projection.transformationArtifact.artifactId,
    ]);
    if (
      projectionIds.includes(value.acquisitionReceipt.artifactId) ||
      value.acquisitionReceipt.artifactId === value.capture.contentArtifact.artifactId ||
      value.acquisitionReceipt.artifactId === value.resultArtifact.artifactId
    )
      context.addIssue({
        code: "custom",
        path: ["acquisitionReceipt"],
        message: "Acquisition receipt must be a distinct artifact role",
      });
  });
export type VerificationAcquiredCaptureTerminalResource = z.infer<
  typeof VerificationAcquiredCaptureTerminalResourceSchema
>;

/** Exact compact pre-registered HTML terminal read. Registered PDF capture remains unadmitted. */
export const VerificationRegisteredCaptureTerminalResourceSchema = HtmlBaseSchema.extend({
  captureMode: z.literal("register"),
}).superRefine(requireCaptureBinding);
export type VerificationRegisteredCaptureTerminalResource = z.infer<
  typeof VerificationRegisteredCaptureTerminalResourceSchema
>;

export const VerificationCaptureTerminalResourceSchema = z.union([
  VerificationAcquiredCaptureTerminalResourceSchema,
  VerificationRegisteredCaptureTerminalResourceSchema,
]);
export type VerificationCaptureTerminalResource = z.infer<typeof VerificationCaptureTerminalResourceSchema>;
