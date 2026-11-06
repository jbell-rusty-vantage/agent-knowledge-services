import type {
  VerificationArtifactHandle,
  VerificationSelector,
  VerificationSource,
  VerificationSourceCapture,
} from "@aiengineer/knowledge-contracts";
import { VerificationExtractionFieldEvidenceResultSchema } from "@aiengineer/knowledge-contracts";
import type { VerificationParserOutput, VerificationParserRequest } from "@aiengineer/knowledge-preparation";
import {
  canonicalizeJson,
  digestCanonicalJson,
  parseCanonicalProjection,
  projectionSelectorResolver,
  sha256Digest,
  verifyExtractionFields,
  verifyExtractionFieldsWithEvidence,
  type AdmittedExtractionSchema,
  type CanonicalProjection,
  type CrossFieldTotalRule,
  type DuplicateRecordRule,
  type ExtractionFieldRule,
  type ExtractionFieldVerificationResult,
  type ExtractionNormalizationRule,
  type TrustedArtifactResolver,
} from "@aiengineer/knowledge-verification";

type ParserKind = VerificationParserRequest["kind"];
type Digest = `sha256:${string}`;
type Classification = VerificationArtifactHandle["dataClassification"];

export interface VerificationParserPort {
  parse(request: VerificationParserRequest): Promise<VerificationParserOutput>;
}

export interface RegisterAdmissionArtifactInput {
  readonly producerAttemptId?: string;
  readonly missionId?: string;
  readonly tenantId: string;
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly createdAt: string;
  readonly producerActivityId: string;
  readonly producerVersion: string;
  readonly encryptionClass: string;
  readonly retentionClass: string;
  readonly dataClassification: Classification;
  readonly parentArtifactIds?: readonly string[];
  readonly transformationSignature?: Digest;
  readonly artifactType: string;
  readonly bucketClass: "source_captures" | "candidate" | "accepted" | "ledger" | "published";
  readonly storageBucket: string;
}

export interface VerificationAdmissionRepositoryPort {
  createTrustedArtifactResolver(): TrustedArtifactResolver;
  getRegisteredCapture(input: {
    readonly tenantId: string;
    readonly captureId: string;
  }): Promise<{ source: VerificationSource; capture: VerificationSourceCapture }>;
  registerContentAddressedArtifact(input: RegisterAdmissionArtifactInput): Promise<VerificationArtifactHandle>;
}

export interface VerificationParserDeployment {
  readonly parserVersion: "verification-native-parser.v1";
  readonly imageDigest: Digest;
  readonly limits: Readonly<Record<string, number>>;
}

export interface ProjectionAdmissionReceipt {
  readonly schemaVersion: "verification-projection-admission.v1";
  readonly captureId: string;
  readonly sourceArtifact: VerificationArtifactHandle;
  readonly nativeOutputArtifact: VerificationArtifactHandle;
  readonly projectionArtifact: VerificationArtifactHandle;
  readonly transformationArtifact: VerificationArtifactHandle;
  readonly projectionKind: CanonicalProjection["kind"];
  readonly projectionOrdinal: number;
  readonly parserVersion: "verification-native-parser.v1";
  readonly imageDigest: Digest;
  readonly parserOptionsDigest: Digest;
  readonly parserTransformationSignature: Digest;
  readonly residualsDigest: Digest;
}

interface TransformationEnvelope {
  readonly schemaVersion: "verification-projection-admission.v1";
  readonly tenantId: string;
  readonly captureId: string;
  readonly sourceArtifact: { readonly artifactId: string; readonly digest: Digest };
  readonly nativeOutputArtifact: { readonly artifactId: string; readonly digest: Digest };
  readonly projectionArtifact: {
    readonly artifactId: string;
    readonly digest: Digest;
    readonly kind: CanonicalProjection["kind"];
  };
  readonly projectionOrdinal: number;
  readonly parser: {
    readonly parserVersion: "verification-native-parser.v1";
    readonly imageDigest: Digest;
    readonly optionsDigest: Digest;
    readonly transformationSignature: Digest;
  };
  readonly residualsDigest: Digest;
}

