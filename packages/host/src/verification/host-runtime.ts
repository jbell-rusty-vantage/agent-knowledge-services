import {
  createBenchmarkComparisonRequestAdmission,
  createBenchmarkRequestAdmission,
  createParseArtifactRequestAdmission,
  createStaticVerificationContextResolver,
  createStructuredExtractionRequestAdmission,
  createVerificationOwnershipResolver,
  parseBenchmarkReadPublicKeys,
  parseVerificationBenchmarkComparisonRuntimeConfig,
  parseVerificationBenchmarkRuntimeConfig,
  parseVerificationStructuredExtractionRuntimeConfig,
  VerificationServiceCatalog,
  verificationServiceOperationKinds,
  type KnowledgeOperationPort,
  type ResolveVerificationContext,
  type VerificationServiceCatalog as VerificationCaptureCatalog,
} from "@aiengineer/knowledge-application";
import {
  ExternalExecutionContextSchema,
  type CompareBenchmarkRunsRequest,
  type ParseArtifactRequest,
  type RunBenchmarkRequest,
} from "@aiengineer/knowledge-contracts";
import { UuidSchema } from "@aiengineer/knowledge-contracts";
import type { OperationKind } from "@aiengineer/knowledge-contracts";
import { PostgresKnowledgeOperationService, type PostgresCanonicalRepository } from "@aiengineer/knowledge-persistence";

export interface VerificationHostAdmission {
  readonly isParseArtifactRequestAdmitted?: (tenantId: string, request: ParseArtifactRequest) => boolean;
  readonly isStructuredExtractionRequestAdmitted?: (tenantId: string, request: unknown) => boolean;
  readonly isBenchmarkRequestAdmitted?: (tenantId: string, request: RunBenchmarkRequest) => boolean;
  readonly isBenchmarkComparisonRequestAdmitted?: (tenantId: string, request: CompareBenchmarkRunsRequest) => boolean;
}

export interface VerificationHostRuntime extends VerificationHostAdmission {
  readonly verificationConfigured: boolean;
  readonly resolveVerificationContext?: ResolveVerificationContext;
  readonly verificationOperationService?: KnowledgeOperationPort;
  readonly verificationCaptureCatalog?: VerificationCaptureCatalog;
}

type Environment = Readonly<Record<string, string | undefined>>;
type FeatureToggle = "0" | "1" | undefined;
const CONFIG_MAX_CHARS = 262_144;
/**
 * SV-17 retired the verification.v1 claims, report, metric, audit-inspection and adjudication operations and the Eve
 * runtime attestation (their AIDB tables were withdrawn). Their configuration is refused at startup, never ignored.
 */
const RETIRED_CONFIGURATION = [
  "VERIFICATION_EVE_RUNTIME_ATTESTATION_KEYS_JSON",
  "VERIFICATION_METRIC_ENABLED",
  "VERIFICATION_CLAIMS_ENABLED",
  "VERIFICATION_CLAIMS_PROJECTION_GRANTS_JSON",
  "VERIFICATION_AUDIT_INSPECTION_ENABLED",
  "VERIFICATION_AUDIT_INSPECTION_GRANTS_JSON",
  "VERIFICATION_ADJUDICATION_GRANTS_JSON",
  "VERIFICATION_ADJUDICATION_REVIEW_REQUIREMENTS_JSON",
  "VERIFICATION_ADJUDICATION_PUBLIC_KEYS_JSON",
  "VERIFICATION_ADJUDICATION_DECISIONS_ENABLED",
] as const;

export function assertNoRetiredVerificationConfiguration(environment: Environment): void {
  for (const name of RETIRED_CONFIGURATION)
    if (environment[name]?.trim()) throw new Error(`VERIFICATION_RETIRED_CONFIGURATION:${name}`);
}
function readFeatureToggle(raw: string | undefined, invalidCode: string): FeatureToggle {
  const value = raw?.trim();
  if (!value) return undefined;
  if (value !== "0" && value !== "1") throw new Error(invalidCode);
  return value;
}

function requireOwnership(context: ResolveVerificationContext | undefined, code: string): void {
  if (!context) throw new Error(code);
}

