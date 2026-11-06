import { z } from "zod";
import {
  ExtractStructuredDataRequestSchema,
  VerificationArtifactHandleSchema,
  type VerificationArtifactHandle,
} from "@aiengineer/knowledge-contracts";
import {
  admitExtractionSchema,
  canonicalizeJson,
  digestCanonicalJson,
  projectionSelectorResolver,
  registeredProvider,
  sha256Digest,
  type AdmittedExtractionSchema,
  type TrustedArtifactResolver,
} from "@aiengineer/knowledge-verification";
import { VerificationExtractionProfileSchema, type VerificationExtractionProfile } from "./verification-service.js";
import type { ProjectionAdmissionReceipt } from "../admission/verification-admission.js";

type Digest = `sha256:${string}`;
type ArtifactReference = { readonly artifactId: string; readonly digest: string };
const PROFILE_BYTES = 128_000,
  SCHEMA_PROFILE_BYTES = 128_000,
  MAX_PROMPT_BYTES = 24_000;
const artifact = VerificationArtifactHandleSchema;

export const VerificationStructuredExtractionProducerProfileSchema = z.strictObject({
  schemaVersion: z.literal("verification-structured-extraction-profile.v1"),
  tenantId: z.uuid(),
  profileId: z.literal("registered_default"),
  profileVersion: z.string().min(1).max(120),
  extractionSchema: artifact,
  providerId: z.enum(["gateway-structured-extraction.v1", "interfaze-extraction.v1"]),
  providerConfigurationDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  externalProcessing: z.strictObject({ classification: z.enum(["synthetic", "public"]), modality: z.literal("text") }),
  budget: z
    .strictObject({
      budgetId: z.uuid(),
      budgetKey: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,119}$/u),
      ceilingCostMicros: z.int().positive().max(20_000_000),
      reservationCostMicros: z.int().positive().max(20_000_000),
    })
    .refine((value) => value.reservationCostMicros <= value.ceilingCostMicros, "reservation must not exceed ceiling"),
  maximumPromptBytes: z.int().positive().max(MAX_PROMPT_BYTES),
});
export type VerificationStructuredExtractionProducerProfile = z.infer<
  typeof VerificationStructuredExtractionProducerProfileSchema
>;

/** Server-owned grant; clients never supply or select this mapping. */
export const StructuredExtractionRuntimeGrantSchema = z.strictObject({
  tenantId: z.uuid(),
  captureId: z.string().min(1).max(255),
  sourceArtifact: artifact,
  representation: artifact,
  transformation: artifact,
  extractionSchema: artifact,
  producerProfile: artifact,
});
export type StructuredExtractionRuntimeGrant = z.infer<typeof StructuredExtractionRuntimeGrantSchema>;

export interface StructuredExtractionProjectionAdmissionPort {
  hydrateAdmittedProjection(input: {
    readonly tenantId: string;
    readonly captureId: string;
    readonly expectedSourceArtifact: ArtifactReference;
    readonly transformationArtifactId: string;
    readonly projectionArtifactId: string;
  }): Promise<{ readonly receipt: ProjectionAdmissionReceipt; readonly content: Uint8Array }>;
}

export interface PreparedStructuredExtraction {
  readonly tenantId: string;
  readonly captureId: string;
  readonly producerProfile: VerificationStructuredExtractionProducerProfile;
  readonly provider: {
    readonly providerId: string;
    readonly model: string;
    readonly configurationDigest: Digest;
    readonly promotionState: string;
  };
  readonly extractionProfile: VerificationExtractionProfile;
  readonly schema: AdmittedExtractionSchema;
  readonly representation: VerificationArtifactHandle;
  readonly prompt: string;
  readonly promptDigest: Digest;
  readonly artifacts: {
    readonly producerProfile: VerificationArtifactHandle;
    readonly extractionSchema: VerificationArtifactHandle;
    readonly source: VerificationArtifactHandle;
    readonly transformation: VerificationArtifactHandle;
  };
  readonly selectedEvidence: readonly { readonly path: string; readonly selectedContentDigest: Digest }[];
}

const encoder = new TextEncoder(),
  decoder = new TextDecoder("utf-8", { fatal: true });