export interface AdmittedExtractionEvidence {
  readonly path: string;
  readonly captureId: string;
  readonly projectionArtifactId: string;
  readonly transformationArtifactId: string;
  readonly selector: VerificationSelector;
  readonly expectedSelectedContentDigest?: Digest;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const MAX_JSON_NODES = 100_000,
  MAX_JSON_DEPTH = 64,
  MAX_JSON_STRING_BYTES = 4_000_000,
  MAX_NATIVE_OUTPUT_BYTES = 4_000_000,
  MAX_ENVELOPE_BYTES = 64_000;
const PARSER_LIMIT_KEYS = [
  "inputBytes",
  "outputBytes",
  "timeoutMs",
  "memoryBytes",
  "cpuSeconds",
  "cpus",
  "temporaryBytes",
  "pages",
  "pids",
] as const;
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const exactKeys = (value: Record<string, unknown>, keys: readonly string[], code: string): void => {
  const actual = Object.keys(value).sort(),
    expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error(code);
};
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const canonicalBytes = (value: unknown): Uint8Array => encoder.encode(canonicalizeJson(value));

function preflightJson(value: unknown): void {
  const stack: [unknown, number][] = [[value, 0]];
  const seen = new Set<object>();
  let nodes = 0,
    totalStringBytes = 0;
  while (stack.length) {
    const [item, depth] = stack.pop()!;
    nodes += 1;
    if (nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) throw new Error("PARSER_OUTPUT_PREFLIGHT_LIMIT");
    if (item === null || typeof item === "boolean") continue;
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new Error("PARSER_OUTPUT_NOT_JSON");
      continue;
    }
    if (typeof item === "string") {
      if (item.length > MAX_JSON_STRING_BYTES - totalStringBytes) throw new Error("PARSER_OUTPUT_PREFLIGHT_LIMIT");
      totalStringBytes += encoder.encode(item).byteLength;
      if (totalStringBytes > MAX_JSON_STRING_BYTES) throw new Error("PARSER_OUTPUT_PREFLIGHT_LIMIT");
      continue;
    }
    if (typeof item !== "object") throw new Error("PARSER_OUTPUT_NOT_JSON");
    if (seen.has(item)) throw new Error("PARSER_OUTPUT_NOT_JSON");
    seen.add(item);
    if (Array.isArray(item)) {
      if (item.length > MAX_JSON_NODES - nodes - stack.length) throw new Error("PARSER_OUTPUT_PREFLIGHT_LIMIT");
      for (let index = item.length - 1; index >= 0; index -= 1) stack.push([item[index], depth + 1]);
    } else {
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null)
        throw new Error("PARSER_OUTPUT_NOT_JSON");
      for (const key in item)
        if (Object.prototype.hasOwnProperty.call(item, key)) {
          if (nodes + stack.length >= MAX_JSON_NODES || key.length > MAX_JSON_STRING_BYTES - totalStringBytes)
            throw new Error("PARSER_OUTPUT_PREFLIGHT_LIMIT");
          totalStringBytes += encoder.encode(key).byteLength;
          if (totalStringBytes > MAX_JSON_STRING_BYTES) throw new Error("PARSER_OUTPUT_PREFLIGHT_LIMIT");
          const descriptor = Object.getOwnPropertyDescriptor(item, key);
          if (!descriptor || !("value" in descriptor)) throw new Error("PARSER_OUTPUT_NOT_JSON");
          stack.push([descriptor.value, depth + 1]);
        }
    }
  }
}

function parserOptionsDigest(deployment: VerificationParserDeployment, kind: ParserKind): Digest {
  return digestCanonicalJson({ kind, limits: { ...deployment.limits } });
}

function expectedParserTransformation(deployment: VerificationParserDeployment, kind: ParserKind): Digest {
  return digestCanonicalJson({
    parserVersion: deployment.parserVersion,
    imageDigest: deployment.imageDigest,
    limits: { ...deployment.limits },
    kind,
  });
}

function strictResiduals(kind: ParserKind, value: readonly unknown[], pageCount?: number): readonly unknown[] {
  if (value.length > 1_000) throw new Error("PARSER_RESIDUAL_LIMIT");
  const admitted = value.map((item) => {
    if (!record(item)) throw new Error("PARSER_RESIDUAL_INVALID");
    if (kind === "html") {
      exactKeys(item, ["code", "detail"], "PARSER_RESIDUAL_INVALID");
      if (
        item.code !== "CSS_LAYOUT_NOT_EXECUTED" ||
        typeof item.detail !== "string" ||
        item.detail.length < 1 ||
        item.detail.length > 2_000
      )
        throw new Error("PARSER_RESIDUAL_INVALID");
      return { code: item.code, detail: item.detail };
    }
    if (item.code !== "PDF_INVALID_WORD_BOX" && item.code !== "VISUAL_CONTENT_NOT_ASSESSED")
      throw new Error("PARSER_RESIDUAL_INVALID");
    const keys =
      item.code === "PDF_INVALID_WORD_BOX" ? ["code", "physicalPageNumber"] : ["code", "physicalPageNumber", "detail"];
    exactKeys(item, keys, "PARSER_RESIDUAL_INVALID");
    if (
      !Number.isSafeInteger(item.physicalPageNumber) ||
      (item.physicalPageNumber as number) < 1 ||
      (pageCount !== undefined && (item.physicalPageNumber as number) > pageCount)
    )
      throw new Error("PARSER_RESIDUAL_INVALID");
    if (
      item.code === "VISUAL_CONTENT_NOT_ASSESSED" &&
      (typeof item.detail !== "string" || item.detail.length < 1 || item.detail.length > 2_000)
    )
      throw new Error("PARSER_RESIDUAL_INVALID");
    return item.code === "PDF_INVALID_WORD_BOX"
      ? { code: item.code, physicalPageNumber: item.physicalPageNumber }
      : { code: item.code, physicalPageNumber: item.physicalPageNumber, detail: item.detail };
  });
  if (
    kind === "html" &&
    (admitted.length !== 1 || (admitted[0] as Record<string, unknown>).code !== "CSS_LAYOUT_NOT_EXECUTED")
  )
    throw new Error("PARSER_RESIDUAL_INVALID");
  if (kind === "pdf" && pageCount !== undefined)
    for (let page = 1; page <= pageCount; page += 1) {
      if (
        !admitted.some(
          (item) =>
            (item as Record<string, unknown>).code === "VISUAL_CONTENT_NOT_ASSESSED" &&
            (item as Record<string, unknown>).physicalPageNumber === page,
        )
      )
        throw new Error("PARSER_VISUAL_RESIDUAL_MISSING");
    }
  return admitted;
}

