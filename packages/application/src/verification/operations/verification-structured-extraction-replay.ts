import { z } from "zod";
import { VerificationArtifactHandleSchema, type VerificationArtifactHandle } from "@aiengineer/knowledge-contracts";
import {
  GatewayStructuredExtractionProvider,
  InterfazeStructuredExtractionProvider,
  ProviderFailure,
  canonicalizeJson,
  providerDigest,
  sha256Digest,
  type ProviderArtifactSink,
  type TrustedArtifactResolver,
} from "@aiengineer/knowledge-verification";
import { deepFreeze } from "@aiengineer/knowledge-core";
import {
  StructuredExtractionProfileAdmission,
  type PreparedStructuredExtraction,
} from "./verification-structured-extraction-profile.js";
import {
  VerificationProviderTransportResponseSchema,
  prepareVerificationProviderTransportResponse,
} from "./verification-provider-transport.js";
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const captureSchema = z.strictObject({
  tenantId: z.uuid(),
  providerAttemptId: z.uuid(),
  operationId: z.uuid(),
  operationStepId: z.uuid(),
  profileArtifactId: z.uuid(),
  profileDigest: digest,
  dispatchFencingToken: z.int().positive(),
  httpStatus: z.int().min(200).max(599),
  responseEnvelopeArtifactId: z.uuid(),
  transportArtifactId: z.uuid(),
  transportDigest: digest,
  capturedAt: z.iso.datetime(),
});
export type StructuredExtractionReplayCapture = z.infer<typeof captureSchema>;
const envelopeSchema = z.strictObject({
  schemaVersion: z.literal("verification-provider-response-envelope.v1"),
  requestDigest: digest,
  requestArtifactId: z.uuid(),
  rawResponseArtifactId: z.uuid(),
  rawResponseDigest: digest,
});
const decoder = new TextDecoder("utf-8", { fatal: true });
const live = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new Error("STRUCTURED_EXTRACTION_REPLAY_CANCELLED");
};
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.byteLength === b.byteLength && a.every((v, i) => v === b[i]);
const canonicalBytes = (v: unknown) => new TextEncoder().encode(canonicalizeJson(v));
export interface StructuredExtractionReplayProvenance {
  readonly capture: StructuredExtractionReplayCapture;
  readonly transportArtifact: VerificationArtifactHandle;
  readonly requestArtifact: VerificationArtifactHandle;
  readonly rawResponseArtifact: VerificationArtifactHandle;
  readonly responseEnvelopeArtifact: VerificationArtifactHandle;
  readonly externalRequests: 0;
  readonly memoryFetches: number;
}
export interface AcceptedStructuredExtractionReplayResult extends StructuredExtractionReplayProvenance {
  readonly kind: "accepted";
  readonly output: unknown;
  readonly usage: unknown;
  readonly precontextBytes: Uint8Array | null;
  readonly outputVerification: "unverified_candidate";
}
export interface FailedStructuredExtractionReplayResult extends StructuredExtractionReplayProvenance {
  readonly kind: "failed";
  readonly code: string;
  readonly precontextBytes: Uint8Array | null;
  readonly automaticRetry: false;
}
export type StructuredExtractionReplayResult =
  | AcceptedStructuredExtractionReplayResult
  | FailedStructuredExtractionReplayResult;

const resultSnapshot = (result: StructuredExtractionReplayResult): string =>
  canonicalizeJson({
    ...result,
    precontextBytes: result.precontextBytes === null ? null : Array.from(result.precontextBytes),
  });
