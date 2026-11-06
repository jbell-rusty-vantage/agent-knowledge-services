import type { VerificationArtifactHandle } from "@aiengineer/knowledge-contracts";
import {
  canonicalizeJson,
  providerDigest,
  sha256Digest,
  type ProviderArtifactSink,
} from "@aiengineer/knowledge-verification";
import { randomUUID } from "node:crypto";
import {
  prepareVerificationProviderTransportResponse,
  VerificationProviderTransportBindingSchema,
  type VerificationProviderTransportBinding,
  type VerificationProviderTransportResponse,
} from "./verification-provider-transport.js";

export interface VerificationProviderArtifactRegistrationPort {
  registerContentAddressedArtifact(input: {
    readonly tenantId: string;
    readonly bytes: Uint8Array;
    readonly mediaType: string;
    readonly createdAt: string;
    readonly producerActivityId: string;
    readonly producerVersion: string;
    readonly encryptionClass: string;
    readonly retentionClass: string;
    readonly dataClassification: "restricted";
    readonly parentArtifactIds?: readonly string[];
    readonly transformationSignature?: `sha256:${string}`;
    readonly artifactType:
      | "verification_provider_input"
      | "verification_provider_request"
      | "verification_provider_raw_response"
      | "verification_provider_response_envelope"
      | "verification_provider_precontext"
      | "verification_provider_precontext_envelope"
      | "verification_provider_transport_response";
    readonly bucketClass: "candidate" | "ledger";
    readonly storageBucket: string;
    readonly producerAttemptId?: string;
    readonly missionId?: string;
  }): Promise<VerificationArtifactHandle>;
}

/**
 * Trusted runtime configuration for bytes that may leave KS.  Callers never
 * supply this from a provider request: it is selected by the server-owned
 * runtime/profile grant. Sensitive material is deliberately not representable
 * here; admitting it needs a separate authorization design.
 */
export interface ProviderExternalProcessingGrant {
  readonly providerId: "gateway" | "interfaze";
  readonly dataClassification: "synthetic" | "public";
  readonly modalities: readonly ("text" | "image" | "audio")[];
  /** Required explicitly for Interfaze; the adapter sends the fixed ZDR header. */
  readonly zdrPolicy?: "required";
}