function validateProjectionSet(
  kind: ParserKind,
  output: VerificationParserOutput,
  maximumNativeOutputBytes = MAX_NATIVE_OUTPUT_BYTES,
): { projections: readonly { value: CanonicalProjection; bytes: Uint8Array }[]; residuals: readonly unknown[] } {
  if (output.parserVersion !== "verification-native-parser.v1") throw new Error("PARSER_OUTPUT_IDENTITY_INVALID");
  preflightJson(output.projections);
  preflightJson(output.residuals);
  const projections = output.projections.map((candidate) => {
    const bytes = canonicalBytes(candidate);
    return { value: parseCanonicalProjection(bytes), bytes };
  });
  const kinds = projections.map((item) => item.value.kind);
  if (
    kind === "html"
      ? kinds.length !== 1 || kinds[0] !== "html_dom"
      : kinds.length !== 2 || kinds[0] !== "pdf_text" || kinds[1] !== "geometry"
  )
    throw new Error("PARSER_PROJECTION_SET_INVALID");
  let pageCount: number | undefined;
  if (kind === "pdf") {
    const pdf = projections[0]!.value;
    const geometry = projections[1]!.value;
    if (pdf.kind !== "pdf_text" || geometry.kind !== "geometry") throw new Error("PARSER_PROJECTION_SET_INVALID");
    pageCount = pdf.pageCount;
    for (const page of pdf.pages)
      if (page.textLayerDigest !== sha256Digest(encoder.encode(page.text)))
        throw new Error("PARSER_TEXT_LAYER_DIGEST_INVALID");
    const visualPages = new Set(
      pdf.residuals?.filter((item) => item.kind === "unresolved_visual_content").map((item) => item.physicalPageNumber),
    );
    if (visualPages.size !== pdf.pageCount || pdf.pages.some((page) => !visualPages.has(page.physicalPageNumber)))
      throw new Error("PARSER_VISUAL_RESIDUAL_MISSING");
    if (
      geometry.pages.length !== pdf.pageCount ||
      geometry.pages.some(
        (page, index) =>
          page.physicalPageNumber !== pdf.pages[index]!.physicalPageNumber ||
          page.widthPoints !== pdf.pages[index]!.widthPoints ||
          page.heightPoints !== pdf.pages[index]!.heightPoints,
      )
    )
      throw new Error("PARSER_PROJECTION_CROSS_BINDING_INVALID");
  }
  const residuals = strictResiduals(kind, output.residuals, pageCount);
  if (output.nativeOutput.byteLength > Math.min(MAX_NATIVE_OUTPUT_BYTES, maximumNativeOutputBytes))
    throw new Error("PARSER_NATIVE_OUTPUT_LIMIT");
  let native: unknown;
  try {
    native = JSON.parse(decoder.decode(output.nativeOutput));
  } catch {
    throw new Error("PARSER_NATIVE_OUTPUT_INVALID");
  }
  preflightJson(native);
  if (!record(native)) {
    throw new Error("PARSER_NATIVE_OUTPUT_INVALID");
  }
  exactKeys(native, ["parserVersion", "parentDigest", "projections", "residuals"], "PARSER_NATIVE_OUTPUT_INVALID");
  if (
    native.parserVersion !== output.parserVersion ||
    native.parentDigest !== output.parentDigest ||
    canonicalizeJson(native.projections) !== canonicalizeJson(output.projections) ||
    canonicalizeJson(native.residuals) !== canonicalizeJson(output.residuals)
  )
    throw new Error("PARSER_NATIVE_OUTPUT_BINDING_INVALID");
  if (output.nativeOutputDigest !== sha256Digest(output.nativeOutput))
    throw new Error("PARSER_NATIVE_OUTPUT_DIGEST_INVALID");
  return { projections, residuals };
}