const preparationSnapshot = (preparation: PreparedStructuredExtraction): string => canonicalizeJson(preparation);
async function hydrate(
  resolver: TrustedArtifactResolver,
  tenantId: string,
  expected: { artifactId: string; digest: string },
  limit: number,
  signal?: AbortSignal,
  full?: VerificationArtifactHandle,
) {
  live(signal);
  if (full && (full.tenantId !== tenantId || full.byteLength > limit))
    throw new Error("STRUCTURED_EXTRACTION_REPLAY_ARTIFACT");
  await resolver.authorizeArtifact({ tenantId, artifactId: expected.artifactId, purpose: "verification_admission" });
  live(signal);
  const loaded = await resolver.hydrateRegisteredArtifact({ tenantId, artifactId: expected.artifactId });
  live(signal);
  const registration = VerificationArtifactHandleSchema.parse(loaded.registration);
  if (
    registration.tenantId !== tenantId ||
    registration.artifactId !== expected.artifactId ||
    registration.digest !== expected.digest ||
    loaded.bytes.byteLength > limit ||
    loaded.bytes.byteLength !== registration.byteLength ||
    sha256Digest(loaded.bytes) !== expected.digest ||
    (full && canonicalizeJson(full) !== canonicalizeJson(registration))
  )
    throw new Error("STRUCTURED_EXTRACTION_REPLAY_ARTIFACT");
  return { registration, bytes: new Uint8Array(loaded.bytes) };
}
/** Fresh custody hydration and actual adapter replay; no network/key/write port. */
export class StructuredExtractionCapturedReplayService {
  readonly #results = new WeakMap<
    object,
    {
      readonly preparation: PreparedStructuredExtraction;
      readonly preparationSnapshot: string;
      readonly snapshot: string;
      readonly precontextBytes: Uint8Array | null;
    }
  >();
  constructor(
    private readonly admission: StructuredExtractionProfileAdmission,
    private readonly createResolver: () => TrustedArtifactResolver,
  ) {}
  async replay(input: {
    readonly tenantId: string;
    readonly request: unknown;
    readonly preparation: PreparedStructuredExtraction;
    readonly capture: StructuredExtractionReplayCapture;
    readonly signal?: AbortSignal;
  }): Promise<StructuredExtractionReplayResult> {
    live(input.signal);
    this.admission.assertPrepared({ tenantId: input.tenantId, request: input.request, preparation: input.preparation });
    const p = input.preparation,
      c = deepFreeze(captureSchema.parse(input.capture));
    if (
      c.tenantId !== input.tenantId ||
      c.profileArtifactId !== p.artifacts.producerProfile.artifactId ||
      c.profileDigest !== p.artifacts.producerProfile.digest
    )
      throw new Error("STRUCTURED_EXTRACTION_REPLAY_CAPTURE_BINDING");
    const resolver = this.createResolver(),
      retained = await hydrate(
        resolver,
        c.tenantId,
        { artifactId: c.transportArtifactId, digest: c.transportDigest },
        32_000,
        input.signal,
      );
    const transport = VerificationProviderTransportResponseSchema.parse(JSON.parse(decoder.decode(retained.bytes))),
      prepared = prepareVerificationProviderTransportResponse(transport),
      b = transport.binding;
    if (
      !sameBytes(retained.bytes, prepared.bytes) ||
      retained.registration.transformationSignature !== prepared.transformationSignature ||
      canonicalizeJson(retained.registration.parentArtifactIds) !== canonicalizeJson(prepared.parentArtifactIds) ||
      b.tenantId !== c.tenantId ||
      b.providerAttemptId !== c.providerAttemptId ||
      b.operationId !== c.operationId ||
      b.operationStepId !== c.operationStepId ||
      b.profileArtifactId !== c.profileArtifactId ||
      b.profileDigest !== c.profileDigest ||
      b.dispatchFencingToken !== c.dispatchFencingToken ||
      transport.httpStatus !== c.httpStatus ||
      transport.responseEnvelope.artifactId !== c.responseEnvelopeArtifactId
    )
      throw new Error("STRUCTURED_EXTRACTION_REPLAY_TRANSPORT_BINDING");
    const envelopeArtifact = await hydrate(
        resolver,
        c.tenantId,
        transport.responseEnvelope,
        32_000,
        input.signal,
        transport.responseEnvelope,
      ),
      envelope = envelopeSchema.parse(JSON.parse(decoder.decode(envelopeArtifact.bytes)));
    if (
      !sameBytes(envelopeArtifact.bytes, canonicalBytes(envelope)) ||
      envelope.requestDigest !== transport.requestDigest ||
      envelope.rawResponseArtifactId !== transport.rawResponse.artifactId ||
      envelope.rawResponseDigest !== transport.rawResponse.digest ||
      canonicalizeJson(envelopeArtifact.registration.parentArtifactIds) !==
        canonicalizeJson([envelope.requestArtifactId, envelope.rawResponseArtifactId]) ||
      envelopeArtifact.registration.transformationSignature !==
        providerDigest({
          kind: "verification_provider_response_envelope.v1",
          requestDigest: envelope.requestDigest,
          rawResponseDigest: envelope.rawResponseDigest,
        })
    )
      throw new Error("STRUCTURED_EXTRACTION_REPLAY_ENVELOPE_BINDING");
    const request = await hydrate(
      resolver,
      c.tenantId,
      { artifactId: envelope.requestArtifactId, digest: envelope.requestDigest },
      160_000,
      input.signal,
    );
    if (
      providerDigest(JSON.parse(decoder.decode(request.bytes))) !== transport.requestDigest ||
      !request.registration.parentArtifactIds.length ||
      request.registration.transformationSignature !==
        providerDigest({ kind: "verification_provider_request.v1", requestDigest: transport.requestDigest })
    )
      throw new Error("STRUCTURED_EXTRACTION_REPLAY_REQUEST_BINDING");
    const raw = await hydrate(
        resolver,
        c.tenantId,
        transport.rawResponse,
        160_000,
        input.signal,
        transport.rawResponse,
      ),
      noBody = [204, 205, 304].includes(c.httpStatus);
    if (noBody && raw.bytes.byteLength) throw new Error("STRUCTURED_EXTRACTION_REPLAY_STATUS_BODY_INVALID");
    const gateway = p.provider.providerId === "gateway-structured-extraction.v1";
    if (!gateway && p.provider.providerId !== "interfaze-extraction.v1")
      throw new Error("STRUCTURED_EXTRACTION_REPLAY_PROVIDER_UNSUPPORTED");
    let memoryFetches = 0,
      requestSeen = false;
    const state: { custodyFailure?: Error; precontextBytes: Uint8Array | null } = { precontextBytes: null };
    const fail = (code: string): never => {
      state.custodyFailure = new Error(code);
      throw state.custodyFailure;
    };
    const artifactSink: ProviderArtifactSink = {
      async assertExternalProcessingAdmission(v) {
        live(input.signal);
        if (v.providerId !== (gateway ? "gateway" : "interfaze") || v.modality !== "text")
          fail("STRUCTURED_EXTRACTION_REPLAY_PROVIDER_DRIFT");
      },
      async persistBeforeDispatch(v) {
        live(input.signal);
        if (requestSeen || v.requestDigest !== transport.requestDigest || !sameBytes(v.requestBytes, request.bytes))
          fail("STRUCTURED_EXTRACTION_REPLAY_WIRE_DRIFT");
        requestSeen = true;
      },
      async persistAfterResponse(v) {
        live(input.signal);
        if (
          v.requestDigest !== transport.requestDigest ||
          v.httpStatus !== c.httpStatus ||
          !sameBytes(v.rawResponseBytes, raw.bytes)
        )
          fail("STRUCTURED_EXTRACTION_REPLAY_RESPONSE_DRIFT");
        if (v.precontextBytes) state.precontextBytes = new Uint8Array(v.precontextBytes);
      },
    };
    const memoryFetch: typeof fetch = async () => {
      live(input.signal);
      if (!requestSeen || ++memoryFetches !== 1) fail("STRUCTURED_EXTRACTION_REPLAY_FETCH_REUSED");
      return new Response(noBody ? null : new Uint8Array(raw.bytes), { status: c.httpStatus });
    };
    const options = { apiKey: "offline-replay-only", artifactSink, fetch: memoryFetch },
      args = {
        prompt: p.prompt,
        schemaName: "structured_extraction",
        schema: p.schema.canonicalSchema,
        execution: { deadlineEpochMs: Date.now() + 10_000, ...(input.signal ? { signal: input.signal } : {}) },
      };
    const provenance = () => ({
      capture: c,
      transportArtifact: retained.registration,
      requestArtifact: request.registration,
      rawResponseArtifact: raw.registration,
      responseEnvelopeArtifact: envelopeArtifact.registration,
      externalRequests: 0 as const,
      memoryFetches,
    });
    try {
      const result = gateway
        ? await new GatewayStructuredExtractionProvider(options).extract(args)
        : await new InterfazeStructuredExtractionProvider(options).extract(args);
      live(input.signal);
      if (!requestSeen || memoryFetches !== 1) fail("STRUCTURED_EXTRACTION_REPLAY_WIRE_DRIFT");
      const issued: AcceptedStructuredExtractionReplayResult = {
        kind: "accepted",
        output: deepFreeze(structuredClone(result.output)),
        usage: deepFreeze(structuredClone("usage" in result ? result.usage : result.call.usage)),
        precontextBytes: state.precontextBytes?.slice() ?? null,
        outputVerification: "unverified_candidate",
        ...provenance(),
      };
      this.#brand(issued, p);
      return issued;
    } catch (error) {
      live(input.signal);
      if (state.custodyFailure) throw state.custodyFailure;
      if (
        !(error instanceof ProviderFailure) ||
        !requestSeen ||
        memoryFetches !== 1 ||
        ![
          "PROVIDER_HTTP_FAILURE",
          "PROVIDER_RESPONSE_TOO_LARGE",
          "PROVIDER_RESPONSE_INVALID",
          "PROVIDER_RESPONSE_SCHEMA_INVALID",
        ].includes(error.code)
      )
        throw error;
      const issued: FailedStructuredExtractionReplayResult = {
        kind: "failed",
        code: error.code,
        precontextBytes: state.precontextBytes?.slice() ?? null,
        automaticRetry: false,
        ...provenance(),
      };
      this.#brand(issued, p);
      return issued;
    }
  }

