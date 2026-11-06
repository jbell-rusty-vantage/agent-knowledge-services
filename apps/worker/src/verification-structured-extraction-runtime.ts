import { parseVerificationStructuredExtractionRuntimeConfig } from "@aiengineer/knowledge-application";
import { createPublicKey } from "node:crypto";
import { z } from "zod";
import {
  ExtractStructuredDataRequestSchema,
  StructuredExtractionPublicationLifecycleSnapshotSchema,
  StructuredExtractionFailureLifecycleSnapshotSchema,
  VerificationStructuredExtractionRuntimeSchema,
  type StructuredExtractionProviderCallSnapshot,
} from "@aiengineer/knowledge-contracts";
import {
  StructuredExtractionRuntimeGrantSchema,
  StructuredExtractionProfileAdmission,
  StructuredExtractionCapturedReplayService,
  StructuredExtractionCandidateBuilder,
  StructuredExtractionExecutionArtifactBuilder,
  StructuredExtractionPublicationArtifactBuilder,
  StructuredExtractionFailureArtifactBuilder,
  VerificationAdmissionService,
  VerificationProviderArtifactComposer,
  AccountedVerificationProviderSink,
  createStructuredExtractionOperationResult,
  createStructuredExtractionFailureOperationResult,
} from "@aiengineer/knowledge-application";
import {
  PostgresVerificationRepository,
  PostgresStructuredExtractionExecutionStore,
  PostgresStructuredExtractionLifecycleStore,
  PostgresStructuredExtractionPublicationStore,
  PostgresStructuredExtractionFailureStore,
  PostgresStructuredExtractionRecoveryStore,
  PostgresVerificationProviderResponseCaptureStore,
  PostgresVerificationProviderAccounting,
  type PostgresCanonicalRepository,
} from "@aiengineer/knowledge-persistence";
import { SandboxedVerificationParser, VERIFICATION_PARSER_LIMITS } from "@aiengineer/knowledge-preparation";
import { SupabaseArtifactStore, deterministicUuid } from "@aiengineer/knowledge-core";
import {
  GatewayStructuredExtractionProvider,
  InterfazeStructuredExtractionProvider,
  createEd25519Signer,
  createEd25519Verifier,
  digestCanonicalJson,
} from "@aiengineer/knowledge-verification";
import { CanonicalActivityError, type CanonicalActivityHandler } from "./activity-registry.js";

const inputSchema = z.strictObject({
  schemaVersion: z.literal("verification-service-request.v1"),
  useCase: z.literal("extractStructuredData"),
  request: ExtractStructuredDataRequestSchema,
});