function parseEnvelope(bytes: Uint8Array): TransformationEnvelope {
  if (bytes.byteLength > MAX_ENVELOPE_BYTES) throw new Error("PROJECTION_ENVELOPE_LIMIT");
  let value: unknown;
  try {
    const text = decoder.decode(bytes);
    value = JSON.parse(text);
    preflightJson(value);
    if (canonicalizeJson(value) !== text) throw new Error();
  } catch (error) {
    if (error instanceof Error && error.message === "PARSER_OUTPUT_PREFLIGHT_LIMIT") throw error;
    throw new Error("PROJECTION_ENVELOPE_INVALID");
  }
  if (!record(value)) throw new Error("PROJECTION_ENVELOPE_INVALID");
  exactKeys(
    value,
    [
      "schemaVersion",
      "tenantId",
      "captureId",
      "sourceArtifact",
      "nativeOutputArtifact",
      "projectionArtifact",
      "projectionOrdinal",
      "parser",
      "residualsDigest",
    ],
    "PROJECTION_ENVELOPE_INVALID",
  );
  for (const key of ["sourceArtifact", "nativeOutputArtifact", "projectionArtifact", "parser"] as const)
    if (!record(value[key])) throw new Error("PROJECTION_ENVELOPE_INVALID");
  exactKeys(value.sourceArtifact as Record<string, unknown>, ["artifactId", "digest"], "PROJECTION_ENVELOPE_INVALID");
  exactKeys(
    value.nativeOutputArtifact as Record<string, unknown>,
    ["artifactId", "digest"],
    "PROJECTION_ENVELOPE_INVALID",
  );
  exactKeys(
    value.projectionArtifact as Record<string, unknown>,
    ["artifactId", "digest", "kind"],
    "PROJECTION_ENVELOPE_INVALID",
  );
  exactKeys(
    value.parser as Record<string, unknown>,
    ["parserVersion", "imageDigest", "optionsDigest", "transformationSignature"],
    "PROJECTION_ENVELOPE_INVALID",
  );
  const encoded = canonicalizeJson(value);
  const parsed = JSON.parse(encoded) as TransformationEnvelope;
  if (
    parsed.schemaVersion !== "verification-projection-admission.v1" ||
    !uuidPattern.test(parsed.tenantId) ||
    !uuidPattern.test(parsed.captureId) ||
    !uuidPattern.test(parsed.sourceArtifact.artifactId) ||
    !uuidPattern.test(parsed.nativeOutputArtifact.artifactId) ||
    !uuidPattern.test(parsed.projectionArtifact.artifactId) ||
    !digestPattern.test(parsed.sourceArtifact.digest) ||
    !digestPattern.test(parsed.nativeOutputArtifact.digest) ||
    !digestPattern.test(parsed.projectionArtifact.digest) ||
    !digestPattern.test(parsed.parser.imageDigest) ||
    !digestPattern.test(parsed.parser.optionsDigest) ||
    !digestPattern.test(parsed.parser.transformationSignature) ||
    !digestPattern.test(parsed.residualsDigest) ||
    parsed.parser.parserVersion !== "verification-native-parser.v1" ||
    !Number.isSafeInteger(parsed.projectionOrdinal) ||
    parsed.projectionOrdinal < 0
  )
    throw new Error("PROJECTION_ENVELOPE_INVALID");
  return parsed;
}

export class VerificationAdmissionService {
  private readonly deployment: VerificationParserDeployment;
  private readonly config: {
    readonly storageBucket: string;
    readonly producerVersion: string;
    readonly encryptionClass: string;
    readonly retentionClass: string;
    readonly now: () => string;
  };
  constructor(
    private readonly repository: VerificationAdmissionRepositoryPort,
    private readonly parser: VerificationParserPort,
    deployment: VerificationParserDeployment,
    config: {
      readonly storageBucket: string;
      readonly producerVersion: string;
      readonly encryptionClass: string;
      readonly retentionClass: string;
      readonly now: () => string;
    },
  ) {
    const actualLimitKeys = Object.keys(deployment.limits).sort(),
      expectedLimitKeys = [...PARSER_LIMIT_KEYS].sort();
    if (
      deployment.parserVersion !== "verification-native-parser.v1" ||
      !digestPattern.test(deployment.imageDigest) ||
      actualLimitKeys.length !== expectedLimitKeys.length ||
      actualLimitKeys.some((key, index) => key !== expectedLimitKeys[index]) ||
      Object.values(deployment.limits).some((value) => !Number.isSafeInteger(value) || value < 1)
    )
      throw new Error("PARSER_DEPLOYMENT_INVALID");
    this.deployment = Object.freeze({
      parserVersion: deployment.parserVersion,
      imageDigest: deployment.imageDigest,
      limits: Object.freeze({ ...deployment.limits }),
    });
    this.config = Object.freeze({
      storageBucket: config.storageBucket,
      producerVersion: config.producerVersion,
      encryptionClass: config.encryptionClass,
      retentionClass: config.retentionClass,
      now: config.now,
    });
  }