function parseJsonOrThrow(raw: string, invalidCode: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(invalidCode);
  }
}

function parseServiceCatalog(raw: string | undefined, requiredCode: string, invalidCode: string) {
  if (!raw || raw.length > CONFIG_MAX_CHARS) throw new Error(requiredCode);
  return new VerificationServiceCatalog(
    parseJsonOrThrow(raw, invalidCode) as ConstructorParameters<typeof VerificationServiceCatalog>[0],
  );
}

function resolveOwnershipContext(input: {
  readonly database: PostgresCanonicalRepository | undefined;
  readonly environment: Environment;
  readonly production: boolean;
}): ResolveVerificationContext | undefined {
  const verificationAttemptId = input.environment.VERIFICATION_SERVICE_ATTEMPT_ID?.trim();
  const ownershipGrants = input.environment.VERIFICATION_SERVICE_OWNERSHIP_GRANTS_JSON?.trim();
  if (input.production && verificationAttemptId && !ownershipGrants)
    throw new Error("VERIFICATION_OWNERSHIP_GRANTS_REQUIRED");
  return input.database && ownershipGrants
    ? createVerificationOwnershipResolver(input.database, ownershipGrants)
    : undefined;
}

function resolveBenchmarkConfigs(input: {
  readonly environment: Environment;
  readonly dynamicVerificationContext: ResolveVerificationContext | undefined;
}) {
  const benchmarkRaw = input.environment.VERIFICATION_BENCHMARK_CONFIG_JSON?.trim();
  const benchmarkConfig = benchmarkRaw ? parseVerificationBenchmarkRuntimeConfig(benchmarkRaw) : undefined;
  if (benchmarkConfig && !input.dynamicVerificationContext)
    throw new Error("BENCHMARK_RUNTIME_OWNERSHIP_GRANTS_REQUIRED");
  const comparisonRaw = input.environment.VERIFICATION_BENCHMARK_COMPARISON_CONFIG_JSON?.trim();
  const comparisonConfig = comparisonRaw ? parseVerificationBenchmarkComparisonRuntimeConfig(comparisonRaw) : undefined;
  if (comparisonConfig && !input.dynamicVerificationContext)
    throw new Error("BENCHMARK_COMPARISON_OWNERSHIP_GRANTS_REQUIRED");
  const extractionRaw = input.environment.VERIFICATION_STRUCTURED_EXTRACTION_CONFIG_JSON?.trim();
  const extractionConfig = extractionRaw
    ? parseVerificationStructuredExtractionRuntimeConfig(extractionRaw)
    : undefined;
  if (extractionConfig && (!input.dynamicVerificationContext || extractionConfig.executionMode !== "live_provider"))
    throw new Error("STRUCTURED_EXTRACTION_API_OWNERSHIP_AND_LIVE_RUNTIME_REQUIRED");
  if (extractionConfig)
    parseBenchmarkReadPublicKeys(
      JSON.stringify(
        Object.entries(extractionConfig.trustedPublicKeys).map(([keyId, publicKeyPem]) => ({ keyId, publicKeyPem })),
      ),
    );
  return { benchmarkConfig, comparisonConfig, extractionConfig };
}

function resolveCaptureCatalog(input: {
  readonly environment: Environment;
  readonly dynamicVerificationContext: ResolveVerificationContext | undefined;
}): VerificationServiceCatalog | undefined {
  const captureAcquireEnabled = readFeatureToggle(
    input.environment.VERIFICATION_CAPTURE_ACQUIRE_ENABLED,
    "INVALID_VERIFICATION_CAPTURE_ACQUIRE_ENABLED",
  );
  if (captureAcquireEnabled !== "1") return undefined;
  requireOwnership(input.dynamicVerificationContext, "VERIFICATION_ACQUISITION_OWNERSHIP_GRANTS_REQUIRED");
  const catalog = parseServiceCatalog(
    input.environment.VERIFICATION_SERVICE_CATALOG_JSON?.trim(),
    "VERIFICATION_ACQUISITION_RUNTIME_GRANTS_REQUIRED",
    "VERIFICATION_ACQUISITION_RUNTIME_GRANTS_INVALID",
  );
  if (!catalog.hasAcquisitionGrants()) throw new Error("VERIFICATION_ACQUISITION_RUNTIME_GRANTS_REQUIRED");
  return catalog;
}