const active = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw new Error("STRUCTURED_EXTRACTION_PROFILE_CANCELLED");
};
const same = (expected: ArtifactReference, actual: VerificationArtifactHandle): boolean =>
  expected.artifactId === actual.artifactId && expected.digest === actual.digest;
const sameHandle = (expected: VerificationArtifactHandle, actual: VerificationArtifactHandle): boolean =>
  canonicalizeJson(expected) === canonicalizeJson(actual);
const digest = (value: string): Digest => {
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) throw new Error("STRUCTURED_EXTRACTION_DIGEST_INVALID");
  return value as Digest;
};

function freeze<T>(value: T): T {
  const copy = structuredClone(value);
  const visit = (item: unknown): void => {
    if (item && typeof item === "object" && !Object.isFrozen(item)) {
      for (const child of Object.values(item as Record<string, unknown>)) visit(child);
      Object.freeze(item);
    }
  };
  visit(copy);
  return copy;
}

async function hydrate(
  resolver: TrustedArtifactResolver,
  tenantId: string,
  expected: VerificationArtifactHandle,
  limit: number,
  code: string,
): Promise<{ readonly registration: VerificationArtifactHandle; readonly bytes: Uint8Array }> {
  if (expected.tenantId !== tenantId || expected.byteLength > limit) throw new Error(code);
  await resolver.authorizeArtifact({ tenantId, artifactId: expected.artifactId, purpose: "verification_admission" });
  const result = await resolver.hydrateRegisteredArtifact({ tenantId, artifactId: expected.artifactId });
  const registration = VerificationArtifactHandleSchema.parse(result.registration);
  if (
    !sameHandle(expected, registration) ||
    registration.tenantId !== tenantId ||
    registration.byteLength !== result.bytes.byteLength ||
    result.bytes.byteLength > limit ||
    sha256Digest(result.bytes) !== expected.digest
  )
    throw new Error(code);
  return { registration, bytes: new Uint8Array(result.bytes) };
}

function requireCoverage(profile: VerificationExtractionProfile, schema: AdmittedExtractionSchema): void {
  const fields = new Set(profile.fields.map((item) => item.path));
  const evidence = new Set(profile.evidence.map((item) => item.path));
  if (
    fields.size !== profile.fields.length ||
    evidence.size !== profile.evidence.length ||
    fields.size !== evidence.size ||
    [...fields].some((path) => !evidence.has(path))
  )
    throw new Error("STRUCTURED_EXTRACTION_PROFILE_EVIDENCE_COVERAGE_REQUIRED");
  // This producer profile supports fixed object fields. Dynamic array element
  // evidence requires a separate mapping contract before it can be dispatched.
  const leaves = new Set<string>();
  const visit = (value: unknown, path: string): void => {
    const node = value as Record<string, unknown>;
    if (node.type === "array") throw new Error("STRUCTURED_EXTRACTION_ARRAY_EVIDENCE_UNSUPPORTED");
    if (node.type === "object") {
      if (node.additionalProperties !== false) throw new Error("STRUCTURED_EXTRACTION_OPEN_OBJECT_UNSUPPORTED");
      for (const [key, child] of Object.entries(node.properties as Record<string, unknown>))
        visit(child, `${path}/${key.replace(/~/gu, "~0").replace(/\//gu, "~1")}`);
    } else leaves.add(path);
  };
  visit(schema.canonicalSchema, "");
  if (leaves.size !== fields.size || [...leaves].some((path) => !fields.has(path)))
    throw new Error("STRUCTURED_EXTRACTION_PROFILE_SCHEMA_COVERAGE_REQUIRED");
}