  private cancelled(signal?: AbortSignal): void {
    if (signal?.aborted) throw new Error("PARSER_CANCELLED");
  }

  private async hydrate(
    tenantId: string,
    artifactId: string,
  ): Promise<{ registration: VerificationArtifactHandle; bytes: Uint8Array }> {
    const resolver = this.repository.createTrustedArtifactResolver();
    await resolver.authorizeArtifact({ tenantId, artifactId, purpose: "verification_admission" });
    const hydrated = await resolver.hydrateRegisteredArtifact({ tenantId, artifactId });
    if (
      hydrated.registration.tenantId !== tenantId ||
      hydrated.registration.artifactId !== artifactId ||
      hydrated.bytes.byteLength !== hydrated.registration.byteLength ||
      sha256Digest(hydrated.bytes) !== hydrated.registration.digest
    )
      throw new Error("ADMISSION_ARTIFACT_INTEGRITY_FAILURE");
    return hydrated;
  }

  private async capture(input: {
    tenantId: string;
    captureId: string;
    expectedSourceArtifact: { artifactId: string; digest: Digest };
  }) {
    if (
      !uuidPattern.test(input.tenantId) ||
      !uuidPattern.test(input.captureId) ||
      !uuidPattern.test(input.expectedSourceArtifact.artifactId) ||
      !digestPattern.test(input.expectedSourceArtifact.digest)
    )
      throw new Error("ADMISSION_IDENTITY_INVALID");
    const binding = await this.repository.getRegisteredCapture({
      tenantId: input.tenantId,
      captureId: input.captureId,
    });
    if (
      binding.capture.contentArtifact.tenantId !== input.tenantId ||
      binding.capture.contentArtifact.artifactId !== input.expectedSourceArtifact.artifactId ||
      binding.capture.contentArtifact.digest !== input.expectedSourceArtifact.digest
    )
      throw new Error("CAPTURE_EXPECTED_IDENTITY_MISMATCH");
    const hydrated = await this.hydrate(input.tenantId, binding.capture.contentArtifact.artifactId);
    if (canonicalizeJson(hydrated.registration) !== canonicalizeJson(binding.capture.contentArtifact))
      throw new Error("CAPTURE_REGISTRATION_MISMATCH");
    return { binding, hydrated };
  }