function resolveParseArtifactAdmission(input: {
  readonly environment: Environment;
  readonly dynamicVerificationContext: ResolveVerificationContext | undefined;
}): ((tenantId: string, request: ParseArtifactRequest) => boolean) | undefined {
  const parseArtifactEnabled = readFeatureToggle(
    input.environment.VERIFICATION_PARSE_ARTIFACT_ENABLED,
    "INVALID_VERIFICATION_PARSE_ARTIFACT_ENABLED",
  );
  if (parseArtifactEnabled !== "1") return undefined;
  requireOwnership(input.dynamicVerificationContext, "VERIFICATION_PARSE_ARTIFACT_OWNERSHIP_GRANTS_REQUIRED");
  const catalog = parseServiceCatalog(
    input.environment.VERIFICATION_SERVICE_CATALOG_JSON?.trim(),
    "VERIFICATION_PARSE_ARTIFACT_RUNTIME_GRANTS_REQUIRED",
    "VERIFICATION_PARSE_ARTIFACT_RUNTIME_GRANTS_INVALID",
  );
  if (!catalog.hasParseArtifactGrants()) throw new Error("VERIFICATION_PARSE_ARTIFACT_RUNTIME_GRANTS_REQUIRED");
  return createParseArtifactRequestAdmission(catalog);
}

function resolveStaticVerificationContext(environment: Environment): ResolveVerificationContext | undefined {
  const verificationAttemptId = environment.VERIFICATION_SERVICE_ATTEMPT_ID?.trim();
  if (verificationAttemptId) UuidSchema.parse(verificationAttemptId);
  const verificationWorkItemId = environment.VERIFICATION_SERVICE_WORK_ITEM_ID?.trim();
  if (verificationWorkItemId) UuidSchema.parse(verificationWorkItemId);
  const verificationMissionId = environment.VERIFICATION_SERVICE_MISSION_ID?.trim();
  if (verificationMissionId) UuidSchema.parse(verificationMissionId);
  const verificationCausationId = environment.VERIFICATION_SERVICE_CAUSATION_ID?.trim();
  const externalRuntime = environment.VERIFICATION_SERVICE_EXTERNAL_RUNTIME?.trim(),
    externalRunId = environment.VERIFICATION_SERVICE_EXTERNAL_RUN_ID?.trim();
  if (Boolean(externalRuntime) !== Boolean(externalRunId))
    throw new Error("VERIFICATION_EXTERNAL_EXECUTION_CONFIG_INCOMPLETE");
  const verificationExternalExecution =
    externalRuntime && externalRunId
      ? ExternalExecutionContextSchema.parse({
          runtime: externalRuntime,
          runId: externalRunId,
          ...(environment.VERIFICATION_SERVICE_EXTERNAL_ROOT_RUN_ID?.trim()
            ? { rootRunId: environment.VERIFICATION_SERVICE_EXTERNAL_ROOT_RUN_ID.trim() }
            : {}),
          ...(environment.VERIFICATION_SERVICE_EXTERNAL_SESSION_ID?.trim()
            ? { sessionId: environment.VERIFICATION_SERVICE_EXTERNAL_SESSION_ID.trim() }
            : {}),
          ...(environment.VERIFICATION_SERVICE_EXTERNAL_TURN_ID?.trim()
            ? { turnId: environment.VERIFICATION_SERVICE_EXTERNAL_TURN_ID.trim() }
            : {}),
          ...(environment.VERIFICATION_SERVICE_EXTERNAL_TOOL_CALL_ID?.trim()
            ? {
                toolCallId: environment.VERIFICATION_SERVICE_EXTERNAL_TOOL_CALL_ID.trim(),
              }
            : {}),
        })
      : undefined;
  return verificationAttemptId
    ? createStaticVerificationContextResolver({
        attemptId: verificationAttemptId,
        ...(verificationWorkItemId ? { workItemId: verificationWorkItemId } : {}),
        ...(verificationMissionId ? { missionId: verificationMissionId } : {}),
        ...(verificationCausationId ? { causationId: verificationCausationId } : {}),
        ...(verificationExternalExecution ? { externalExecution: verificationExternalExecution } : {}),
        capabilityVersion: environment.VERIFICATION_SERVICE_CAPABILITY_VERSION?.trim() || "verification-service.v1",
      })
    : undefined;
}