/** Prepares only selected evidence. This type owns neither dispatch nor persistence. */
export class StructuredExtractionProfileAdmission {
  readonly #grants = new Map<string, StructuredExtractionRuntimeGrant>();
  readonly #brands = new WeakMap<object, { readonly tenantId: string; readonly requestDigest: Digest }>();
  constructor(
    grants: readonly StructuredExtractionRuntimeGrant[],
    private readonly createResolver: () => TrustedArtifactResolver,
    private readonly admission: StructuredExtractionProjectionAdmissionPort,
  ) {
    if (!Array.isArray(grants) || grants.length > 256) throw new Error("STRUCTURED_EXTRACTION_RUNTIME_GRANT_LIMIT");
    for (const value of grants) {
      const grant = freeze(StructuredExtractionRuntimeGrantSchema.parse(value));
      if (
        [
          grant.sourceArtifact,
          grant.representation,
          grant.transformation,
          grant.extractionSchema,
          grant.producerProfile,
        ].some((handle) => handle.tenantId !== grant.tenantId)
      )
        throw new Error("STRUCTURED_EXTRACTION_RUNTIME_GRANT_TENANT_MISMATCH");
      const key = this.#key(grant.tenantId, grant.captureId, grant.representation, grant.extractionSchema);
      if (this.#grants.has(key)) throw new Error("DUPLICATE_STRUCTURED_EXTRACTION_RUNTIME_GRANT");
      this.#grants.set(key, grant);
    }
  }

  async prepare(input: {
    readonly tenantId: string;
    readonly request: unknown;
    readonly signal?: AbortSignal;
  }): Promise<PreparedStructuredExtraction> {
    active(input.signal);
    const request = ExtractStructuredDataRequestSchema.parse(input.request);
    const grant = this.#grants.get(
      this.#key(input.tenantId, request.captureId, request.representation, request.extractionSchema),
    );
    if (!grant || request.extractionProfile !== "registered_default")
      throw new Error("STRUCTURED_EXTRACTION_RUNTIME_GRANT_REQUIRED");
    // A trusted resolver may carry one authorization ticket. Complete each
    // authorize/hydrate pair before requesting the next artifact.
    const resolver = this.createResolver();
    const producerArtifact = await hydrate(
      resolver,
      input.tenantId,
      grant.producerProfile,
      PROFILE_BYTES,
      "STRUCTURED_EXTRACTION_PRODUCER_PROFILE_BINDING_INVALID",
    );
    active(input.signal);
    const schemaArtifact = await hydrate(
      resolver,
      input.tenantId,
      grant.extractionSchema,
      SCHEMA_PROFILE_BYTES,
      "STRUCTURED_EXTRACTION_SCHEMA_PROFILE_BINDING_INVALID",
    );
    active(input.signal);
    const producer = freeze(
      VerificationStructuredExtractionProducerProfileSchema.parse(JSON.parse(decoder.decode(producerArtifact.bytes))),
    );
    const extractionProfile = freeze(
      VerificationExtractionProfileSchema.parse(JSON.parse(decoder.decode(schemaArtifact.bytes))),
    );
    if (producer.tenantId !== input.tenantId || !sameHandle(producer.extractionSchema, schemaArtifact.registration))
      throw new Error("STRUCTURED_EXTRACTION_PRODUCER_PROFILE_BINDING_INVALID");
    const provider = registeredProvider(producer.providerId);
    if (
      !provider.capabilities.includes("structured_extraction") ||
      !provider.modalities.includes("text") ||
      provider.configurationDigest !== producer.providerConfigurationDigest ||
      provider.promotionState === "suspended" ||
      provider.promotionState === "retired"
    )
      throw new Error("STRUCTURED_EXTRACTION_PROVIDER_PROFILE_INVALID");
    const admitted = admitExtractionSchema(extractionProfile.extractionSchema);
    if (!admitted.admitted || !admitted.schema) throw new Error("STRUCTURED_EXTRACTION_SCHEMA_NOT_ADMITTED");
    requireCoverage(extractionProfile, admitted.schema);
    const hydrated = await this.admission.hydrateAdmittedProjection({
      tenantId: input.tenantId,
      captureId: request.captureId,
      expectedSourceArtifact: grant.sourceArtifact,
      transformationArtifactId: grant.transformation.artifactId,
      projectionArtifactId: request.representation.artifactId,
    });
    active(input.signal);
    if (
      hydrated.receipt.captureId !== request.captureId ||
      !same(request.representation, hydrated.receipt.projectionArtifact) ||
      !sameHandle(grant.representation, hydrated.receipt.projectionArtifact) ||
      !sameHandle(grant.transformation, hydrated.receipt.transformationArtifact) ||
      !sameHandle(grant.sourceArtifact, hydrated.receipt.sourceArtifact) ||
      hydrated.content.byteLength !== grant.representation.byteLength ||
      sha256Digest(hydrated.content) !== grant.representation.digest ||
      extractionProfile.sourceArtifact.artifactId !== grant.sourceArtifact.artifactId ||
      extractionProfile.sourceArtifact.digest !== grant.sourceArtifact.digest
    )
      throw new Error("STRUCTURED_EXTRACTION_PROJECTION_BINDING_INVALID");
    const selected = extractionProfile.evidence.map((edge) => {
      if (
        edge.captureId !== request.captureId ||
        edge.projectionArtifactId !== request.representation.artifactId ||
        edge.transformationArtifactId !== grant.transformation.artifactId
      )
        throw new Error("STRUCTURED_EXTRACTION_EVIDENCE_BINDING_INVALID");
      const resolved = projectionSelectorResolver.resolve({
        captureId: request.captureId,
        representationArtifactId: hydrated.receipt.projectionArtifact.artifactId,
        representationDigest: hydrated.receipt.projectionArtifact.digest,
        selector: edge.selector,
        content: hydrated.content,
      });
      if (
        resolved.resolution.status !== "resolved" ||
        resolved.resolution.occurrenceCount !== 1 ||
        !resolved.resolution.selectedContentDigest ||
        (edge.expectedSelectedContentDigest !== undefined &&
          edge.expectedSelectedContentDigest !== resolved.resolution.selectedContentDigest)
      )
        throw new Error("STRUCTURED_EXTRACTION_EVIDENCE_UNRESOLVED");
      return {
        path: edge.path,
        selectedContent: decoder.decode(resolved.selectedContent),
        selectedContentDigest: resolved.resolution.selectedContentDigest as Digest,
      };
    });
    const prompt = canonicalizeJson({
      schema: admitted.schema.canonicalSchema,
      evidence: selected.map(({ path, selectedContent }) => ({ path, selectedContent })),
    });
    if (encoder.encode(prompt).byteLength === 0 || encoder.encode(prompt).byteLength > producer.maximumPromptBytes)
      throw new Error("STRUCTURED_EXTRACTION_PROMPT_LIMIT");
    const result: PreparedStructuredExtraction = Object.freeze({
      tenantId: input.tenantId,
      captureId: request.captureId,
      producerProfile: producer,
      provider: Object.freeze({
        providerId: provider.providerId,
        model: provider.model,
        configurationDigest: digest(provider.configurationDigest),
        promotionState: provider.promotionState,
      }),
      extractionProfile,
      schema: admitted.schema,
      representation: freeze(hydrated.receipt.projectionArtifact),
      artifacts: freeze({
        producerProfile: producerArtifact.registration,
        extractionSchema: schemaArtifact.registration,
        source: hydrated.receipt.sourceArtifact,
        transformation: hydrated.receipt.transformationArtifact,
      }),
      prompt,
      promptDigest: sha256Digest(prompt),
      selectedEvidence: Object.freeze(
        selected.map(({ path, selectedContentDigest }) => Object.freeze({ path, selectedContentDigest })),
      ),
    });
    this.#brands.set(result, Object.freeze({ tenantId: input.tenantId, requestDigest: digestCanonicalJson(request) }));
    return result;
  }

  assertPrepared(input: {
    readonly tenantId: string;
    readonly request: unknown;
    readonly preparation: PreparedStructuredExtraction;
  }): void {
    const request = ExtractStructuredDataRequestSchema.parse(input.request),
      brand = this.#brands.get(input.preparation);
    if (!brand || brand.tenantId !== input.tenantId || brand.requestDigest !== digestCanonicalJson(request))
      throw new Error("STRUCTURED_EXTRACTION_PREPARATION_UNTRUSTED");
  }

  #key(
    tenantId: string,
    captureId: string,
    representation: ArtifactReference,
    extractionSchema: ArtifactReference,
  ): string {
    return `${tenantId}:${captureId}:${representation.artifactId}:${representation.digest}:${extractionSchema.artifactId}:${extractionSchema.digest}`;
  }
}