  async parseAndAdmit(input: {
    readonly tenantId: string;
    readonly captureId: string;
    readonly expectedSourceArtifact: { readonly artifactId: string; readonly digest: Digest };
    readonly kind: ParserKind;
    readonly signal?: AbortSignal;
  }): Promise<readonly ProjectionAdmissionReceipt[]> {
    const { binding, hydrated } = await this.capture(input);
    this.cancelled(input.signal);
    if (
      (input.kind === "pdf" && binding.source.kind !== "pdf") ||
      (input.kind === "html" && binding.source.kind !== "web_page")
    )
      throw new Error("CAPTURE_PARSER_KIND_MISMATCH");
    const transformation = expectedParserTransformation(this.deployment, input.kind);
    const optionsDigest = parserOptionsDigest(this.deployment, input.kind);
    const output = await this.parser.parse({
      kind: input.kind,
      bytes: hydrated.bytes,
      parentDigest: hydrated.registration.digest as Digest,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    this.cancelled(input.signal);
    if (
      output.parentDigest !== hydrated.registration.digest ||
      output.imageDigest !== this.deployment.imageDigest ||
      output.parserVersion !== this.deployment.parserVersion ||
      output.transformationSignature !== transformation
    )
      throw new Error("PARSER_DEPLOYMENT_IDENTITY_MISMATCH");
    const admitted = validateProjectionSet(input.kind, output, this.deployment.limits.outputBytes!); // complete preflight before the first persistent write
    this.cancelled(input.signal);
    const createdAt = new Date(this.config.now()).toISOString();
    const common = {
      tenantId: input.tenantId,
      createdAt,
      producerActivityId: "verification-parser-admission",
      producerVersion: this.config.producerVersion,
      encryptionClass: this.config.encryptionClass,
      retentionClass: this.config.retentionClass,
      dataClassification: hydrated.registration.dataClassification,
      storageBucket: this.config.storageBucket,
    } as const;
    const nativeOutputArtifact = await this.repository.registerContentAddressedArtifact({
      ...common,
      bytes: output.nativeOutput,
      mediaType: "application/vnd.aiengineer.verification-parser-output+json",
      artifactType: "verification_parser_native_output",
      bucketClass: "candidate",
    });
    const projectionArtifacts: VerificationArtifactHandle[] = [];
    for (const projection of admitted.projections) {
      this.cancelled(input.signal);
      projectionArtifacts.push(
        await this.repository.registerContentAddressedArtifact({
          ...common,
          bytes: projection.bytes,
          mediaType: `application/vnd.aiengineer.verification-projection.${projection.value.kind}+json`,
          artifactType: "verification_canonical_projection",
          bucketClass: "candidate",
        }),
      );
    }
    const residualsDigest = sha256Digest(canonicalBytes(admitted.residuals));
    const receipts: ProjectionAdmissionReceipt[] = [];
    for (let ordinal = 0; ordinal < admitted.projections.length; ordinal += 1) {
      this.cancelled(input.signal);
      const projection = admitted.projections[ordinal]!,
        projectionArtifact = projectionArtifacts[ordinal]!;
      const envelope: TransformationEnvelope = {
        schemaVersion: "verification-projection-admission.v1",
        tenantId: input.tenantId,
        captureId: input.captureId,
        sourceArtifact: {
          artifactId: hydrated.registration.artifactId,
          digest: hydrated.registration.digest as Digest,
        },
        nativeOutputArtifact: {
          artifactId: nativeOutputArtifact.artifactId,
          digest: nativeOutputArtifact.digest as Digest,
        },
        projectionArtifact: {
          artifactId: projectionArtifact.artifactId,
          digest: projectionArtifact.digest as Digest,
          kind: projection.value.kind,
        },
        projectionOrdinal: ordinal,
        parser: {
          parserVersion: output.parserVersion,
          imageDigest: output.imageDigest,
          optionsDigest,
          transformationSignature: output.transformationSignature,
        },
        residualsDigest,
      };
      const envelopeSignature = digestCanonicalJson({
        relation: "verification_projection_admission",
        parser: envelope.parser,
        projectionKind: projection.value.kind,
        projectionOrdinal: ordinal,
      });
      const transformationArtifact = await this.repository.registerContentAddressedArtifact({
        ...common,
        bytes: canonicalBytes(envelope),
        mediaType: "application/vnd.aiengineer.verification-projection-admission+json",
        artifactType: "verification_transformation_envelope",
        bucketClass: "ledger",
        parentArtifactIds: [
          hydrated.registration.artifactId,
          nativeOutputArtifact.artifactId,
          projectionArtifact.artifactId,
        ],
        transformationSignature: envelopeSignature,
      });
      receipts.push(
        Object.freeze({
          schemaVersion: envelope.schemaVersion,
          captureId: input.captureId,
          sourceArtifact: hydrated.registration,
          nativeOutputArtifact,
          projectionArtifact,
          transformationArtifact,
          projectionKind: projection.value.kind,
          projectionOrdinal: ordinal,
          parserVersion: output.parserVersion,
          imageDigest: output.imageDigest,
          parserOptionsDigest: optionsDigest,
          parserTransformationSignature: output.transformationSignature,
          residualsDigest,
        }),
      );
    }
    this.cancelled(input.signal);
    return receipts;
  }

  async hydrateAdmittedProjection(input: {
    readonly tenantId: string;
    readonly captureId: string;
    readonly expectedSourceArtifact: { readonly artifactId: string; readonly digest: Digest };
    readonly transformationArtifactId: string;
    readonly projectionArtifactId: string;
  }): Promise<{ receipt: ProjectionAdmissionReceipt; projection: CanonicalProjection; content: Uint8Array }> {
    const { hydrated: source } = await this.capture(input);
    const transformation = await this.hydrate(input.tenantId, input.transformationArtifactId);
    const envelope = parseEnvelope(transformation.bytes);
    if (
      envelope.tenantId !== input.tenantId ||
      envelope.captureId !== input.captureId ||
      envelope.sourceArtifact.artifactId !== source.registration.artifactId ||
      envelope.sourceArtifact.digest !== source.registration.digest ||
      envelope.projectionArtifact.artifactId !== input.projectionArtifactId
    )
      throw new Error("PROJECTION_ENVELOPE_BINDING_MISMATCH");
    const expectedOptions = parserOptionsDigest(
      this.deployment,
      envelope.projectionArtifact.kind === "html_dom" ? "html" : "pdf",
    );
    const expectedTransformation = expectedParserTransformation(
      this.deployment,
      envelope.projectionArtifact.kind === "html_dom" ? "html" : "pdf",
    );
    if (
      envelope.parser.parserVersion !== this.deployment.parserVersion ||
      envelope.parser.imageDigest !== this.deployment.imageDigest ||
      envelope.parser.optionsDigest !== expectedOptions ||
      envelope.parser.transformationSignature !== expectedTransformation
    )
      throw new Error("PROJECTION_ENVELOPE_PARSER_MISMATCH");
    const expectedParents = [
      source.registration.artifactId,
      envelope.nativeOutputArtifact.artifactId,
      envelope.projectionArtifact.artifactId,
    ];
    const expectedEnvelopeSignature = digestCanonicalJson({
      relation: "verification_projection_admission",
      parser: envelope.parser,
      projectionKind: envelope.projectionArtifact.kind,
      projectionOrdinal: envelope.projectionOrdinal,
    });
    if (
      canonicalizeJson(transformation.registration.parentArtifactIds) !== canonicalizeJson(expectedParents) ||
      transformation.registration.transformationSignature !== expectedEnvelopeSignature
    )
      throw new Error("PROJECTION_ENVELOPE_LINEAGE_MISMATCH");
    const nativeOutput = await this.hydrate(input.tenantId, envelope.nativeOutputArtifact.artifactId);
    const projectionArtifact = await this.hydrate(input.tenantId, envelope.projectionArtifact.artifactId);
    if (
      nativeOutput.registration.digest !== envelope.nativeOutputArtifact.digest ||
      projectionArtifact.registration.digest !== envelope.projectionArtifact.digest
    )
      throw new Error("PROJECTION_ENVELOPE_ARTIFACT_MISMATCH");
    if (nativeOutput.bytes.byteLength > Math.min(MAX_NATIVE_OUTPUT_BYTES, this.deployment.limits.outputBytes!))
      throw new Error("PARSER_NATIVE_OUTPUT_LIMIT");
    let native: unknown;
    try {
      native = JSON.parse(decoder.decode(nativeOutput.bytes));
    } catch {
      throw new Error("PARSER_NATIVE_OUTPUT_INVALID");
    }
    preflightJson(native);
    if (
      !record(native) ||
      !Array.isArray(native.projections) ||
      !Array.isArray(native.residuals) ||
      native.parserVersion !== envelope.parser.parserVersion ||
      native.parentDigest !== source.registration.digest
    )
      throw new Error("PROJECTION_NATIVE_OUTPUT_BINDING_MISMATCH");
    const route: ParserKind = envelope.projectionArtifact.kind === "html_dom" ? "html" : "pdf";
    const nativeAdmission = validateProjectionSet(
      route,
      {
        parserVersion: envelope.parser.parserVersion,
        parentDigest: source.registration.digest as Digest,
        projections: native.projections,
        residuals: native.residuals,
        nativeOutput: nativeOutput.bytes,
        nativeOutputDigest: nativeOutput.registration.digest as Digest,
        imageDigest: envelope.parser.imageDigest,
        transformationSignature: envelope.parser.transformationSignature,
      },
      this.deployment.limits.outputBytes!,
    );
    if (
      sha256Digest(canonicalBytes(nativeAdmission.residuals)) !== envelope.residualsDigest ||
      envelope.projectionOrdinal >= nativeAdmission.projections.length ||
      decoder.decode(nativeAdmission.projections[envelope.projectionOrdinal]!.bytes) !==
        decoder.decode(projectionArtifact.bytes)
    )
      throw new Error("PROJECTION_NATIVE_OUTPUT_BINDING_MISMATCH");
    const projection = parseCanonicalProjection(projectionArtifact.bytes);
    if (projection.kind !== envelope.projectionArtifact.kind) throw new Error("PROJECTION_KIND_BINDING_MISMATCH");
    return {
      receipt: {
        schemaVersion: envelope.schemaVersion,
        captureId: envelope.captureId,
        sourceArtifact: source.registration,
        nativeOutputArtifact: nativeOutput.registration,
        projectionArtifact: projectionArtifact.registration,
        transformationArtifact: transformation.registration,
        projectionKind: projection.kind,
        projectionOrdinal: envelope.projectionOrdinal,
        parserVersion: envelope.parser.parserVersion,
        imageDigest: envelope.parser.imageDigest,
        parserOptionsDigest: envelope.parser.optionsDigest,
        parserTransformationSignature: envelope.parser.transformationSignature,
        residualsDigest: envelope.residualsDigest,
      },
      projection,
      content: projectionArtifact.bytes,
    };
  }

  async verifyExtraction(input: {
    readonly tenantId: string;
    readonly expectedSourceArtifact: { readonly artifactId: string; readonly digest: Digest };
    readonly schema: AdmittedExtractionSchema;
    readonly candidate: unknown;
    readonly fields: readonly ExtractionFieldRule[];
    readonly evidence: readonly AdmittedExtractionEvidence[];
    readonly normalizations?: readonly ExtractionNormalizationRule[];
    readonly duplicates?: readonly DuplicateRecordRule[];
    readonly totals?: readonly CrossFieldTotalRule[];
  }): Promise<ExtractionFieldVerificationResult> {
    const { coreInput } = await this.#prepareExtraction(input);
    return verifyExtractionFields(coreInput);
  }

  /** Current production extraction retains every accepted leaf and canonical
   * parent closure. Historical check-only replay uses verifyExtraction above. */
  async verifyExtractionWithEvidence(input: Parameters<VerificationAdmissionService["verifyExtraction"]>[0]) {
    const { coreInput, pairs } = await this.#prepareExtraction(input);
    const verified = verifyExtractionFieldsWithEvidence(coreInput);
    const reference = (handle: VerificationArtifactHandle) => ({
      artifactId: handle.artifactId,
      digest: handle.digest,
    });
    const acceptedLeaves = verified.acceptedLeaves.map((leaf) => {
      const admitted = [...pairs.values()].filter(
        (item) =>
          item.receipt.captureId === leaf.source.captureId &&
          item.receipt.projectionArtifact.artifactId === leaf.source.representationArtifactId &&
          item.receipt.projectionArtifact.digest === leaf.source.representationDigest,
      );
      if (admitted.length !== 1) throw new Error("EXTRACTION_LEAF_LINEAGE_AMBIGUOUS");
      const receipt = admitted[0]!.receipt;
      return {
        ...leaf,
        lineage: {
          schemaVersion: "verification-extraction-leaf-lineage.v1" as const,
          sourceArtifact: reference(receipt.sourceArtifact),
          nativeOutputArtifact: reference(receipt.nativeOutputArtifact),
          transformationArtifact: reference(receipt.transformationArtifact),
          projectionArtifact: reference(receipt.projectionArtifact),
          parserVersion: receipt.parserVersion,
          imageDigest: receipt.imageDigest,
          parserOptionsDigest: receipt.parserOptionsDigest,
          parserTransformationSignature: receipt.parserTransformationSignature,
        },
      };
    });
    const result = VerificationExtractionFieldEvidenceResultSchema.parse({ ...verified, acceptedLeaves });
    const artifacts = new Map<string, VerificationArtifactHandle>();
    for (const { receipt } of pairs.values())
      for (const artifact of [
        receipt.sourceArtifact,
        receipt.nativeOutputArtifact,
        receipt.transformationArtifact,
        receipt.projectionArtifact,
      ])
        artifacts.set(artifact.artifactId, artifact);
    return { result, boundArtifacts: [...artifacts.values()] };
  }

  async #prepareExtraction(input: Parameters<VerificationAdmissionService["verifyExtraction"]>[0]) {
    if (input.evidence.length > 10_000) throw new Error("ADMISSION_EVIDENCE_LIMIT");
    const pairs = new Map<string, Awaited<ReturnType<VerificationAdmissionService["hydrateAdmittedProjection"]>>>();
    for (const edge of input.evidence) {
      const key = `${edge.captureId}:${edge.transformationArtifactId}:${edge.projectionArtifactId}`;
      if (!pairs.has(key)) {
        if (pairs.size >= 8) throw new Error("ADMISSION_PROJECTION_LIMIT");
        pairs.set(
          key,
          await this.hydrateAdmittedProjection({
            tenantId: input.tenantId,
            captureId: edge.captureId,
            expectedSourceArtifact: input.expectedSourceArtifact,
            transformationArtifactId: edge.transformationArtifactId,
            projectionArtifactId: edge.projectionArtifactId,
          }),
        );
      }
    }
    const coreInput = {
      schema: input.schema,
      candidate: input.candidate,
      fields: input.fields,
      evidence: input.evidence.map((edge) => {
        const item = pairs.get(`${edge.captureId}:${edge.transformationArtifactId}:${edge.projectionArtifactId}`)!;
        return {
          path: edge.path,
          captureId: edge.captureId,
          representationArtifactId: item.receipt.projectionArtifact.artifactId,
          representationDigest: item.receipt.projectionArtifact.digest as Digest,
          selector: edge.selector,
          ...(edge.expectedSelectedContentDigest
            ? { expectedSelectedContentDigest: edge.expectedSelectedContentDigest }
            : {}),
        };
      }),
      representations: [...pairs.values()].map((item) => ({
        captureId: item.receipt.captureId,
        artifactId: item.receipt.projectionArtifact.artifactId,
        digest: item.receipt.projectionArtifact.digest as Digest,
        content: item.content,
      })),
      selectorResolvers: [projectionSelectorResolver],
      ...(input.normalizations ? { normalizations: input.normalizations } : {}),
      ...(input.duplicates ? { duplicates: input.duplicates } : {}),
      ...(input.totals ? { totals: input.totals } : {}),
    } satisfies Parameters<typeof verifyExtractionFields>[0];
    return { coreInput, pairs };
  }
}
