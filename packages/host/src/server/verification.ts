import type { VerificationResourceReadServices } from "@aiengineer/knowledge-application";
import type { PostgresCanonicalRepository } from "@aiengineer/knowledge-persistence";
import { createVerificationHostRuntime, type VerificationHostRuntime } from "../verification/host-runtime.js";
import { createVerificationBenchmarkCaptureProfileResolver } from "../verification/api/verification-benchmark-capture-profile.js";
import { createVerificationBenchmarkComparisonReads } from "../verification/api/verification-benchmark-comparison-reads-runtime.js";
import { createVerificationBenchmarkReads } from "../verification/api/verification-benchmark-reads-runtime.js";
import { createVerificationCaptureReads } from "../verification/api/verification-capture-reads-runtime.js";
import { createVerificationProviderReconciliationService } from "../verification/api/verification-provider-reconciliation-runtime.js";
import { createVerificationStructuredExtractionReads } from "../verification/api/verification-structured-extraction-reads-runtime.js";
import type { HostEnvironment } from "./shared.js";

type Defined<T> = NonNullable<T>;

/**
 * Verification admission, ownership and read/reconciliation services composed
 * identically for the API and MCP roles. Each service is present only when configured.
 */
export interface VerificationServices {
  /** Shared admission gates and trusted ownership resolution. */
  readonly runtime: VerificationHostRuntime;
  readonly benchmarkReads?: Defined<ReturnType<typeof createVerificationBenchmarkReads>>;
  readonly benchmarkComparisonReads?: Defined<ReturnType<typeof createVerificationBenchmarkComparisonReads>>;
  readonly providerReconciliation?: Defined<ReturnType<typeof createVerificationProviderReconciliationService>>;
  readonly structuredExtractionReads?: Defined<ReturnType<typeof createVerificationStructuredExtractionReads>>;
  readonly captureReads?: Defined<ReturnType<typeof createVerificationCaptureReads>>;
  readonly resolveBenchmarkCaptureProfile?: Defined<
    ReturnType<typeof createVerificationBenchmarkCaptureProfileResolver>
  >;
}

/**
 * Construction order and configuration failure codes match the previous API bootstrap
 * (admission runtime, run/benchmark reads, then the formerly API-injected use cases).
 */
export function composeVerificationServices(
  database: PostgresCanonicalRepository | undefined,
  environment: HostEnvironment,
  options: { readonly production: boolean },
): VerificationServices {
  const runtime = createVerificationHostRuntime(database, environment, { production: options.production });
  const benchmarkReads = createVerificationBenchmarkReads(database, environment);
  const benchmarkComparisonReads = createVerificationBenchmarkComparisonReads(database, environment);
  const providerReconciliation = createVerificationProviderReconciliationService(database, environment);
  const structuredExtractionReads = createVerificationStructuredExtractionReads(database, environment);
  const captureReads = createVerificationCaptureReads(database, environment);
  const ownershipGrants = environment.VERIFICATION_SERVICE_OWNERSHIP_GRANTS_JSON?.trim();
  const benchmarkCaptureProfiles = environment.VERIFICATION_BENCHMARK_CAPTURE_PROFILES_JSON?.trim();
  if (benchmarkCaptureProfiles && (!database || !ownershipGrants))
    throw new Error("VERIFICATION_BENCHMARK_CAPTURE_PROFILE_CONFIGURATION_REQUIRED");
  const resolveBenchmarkCaptureProfile = benchmarkCaptureProfiles
    ? createVerificationBenchmarkCaptureProfileResolver(database!, benchmarkCaptureProfiles, ownershipGrants!)
    : undefined;
  return {
    runtime,
    ...(benchmarkReads ? { benchmarkReads } : {}),
    ...(benchmarkComparisonReads ? { benchmarkComparisonReads } : {}),
    ...(providerReconciliation ? { providerReconciliation } : {}),
    ...(structuredExtractionReads ? { structuredExtractionReads } : {}),
    ...(captureReads ? { captureReads } : {}),
    ...(resolveBenchmarkCaptureProfile ? { resolveBenchmarkCaptureProfile } : {}),
  };
}

/** The composed services as application verification read ports. */
export function verificationReadServices(verify: VerificationServices): VerificationResourceReadServices {
  return {
    ...(verify.structuredExtractionReads ? { structuredExtractionReads: verify.structuredExtractionReads } : {}),
    ...(verify.captureReads ? { captureReads: verify.captureReads } : {}),
    ...(verify.benchmarkComparisonReads ? { benchmarkComparisonReads: verify.benchmarkComparisonReads } : {}),
    ...(verify.benchmarkReads ? { benchmarkReads: verify.benchmarkReads } : {}),
    ...(verify.providerReconciliation ? { providerReconciliation: verify.providerReconciliation } : {}),
  };
}