/** Application composition for provider bytes. It never returns raw provider data. */
export class VerificationProviderArtifactComposer {
  readonly #transportResponses = new Map<string, VerificationArtifactHandle>();
  readonly #transportObservations = new Map<string, { readonly httpStatus: number; readonly rawDigest: string }>();
  readonly #transportBinding?: VerificationProviderTransportBinding;
  readonly #parents: VerificationArtifactHandle[] = [];
  readonly #requests = new Map<string, VerificationArtifactHandle>();
  readonly #rawResponses = new Map<string, VerificationArtifactHandle>();
  readonly #responseEnvelopes = new Map<string, VerificationArtifactHandle>();
  readonly #precontexts = new Map<string, VerificationArtifactHandle>();
  readonly #precontextEnvelopes = new Map<string, VerificationArtifactHandle>();
  constructor(
    private readonly repository: VerificationProviderArtifactRegistrationPort,
    private readonly config: {
      readonly tenantId: string;
      readonly storageBucket: string;
      readonly producerActivityId: string;
      readonly producerVersion: string;
      readonly encryptionClass: string;
      readonly retentionClass: string;
      readonly now: () => string;
      readonly producerAttemptId?: string;
      readonly missionId?: string;
      readonly externalProcessingGrant: ProviderExternalProcessingGrant;
      readonly transportResponse?: {
        readonly binding: VerificationProviderTransportBinding;
        readonly record: (input: {
          readonly response: VerificationProviderTransportResponse;
          readonly artifact: VerificationArtifactHandle;
        }) => Promise<void>;
      };
    },
  ) {
    const grant = config.externalProcessingGrant;
    if (
      (grant.dataClassification !== "synthetic" && grant.dataClassification !== "public") ||
      !grant.modalities.length ||
      grant.modalities.some((item) => item !== "text" && item !== "image" && item !== "audio")
    )
      throw new Error("PROVIDER_EXTERNAL_PROCESSING_GRANT_INVALID");
    if (grant.providerId === "interfaze" && grant.zdrPolicy !== "required")
      throw new Error("INTERFAZE_ZDR_POLICY_REQUIRED");
    if (grant.providerId !== "interfaze" && grant.zdrPolicy !== undefined)
      throw new Error("PROVIDER_ZDR_POLICY_UNSUPPORTED");
    if (config.transportResponse) {
      this.#transportBinding = Object.freeze(
        VerificationProviderTransportBindingSchema.parse(config.transportResponse.binding),
      );
      if (this.#transportBinding.tenantId !== config.tenantId) throw new Error("PROVIDER_TRANSPORT_TENANT_MISMATCH");
    }
  }
  async registerInput(bytes: Uint8Array, mediaType: string): Promise<VerificationArtifactHandle> {
    if (!bytes.byteLength || bytes.byteLength > 160_000 || !mediaType || mediaType.length > 160)
      throw new Error("PROVIDER_INPUT_ARTIFACT_INVALID");
    const artifact = await this.repository.registerContentAddressedArtifact({
      ...this.#common(),
      bytes,
      mediaType,
      artifactType: "verification_provider_input",
      bucketClass: "candidate",
    });
    this.#parents.push(artifact);
    return artifact;
  }
  async assertRegisteredInputAdmission(input: {
    readonly providerId: string;
    readonly modality: "text" | "image" | "audio";
  }): Promise<void> {
    const grant = this.config.externalProcessingGrant;
    if (
      this.#parents.length === 0 ||
      input.providerId !== grant.providerId ||
      !grant.modalities.includes(input.modality)
    )
      throw new Error("PROVIDER_EXTERNAL_PROCESSING_NOT_ADMITTED");
  }
  async persistBeforeDispatch(input: {
    readonly requestDigest: `sha256:${string}`;
    readonly requestBytes: Uint8Array;
  }): Promise<void> {
    if (
      providerDigest(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.requestBytes))) !==
        input.requestDigest ||
      this.#parents.length === 0
    )
      throw new Error("PROVIDER_REQUEST_ARTIFACT_BINDING_INVALID");
    const artifact = await this.repository.registerContentAddressedArtifact({
      ...this.#common(),
      bytes: input.requestBytes,
      mediaType: "application/json",
      parentArtifactIds: this.#parents.map((item) => item.artifactId),
      transformationSignature: providerDigest({
        kind: "verification_provider_request.v1",
        requestDigest: input.requestDigest,
      }),
      artifactType: "verification_provider_request",
      bucketClass: "ledger",
    });
    this.#requests.set(input.requestDigest, artifact);
  }
  async persistAfterResponse(input: {
    readonly requestDigest: `sha256:${string}`;
    readonly rawResponseBytes: Uint8Array;
    readonly precontextBytes?: Uint8Array;
    readonly httpStatus?: number;
  }): Promise<void> {
    if (
      this.#transportBinding &&
      (!Number.isInteger(input.httpStatus) || input.httpStatus! < 200 || input.httpStatus! > 599)
    )
      throw new Error("PROVIDER_TRANSPORT_HTTP_STATUS_REQUIRED");
    const observation = this.#transportObservations.get(input.requestDigest);
    if (
      observation &&
      (observation.httpStatus !== input.httpStatus || observation.rawDigest !== sha256Digest(input.rawResponseBytes))
    )
      throw new Error("PROVIDER_TRANSPORT_RESPONSE_DRIFT");
    const request = this.#requests.get(input.requestDigest);
    if (!request) throw new Error("PROVIDER_RESPONSE_WITHOUT_REQUEST_ARTIFACT");
    // The exact raw body is content-addressed independently of any request. A
    // request-bound envelope supplies the immutable lineage when error bodies repeat.
    const raw = await this.repository.registerContentAddressedArtifact({
      ...this.#common(),
      bytes: input.rawResponseBytes,
      mediaType: "application/octet-stream",
      artifactType: "verification_provider_raw_response",
      bucketClass: "ledger",
    });
    const envelopeBytes = new TextEncoder().encode(
      canonicalizeJson({
        schemaVersion: "verification-provider-response-envelope.v1",
        requestDigest: input.requestDigest,
        requestArtifactId: request.artifactId,
        rawResponseArtifactId: raw.artifactId,
        rawResponseDigest: raw.digest,
      }),
    );
    const envelope = await this.repository.registerContentAddressedArtifact({
      ...this.#common(),
      bytes: envelopeBytes,
      mediaType: "application/vnd.aiengineer.verification-provider-response-envelope+json",
      parentArtifactIds: [request.artifactId, raw.artifactId],
      transformationSignature: providerDigest({
        kind: "verification_provider_response_envelope.v1",
        requestDigest: input.requestDigest,
        rawResponseDigest: raw.digest,
      }),
      artifactType: "verification_provider_response_envelope",
      bucketClass: "ledger",
    });
    this.#rawResponses.set(input.requestDigest, raw);
    this.#responseEnvelopes.set(input.requestDigest, envelope);
    if (this.#transportBinding) {
      const prepared = prepareVerificationProviderTransportResponse({
        binding: this.#transportBinding,
        httpStatus: input.httpStatus!,
        requestDigest: input.requestDigest,
        responseEnvelope: envelope,
        rawResponse: raw,
      });
      const previous = this.#transportResponses.get(input.requestDigest);
      if (previous && previous.digest !== prepared.payloadDigest) throw new Error("PROVIDER_TRANSPORT_RESPONSE_DRIFT");
      const artifact = await this.repository.registerContentAddressedArtifact({
        ...this.#common(),
        bytes: prepared.bytes,
        mediaType: "application/vnd.aiengineer.verification-provider-transport-response+json",
        parentArtifactIds: prepared.parentArtifactIds,
        transformationSignature: prepared.transformationSignature,
        artifactType: "verification_provider_transport_response",
        bucketClass: "ledger",
      });
      if (artifact.digest !== prepared.payloadDigest) throw new Error("PROVIDER_TRANSPORT_REGISTERED_DIGEST_MISMATCH");
      await this.config.transportResponse!.record({ response: prepared.response, artifact });
      this.#transportResponses.set(input.requestDigest, artifact);
      this.#transportObservations.set(input.requestDigest, { httpStatus: input.httpStatus!, rawDigest: raw.digest });
    }
    if (!input.precontextBytes) return;
    const precontext = await this.repository.registerContentAddressedArtifact({
      ...this.#common(),
      bytes: input.precontextBytes,
      mediaType: "application/json",
      artifactType: "verification_provider_precontext",
      bucketClass: "ledger",
    });
    const precontextEnvelopeBytes = new TextEncoder().encode(
      canonicalizeJson({
        schemaVersion: "verification-provider-precontext-envelope.v1",
        requestDigest: input.requestDigest,
        responseEnvelopeArtifactId: envelope.artifactId,
        precontextArtifactId: precontext.artifactId,
        precontextDigest: precontext.digest,
      }),
    );
    const precontextEnvelope = await this.repository.registerContentAddressedArtifact({
      ...this.#common(),
      bytes: precontextEnvelopeBytes,
      mediaType: "application/vnd.aiengineer.verification-provider-precontext-envelope+json",
      parentArtifactIds: [envelope.artifactId, precontext.artifactId],
      transformationSignature: providerDigest({
        kind: "verification_provider_precontext_envelope.v1",
        requestDigest: input.requestDigest,
        precontextDigest: precontext.digest,
      }),
      artifactType: "verification_provider_precontext_envelope",
      bucketClass: "ledger",
    });
    this.#precontexts.set(input.requestDigest, precontext);
    this.#precontextEnvelopes.set(input.requestDigest, precontextEnvelope);
  }
  transportResponseArtifact(requestDigest: `sha256:${string}`): VerificationArtifactHandle | undefined {
    return this.#transportResponses.get(requestDigest);
  }
  requestArtifact(requestDigest: `sha256:${string}`): VerificationArtifactHandle | undefined {
    return this.#requests.get(requestDigest);
  }
  rawResponseArtifact(requestDigest: `sha256:${string}`): VerificationArtifactHandle | undefined {
    return this.#rawResponses.get(requestDigest);
  }
  responseEnvelopeArtifact(requestDigest: `sha256:${string}`): VerificationArtifactHandle | undefined {
    return this.#responseEnvelopes.get(requestDigest);
  }
  precontextArtifact(requestDigest: `sha256:${string}`): VerificationArtifactHandle | undefined {
    return this.#precontexts.get(requestDigest);
  }
  precontextEnvelopeArtifact(requestDigest: `sha256:${string}`): VerificationArtifactHandle | undefined {
    return this.#precontextEnvelopes.get(requestDigest);
  }
  #common() {
    return {
      tenantId: this.config.tenantId,
      createdAt: this.config.now(),
      producerActivityId: this.config.producerActivityId,
      producerVersion: this.config.producerVersion,
      encryptionClass: this.config.encryptionClass,
      retentionClass: this.config.retentionClass,
      dataClassification: "restricted" as const,
      storageBucket: this.config.storageBucket,
      ...(this.config.producerAttemptId ? { producerAttemptId: this.config.producerAttemptId } : {}),
      ...(this.config.missionId ? { missionId: this.config.missionId } : {}),
    };
  }
}