function collectAdmittedOperationKinds(input: {
  readonly extraAdmittedKinds?: readonly OperationKind[];
  readonly parseArtifactEnabled: boolean;
  readonly benchmarkEnabled: boolean;
  readonly comparisonEnabled: boolean;
  readonly extractionEnabled: boolean;
}): OperationKind[] {
  return [
    ...verificationServiceOperationKinds,
    ...(input.extraAdmittedKinds ?? []),
    ...(input.parseArtifactEnabled ? (["verification_parse_artifact"] as const) : []),
    ...(input.benchmarkEnabled ? (["verification_benchmark"] as const) : []),
    ...(input.comparisonEnabled ? (["verification_benchmark_compare"] as const) : []),
    ...(input.extractionEnabled ? (["verification_structured_extraction"] as const) : []),
  ];
}

export function createVerificationHostRuntime(
  database: PostgresCanonicalRepository | undefined,
  environment: Environment,
  options: {
    readonly production: boolean;
    readonly extraAdmittedKinds?: readonly OperationKind[];
  },
): VerificationHostRuntime {
  assertNoRetiredVerificationConfiguration(environment);
  const verificationAttemptId = environment.VERIFICATION_SERVICE_ATTEMPT_ID?.trim();
  const dynamicVerificationContext = resolveOwnershipContext({
    database,
    environment,
    production: options.production,
  });
  const verificationConfigured = Boolean(database && (dynamicVerificationContext || verificationAttemptId));
  const { benchmarkConfig, comparisonConfig, extractionConfig } = resolveBenchmarkConfigs({
    environment,
    dynamicVerificationContext,
  });
  const parseArtifactEnabled = readFeatureToggle(
    environment.VERIFICATION_PARSE_ARTIFACT_ENABLED,
    "INVALID_VERIFICATION_PARSE_ARTIFACT_ENABLED",
  );
  const verificationCaptureCatalog = resolveCaptureCatalog({
    environment,
    dynamicVerificationContext,
  });
  const isParseArtifactRequestAdmitted = resolveParseArtifactAdmission({
    environment,
    dynamicVerificationContext,
  });
  const staticVerificationContext = resolveStaticVerificationContext(environment);
  const resolveVerificationContext = dynamicVerificationContext ?? staticVerificationContext;
  if (!database || !verificationConfigured || !resolveVerificationContext) return { verificationConfigured };
  return {
    verificationConfigured,
    resolveVerificationContext,
    verificationOperationService: new PostgresKnowledgeOperationService(database, {
      admittedOperationKinds: collectAdmittedOperationKinds({
        ...(options.extraAdmittedKinds ? { extraAdmittedKinds: options.extraAdmittedKinds } : {}),
        parseArtifactEnabled: parseArtifactEnabled === "1",
        benchmarkEnabled: Boolean(benchmarkConfig),
        comparisonEnabled: Boolean(comparisonConfig),
        extractionEnabled: Boolean(extractionConfig),
      }),
    }),
    ...(verificationCaptureCatalog ? { verificationCaptureCatalog } : {}),
    ...(isParseArtifactRequestAdmitted ? { isParseArtifactRequestAdmitted } : {}),
    ...(extractionConfig
      ? {
          isStructuredExtractionRequestAdmitted: createStructuredExtractionRequestAdmission(extractionConfig),
        }
      : {}),
    ...(benchmarkConfig ? { isBenchmarkRequestAdmitted: createBenchmarkRequestAdmission(benchmarkConfig) } : {}),
    ...(comparisonConfig
      ? {
          isBenchmarkComparisonRequestAdmitted: createBenchmarkComparisonRequestAdmission(comparisonConfig),
        }
      : {}),
  };
}