/** Server-owned registered configuration. Synthetic transport requires an explicit in-process test port. */
export function createConfiguredVerificationStructuredExtractionHandler(input: {
  database: PostgresCanonicalRepository;
  tenantId: string;
  projectUrl: string;
  serviceRoleKey: string;
  maximumArtifactBytes: number;
  environment: Readonly<Record<string, string | undefined>>;
  syntheticFetch?: typeof fetch;
}): CanonicalActivityHandler | undefined {
  const syntheticFetch = input.syntheticFetch;
  const raw = input.environment.VERIFICATION_STRUCTURED_EXTRACTION_CONFIG_JSON?.trim();
  if (!raw) return undefined;
  if (new TextEncoder().encode(raw).byteLength > 1_500_000)
    throw new Error("STRUCTURED_EXTRACTION_RUNTIME_CONFIG_TOO_LARGE");
  const config = parseVerificationStructuredExtractionRuntimeConfig(raw);
  if (config.tenantId !== input.tenantId || config.grants.some((g) => g.tenantId !== config.tenantId))
    throw new Error("STRUCTURED_EXTRACTION_RUNTIME_TENANT_MISMATCH");
  if ((config.executionMode === "synthetic_transport") !== (syntheticFetch !== undefined))
    throw new Error("STRUCTURED_EXTRACTION_RUNTIME_TRANSPORT_MISMATCH");
  const keyId = input.environment.VERIFICATION_STRUCTURED_EXTRACTION_SIGNING_KEY_ID?.trim(),
    privateKey = input.environment.VERIFICATION_STRUCTURED_EXTRACTION_SIGNING_PRIVATE_KEY_PEM?.trim();
  if (!keyId || !privateKey) throw new Error("STRUCTURED_EXTRACTION_SIGNING_KEY_REQUIRED");
  const publicKey = createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();
  if (config.trustedPublicKeys[keyId] !== publicKey) throw new Error("STRUCTURED_EXTRACTION_SIGNING_TRUST_MISMATCH");
  const signer = createEd25519Signer(privateKey, keyId),
    verifier = createEd25519Verifier(config.trustedPublicKeys);
  const gateway = config.providerId === "gateway-structured-extraction.v1";
  const apiKey =
    config.executionMode === "synthetic_transport"
      ? "synthetic"
      : input.environment[gateway ? "AI_GATEWAY_API_KEY" : "INTERFAZE_API_KEY"]?.trim();
  if (!apiKey) throw new Error("STRUCTURED_EXTRACTION_PROVIDER_KEY_REQUIRED");
  const database = input.database,
    tenantId = config.tenantId,
    storageBucket = input.environment.VERIFICATION_STORAGE_BUCKET?.trim() || "ai-engineer-cloud-bucket";
  const repository = new PostgresVerificationRepository(
    database,
    new SupabaseArtifactStore({
      projectUrl: input.projectUrl,
      serviceRoleKey: input.serviceRoleKey,
      bucket: storageBucket,
      maximumBytes: Math.min(input.maximumArtifactBytes, 16_000_000),
    }),
    {
      async authorize(value) {
        if (value.tenantId !== tenantId || !["verification_admission", "verification_replay"].includes(value.purpose))
          throw new Error("STRUCTURED_EXTRACTION_ARTIFACT_DENIED");
      },
    },
  );
  const native = new VerificationAdmissionService(
    repository,
    new SandboxedVerificationParser(config.parserImageDigest as `sha256:${string}`),
    {
      parserVersion: "verification-native-parser.v1",
      imageDigest: config.parserImageDigest as `sha256:${string}`,
      limits: VERIFICATION_PARSER_LIMITS,
    },
    {
      storageBucket,
      producerVersion: "verification-service.v1",
      encryptionClass: "supabase-managed",
      retentionClass: "verification-audit",
      now: () => new Date().toISOString(),
    },
  );
  const admission = new StructuredExtractionProfileAdmission(
    config.grants,
    () => repository.createTrustedArtifactResolver(),
    native,
  );
  const executionStore = new PostgresStructuredExtractionExecutionStore(database),
    lifecycleStore = new PostgresStructuredExtractionLifecycleStore(database),
    captures = new PostgresVerificationProviderResponseCaptureStore(database),
    recovery = new PostgresStructuredExtractionRecoveryStore(
      database,
      () => repository.createTrustedArtifactResolver(),
      verifier,
    );
  const publicationStore = new PostgresStructuredExtractionPublicationStore(database, verifier),
    failureStore = new PostgresStructuredExtractionFailureStore(database, verifier);
  const artifacts = {
    async register(
      value:
        | Parameters<ConstructorParameters<typeof StructuredExtractionCandidateBuilder>[1]["register"]>[0]
        | Parameters<
            ConstructorParameters<typeof StructuredExtractionExecutionArtifactBuilder>[0]["artifacts"]["register"]
          >[0]
        | Parameters<
            ConstructorParameters<typeof StructuredExtractionFailureArtifactBuilder>[1]["artifacts"]["register"]
          >[0],
    ) {
      return repository.registerContentAddressedArtifact({
        ...value,
        producerActivityId: "verification-service:extractStructuredData",
        producerVersion: "verification-service.v1",
        mediaType: "application/json",
        encryptionClass: "supabase-managed",
        retentionClass: "verification-audit",
        dataClassification: "restricted",
        bucketClass: "candidate",
        storageBucket,
      });
    },
  };
  const executionBuilder = new StructuredExtractionExecutionArtifactBuilder({
      artifacts,
      createResolver: () => repository.createTrustedArtifactResolver(),
    }),
    publicationBuilder = new StructuredExtractionPublicationArtifactBuilder({
      artifacts,
      createResolver: () => repository.createTrustedArtifactResolver(),
      signer,
    });
  const runtimeDigest = digestCanonicalJson(config.runtime);
  return {
    operationKind: "verification_structured_extraction",
    stepName: "extract_and_register",
    async execute({ activity, claim, operation }) {
      const controller = new AbortController();
      let polling: Promise<void> | undefined;
      let pollError: unknown;
      const active = async () => {
        if (controller.signal.aborted) throw pollError ?? new Error("STRUCTURED_EXTRACTION_CANCELLED");
        const current = await database.getOperation(tenantId, operation.id);
        if (!current || current.status !== "running") {
          controller.abort();
          throw new CanonicalActivityError(
            "VERIFICATION_OPERATION_NOT_ACTIVE",
            "VERIFICATION_OPERATION_NOT_ACTIVE",
            false,
          );
        }
      };
      const timer = setInterval(() => {
        polling ??= active()
          .catch((error) => {
            pollError = error;
            controller.abort();
          })
          .finally(() => {
            polling = undefined;
          });
      }, 250);
      try {
        const request = inputSchema.parse(activity.operationInput).request,
          context = activity.context;
        if (
          context.tenantId !== tenantId ||
          operation.tenantId !== tenantId ||
          claim.tenantId !== tenantId ||
          context.operationId !== operation.id ||
          claim.operationId !== operation.id ||
          operation.operationKind !== "verification_structured_extraction"
        )
          throw new Error("STRUCTURED_EXTRACTION_OPERATION_IDENTITY_MISMATCH");
        await active();
        const published = await recovery.readPublished({ lease: claim, signal: controller.signal });
        if (published) {
          if (
            published.manifest.execution.runtimeDigest !== runtimeDigest ||
            published.manifest.execution.manifest.execution.mode !== config.executionMode
          )
            throw new Error("STRUCTURED_EXTRACTION_RECOVERY_RUNTIME_INCOMPATIBLE");
          return published.result;
        }
        const preparation = await admission.prepare({ tenantId, request, signal: controller.signal });
        if (preparation.provider.providerId !== config.providerId)
          throw new Error("STRUCTURED_EXTRACTION_CONFIGURED_PROVIDER_MISMATCH");
        const identity = {
          tenantId,
          operationId: operation.id,
          operationStepId: claim.id,
          producerAttemptId: context.attemptId,
          requestDigest: `sha256:${operation.requestSha256}` as const,
          stepInputDigest: `sha256:${claim.inputSha256}` as const,
          captureId: preparation.captureId,
          profileArtifact: preparation.artifacts.producerProfile,
          schemaArtifact: preparation.artifacts.extractionSchema,
          sourceArtifact: preparation.artifacts.source,
          representationArtifact: preparation.representation,
          transformationArtifact: preparation.artifacts.transformation,
          promptDigest: preparation.promptDigest,
          schemaDigest: preparation.schema.schemaDigest,
        };
        const bound = await executionStore.readForRecovery({ lease: claim });
        if (bound && (bound.runtimeDigest !== runtimeDigest || bound.mode !== config.executionMode))
          throw new Error("STRUCTURED_EXTRACTION_RECOVERY_RUNTIME_INCOMPATIBLE");
        const execution = await executionBuilder.prepare({
          identity: {
            tenantId,
            operationId: operation.id,
            operationStepId: claim.id,
            producerAttemptId: context.attemptId,
            requestDigest: identity.requestDigest,
            stepInputDigest: identity.stepInputDigest,
          },
          profileArtifact: identity.profileArtifact,
          runtime: config.runtime,
          execution: {
            mode: config.executionMode,
            networkPolicy: config.executionMode === "synthetic_transport" ? "disabled" : "allowlisted",
          },
          versions: {
            parser: "verification-native-parser.v1",
            extractor: "structured-extraction.v1",
            canonicalization: "verification-canonical-json.v1",
          },
          createdAt: bound?.createdAt ?? operation.createdAt,
          signal: controller.signal,
        });
        await executionStore.bind({ lease: claim, ...execution });
        const lifecycle = await lifecycleStore.initialize({ identity, lease: claim });
        const accounting = new PostgresVerificationProviderAccounting(database, {
          lease: claim,
          profileArtifactId: identity.profileArtifact.artifactId,
          profileDigest: identity.profileArtifact.digest as `sha256:${string}`,
        });
        let provider = await accounting.readOriginalAttempt(tenantId);
        const providerAttemptId =
          provider?.attemptId ??
          deterministicUuid("verification-structured-extraction-provider", `${tenantId}:${operation.id}:0`);
        let capture = provider ? await captures.readForRecovery({ lease: claim, providerAttemptId }) : undefined;
        if (!capture) {
          if (provider && provider.state !== "reserved") {
            if (provider.state === "dispatched")
              await accounting.markUncertain({ tenantId, attemptId: provider.attemptId });
            throw new CanonicalActivityError(
              "STRUCTURED_EXTRACTION_DISPATCH_UNCERTAIN",
              "Original dispatch has no captured response; reconciliation required",
              false,
            );
          }
          await active();
          const composer = new VerificationProviderArtifactComposer(repository, {
            tenantId,
            storageBucket,
            producerActivityId: "verification-service:extractStructuredData:provider",
            producerVersion: "verification-service.v1",
            encryptionClass: "supabase-managed",
            retentionClass: "verification-audit",
            now: () => execution.execution.createdAt,
            externalProcessingGrant: {
              providerId: gateway ? "gateway" : "interfaze",
              dataClassification: preparation.producerProfile.externalProcessing.classification,
              modalities: ["text"],
              ...(gateway ? {} : { zdrPolicy: "required" as const }),
            },
            transportResponse: {
              binding: {
                tenantId,
                operationId: operation.id,
                operationStepId: claim.id,
                providerAttemptId,
                profileArtifactId: identity.profileArtifact.artifactId,
                profileDigest: identity.profileArtifact.digest,
                dispatchFencingToken: claim.fencingToken,
              },
              async record(value) {
                await captures.store({ lease: claim, ...value });
              },
            },
          });
          await composer.registerInput(new TextEncoder().encode(preparation.prompt), "text/plain");
          const sink = new AccountedVerificationProviderSink(
            composer,
            accounting,
            { tenantId, ...preparation.producerProfile.budget },
            {
              attemptId: providerAttemptId,
              providerId: config.providerId,
              model: preparation.provider.model,
              reservationCostMicros: preparation.producerProfile.budget.reservationCostMicros,
            },
          );
          const options = { apiKey, artifactSink: sink, ...(syntheticFetch ? { fetch: syntheticFetch } : {}) };
          const adapter = gateway
            ? new GatewayStructuredExtractionProvider(options)
            : new InterfazeStructuredExtractionProvider(options);
          try {
            const accepted = await adapter.extract({
              prompt: preparation.prompt,
              schemaName: "structured_extraction",
              schema: preparation.schema.canonicalSchema,
              execution: { signal: controller.signal },
            });
            await sink.settleOrRetain("usage" in accepted ? accepted.usage : accepted.call.usage);
          } catch (error) {
            await sink.settleOrRetain({});
            capture = await captures.readForRecovery({ lease: claim, providerAttemptId });
            if (!capture) throw error;
          }
          capture ??= await captures.readForRecovery({ lease: claim, providerAttemptId });
        }
        if (!capture) throw new Error("STRUCTURED_EXTRACTION_CAPTURE_MISSING");
        const retaining = await lifecycleStore.beginRetention({ lifecycle, lease: claim, capture });
        const replayService = new StructuredExtractionCapturedReplayService(admission, () =>
          repository.createTrustedArtifactResolver(),
        );
        const replay = await replayService.replay({
          tenantId,
          request,
          preparation,
          capture,
          signal: controller.signal,
        });
        provider = await accounting.readOriginalAttempt(tenantId);
        if (!provider || !["dispatched", "uncertain", "settled"].includes(provider.state))
          throw new Error("STRUCTURED_EXTRACTION_PROVIDER_STATE_INVALID");
        const usage = z
          .object({ costMicros: z.int().nonnegative().max(20_000_000).optional() })
          .passthrough()
          .parse(replay.kind === "accepted" ? replay.usage : {});
        if (provider.state !== "settled") {
          if (replay.kind === "accepted" && usage.costMicros !== undefined)
            await accounting.settle({
              tenantId,
              attemptId: providerAttemptId,
              actualCostMicros: usage.costMicros,
              responseArtifactId: retaining.responseEnvelopeArtifact!.artifactId,
            });
          else
            await accounting.markUncertain({
              tenantId,
              attemptId: providerAttemptId,
              responseArtifactId: retaining.responseEnvelopeArtifact!.artifactId,
            });
          provider = await accounting.readOriginalAttempt(tenantId);
        }
        if (!provider) throw new Error("STRUCTURED_EXTRACTION_PROVIDER_STATE_INVALID");
        const providerCall: StructuredExtractionProviderCallSnapshot = {
          providerAttemptId,
          budgetId: provider.budgetId,
          providerId: config.providerId,
          model: provider.model,
          configurationDigest: preparation.provider.configurationDigest,
          attemptOrdinal: provider.attemptOrdinal,
          reservationCostMicros: provider.reservationCostMicros,
          state: provider.state as "dispatched" | "uncertain" | "settled",
          actualCostMicros: provider.actualCostMicros ?? null,
          pricingBasis:
            config.executionMode === "synthetic_transport" ? "synthetic_transport" : "provider_reported_response",
          costEvidenceArtifact: retaining.rawResponseArtifact!,
          supplierBillingVerified: false,
        };
        await active();
        if (replay.kind === "failed") {
          const failedLifecycle = StructuredExtractionFailureLifecycleSnapshotSchema.parse(retaining),
            checkpoint = await failureStore.initialize({
              lease: claim,
              lifecycle: failedLifecycle,
              code: replay.code as Parameters<typeof failureStore.initialize>[0]["code"],
            });
          const builder = new StructuredExtractionFailureArtifactBuilder(replayService, {
            artifacts,
            createResolver: () => repository.createTrustedArtifactResolver(),
            signer,
          });
          const publication = await builder.publish({
            tenantId,
            operationId: operation.id,
            providerAttemptId,
            preparation,
            replay,
            lifecycle: failedLifecycle,
            completedAt: checkpoint.completedAt,
            executionArtifact: execution.artifact,
            providerCall,
            signal: controller.signal,
          });
          await failureStore.publish({ lease: claim, lifecycle: failedLifecycle, checkpoint, ...publication });
          return createStructuredExtractionFailureOperationResult({ ...publication, verifier });
        }
        const builder = new StructuredExtractionCandidateBuilder(replayService, artifacts);
        const candidate = await builder.retain({
          tenantId,
          operationId: operation.id,
          providerAttemptId,
          producerAttemptId: context.attemptId,
          createdAt: retaining.retentionStartedAt!,
          preparation,
          replay,
          signal: controller.signal,
        });
        const retained = await lifecycleStore.completeRetention({ lifecycle: retaining, lease: claim, candidate });
        const publication = await publicationBuilder.publish({
          lifecycle: StructuredExtractionPublicationLifecycleSnapshotSchema.parse(retained),
          executionArtifact: execution.artifact,
          providerCall,
          signal: controller.signal,
        });
        await publicationStore.publish({ lease: claim, ...publication });
        return createStructuredExtractionOperationResult({ ...publication, verifier });
      } finally {
        clearInterval(timer);
        if (polling) await polling;
      }
    },
  };
}