/** Persistence-aware production sink; the artifact composer alone is intentionally not dispatch-capable. */
export class AccountedVerificationProviderSink implements ProviderArtifactSink {
  #claimed = false;
  #requestDigest?: `sha256:${string}`;
  constructor(
    private readonly composer: VerificationProviderArtifactComposer,
    private readonly accounting: {
      reserve(input: {
        tenantId: string;
        budgetId: string;
        budgetKey: string;
        ceilingCostMicros: number;
        attemptId: string;
        requestDigest: `sha256:${string}`;
        attemptOrdinal: number;
        providerId: string;
        model: string;
        reservationCostMicros: number;
        estimatedCostMicros?: number;
        requestArtifactId: string;
      }): Promise<unknown>;
      claimDispatch(input: {
        tenantId: string;
        attemptId: string;
        dispatchFence: string;
      }): Promise<{ claimed: boolean }>;
      settle(input: {
        tenantId: string;
        attemptId: string;
        actualCostMicros: number;
        responseArtifactId: string;
      }): Promise<{ attempt: { state: string } }>;
      markUncertain(input: {
        tenantId: string;
        attemptId: string;
        responseArtifactId?: string;
      }): Promise<{ state: string }>;
    },
    private readonly budget: { tenantId: string; budgetId: string; budgetKey: string; ceilingCostMicros: number },
    private readonly call: {
      attemptId: string;
      providerId: string;
      model: string;
      estimatedCostMicros?: number;
      reservationCostMicros: number;
    },
  ) {}
  async assertExternalProcessingAdmission(input: {
    providerId: string;
    modality: "text" | "image" | "audio";
  }): Promise<void> {
    await this.composer.assertRegisteredInputAdmission(input);
  }
  async persistBeforeDispatch(input: { requestDigest: `sha256:${string}`; requestBytes: Uint8Array }): Promise<void> {
    await this.composer.persistBeforeDispatch(input);
    const artifact = this.composer.requestArtifact(input.requestDigest);
    if (!artifact) throw new Error("ACCOUNTED_PROVIDER_REQUEST_MISSING");
    await this.accounting.reserve({
      tenantId: this.budget.tenantId,
      budgetId: this.budget.budgetId,
      budgetKey: this.budget.budgetKey,
      ceilingCostMicros: this.budget.ceilingCostMicros,
      attemptId: this.call.attemptId,
      requestDigest: input.requestDigest,
      attemptOrdinal: 0,
      providerId: this.call.providerId,
      model: this.call.model,
      reservationCostMicros: this.call.reservationCostMicros,
      ...(this.call.estimatedCostMicros === undefined ? {} : { estimatedCostMicros: this.call.estimatedCostMicros }),
      requestArtifactId: artifact.artifactId,
    });
    if (
      !(
        await this.accounting.claimDispatch({
          tenantId: this.budget.tenantId,
          attemptId: this.call.attemptId,
          dispatchFence: randomUUID(),
        })
      ).claimed
    )
      throw new Error("ACCOUNTED_PROVIDER_DISPATCH_NOT_CLAIMED");
    this.#claimed = true;
    this.#requestDigest = input.requestDigest;
  }
  async persistAfterResponse(input: {
    requestDigest: `sha256:${string}`;
    rawResponseBytes: Uint8Array;
    precontextBytes?: Uint8Array;
    httpStatus?: number;
  }): Promise<void> {
    await this.composer.persistAfterResponse(input);
  }
  requestDigest(): `sha256:${string}` | undefined {
    return this.#requestDigest;
  }
  requestArtifactId(): string | undefined {
    return this.#requestDigest ? this.composer.requestArtifact(this.#requestDigest)?.artifactId : undefined;
  }
  rawArtifactId(): string | undefined {
    return this.#requestDigest ? this.composer.rawResponseArtifact(this.#requestDigest)?.artifactId : undefined;
  }
  rawResponseDigest(): string | undefined {
    return this.#requestDigest ? this.composer.rawResponseArtifact(this.#requestDigest)?.digest : undefined;
  }
  responseEnvelopeArtifactId(): string | undefined {
    return this.#requestDigest ? this.composer.responseEnvelopeArtifact(this.#requestDigest)?.artifactId : undefined;
  }
  async settleOrRetain(usage: { costMicros?: number }): Promise<{ state: string; actualCostMicros?: number }> {
    if (!this.#claimed) return { state: "not_dispatched" };
    const envelope = this.responseEnvelopeArtifactId();
    if (usage.costMicros !== undefined && envelope) {
      const settled = await this.accounting.settle({
        tenantId: this.budget.tenantId,
        attemptId: this.call.attemptId,
        actualCostMicros: usage.costMicros,
        responseArtifactId: envelope,
      });
      return { state: settled.attempt.state, actualCostMicros: usage.costMicros };
    }
    return this.accounting.markUncertain({
      tenantId: this.budget.tenantId,
      attemptId: this.call.attemptId,
      ...(envelope ? { responseArtifactId: envelope } : {}),
    });
  }
}