  /** Accepts only this service instance's unchanged result for its original preparation and durable operation scope. */
  assertReplayResult(input: {
    readonly tenantId: string;
    readonly operationId: string;
    readonly providerAttemptId: string;
    readonly preparation: PreparedStructuredExtraction;
    readonly result: StructuredExtractionReplayResult;
  }): void {
    const brand = this.#results.get(input.result);
    if (
      !brand ||
      brand.preparation !== input.preparation ||
      brand.preparationSnapshot !== preparationSnapshot(input.preparation) ||
      brand.snapshot !== resultSnapshot(input.result) ||
      !sameBytes(brand.precontextBytes ?? new Uint8Array(), input.result.precontextBytes ?? new Uint8Array()) ||
      input.result.capture.tenantId !== input.tenantId ||
      input.result.capture.operationId !== input.operationId ||
      input.result.capture.providerAttemptId !== input.providerAttemptId ||
      input.preparation.tenantId !== input.tenantId ||
      input.result.capture.profileArtifactId !== input.preparation.artifacts.producerProfile.artifactId ||
      input.result.capture.profileDigest !== input.preparation.artifacts.producerProfile.digest
    )
      throw new Error("STRUCTURED_EXTRACTION_REPLAY_RESULT_UNTRUSTED");
  }

  #brand(result: StructuredExtractionReplayResult, preparation: PreparedStructuredExtraction): void {
    this.#results.set(
      result,
      Object.freeze({
        preparation,
        preparationSnapshot: preparationSnapshot(preparation),
        snapshot: resultSnapshot(result),
        precontextBytes: result.precontextBytes?.slice() ?? null,
      }),
    );
  }
}
