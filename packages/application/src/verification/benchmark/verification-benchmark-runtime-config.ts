import {
  RunBenchmarkRequestSchema,
  UuidSchema,
  VerificationBenchmarkPublicationManifestSchema,
} from "@aiengineer/knowledge-contracts";
import { deepFreeze } from "@aiengineer/knowledge-core";
import { z } from "zod";
import { OfflineBenchmarkInputCatalog, type OfflineBenchmarkInputGrant } from "./verification-benchmark-inputs.js";
import {
  RegisteredBenchmarkProfileCatalog,
  type RegisteredBenchmarkProfileGrant,
} from "./verification-benchmark-registered-profile.js";
import {
  RegisteredBenchmarkReplayCatalog,
  type RegisteredBenchmarkReplayGrant,
} from "./verification-benchmark-registered-replay.js";
import {
  RegisteredBenchmarkSourceImportCatalog,
  type RegisteredBenchmarkSourceImportGrant,
} from "./verification-benchmark-source-import.js";
import {
  VerificationSealPolicyCatalog,
  type VerificationSealPolicyGrant,
} from "../admission/verification-seal-policy.js";

const schema = z.strictObject({
  schemaVersion: z.literal("verification-benchmark-runtime.v1"),
  tenantId: UuidSchema,
  inputs: z.array(z.unknown()).min(1).max(16),
  profiles: z.array(z.unknown()).min(1).max(16),
  replays: z.array(z.unknown()).min(1).max(16),
  sources: z.array(z.unknown()).min(1).max(16),
  policies: z.array(z.unknown()).min(1).max(16),
  runtime: VerificationBenchmarkPublicationManifestSchema.shape.runtime.omit({ attemptId: true }),
});

/** Trusted configuration only. This checks catalog coverage, not live artifact availability. */
export function parseVerificationBenchmarkRuntimeConfig(raw: string) {
  if (new TextEncoder().encode(raw).byteLength > 1_048_576) throw new Error("BENCHMARK_RUNTIME_CONFIG_TOO_LARGE");
  const value = deepFreeze(schema.parse(JSON.parse(raw)));
  for (const grant of [...value.inputs, ...value.profiles, ...value.replays, ...value.sources, ...value.policies]) {
    if (!grant || typeof grant !== "object" || !("tenantId" in grant) || grant.tenantId !== value.tenantId)
      throw new Error("BENCHMARK_RUNTIME_GRANT_TENANT_MISMATCH");
  }
  if (
    value.runtime.dirtyStateArtifact?.tenantId !== undefined &&
    value.runtime.dirtyStateArtifact.tenantId !== value.tenantId
  )
    throw new Error("BENCHMARK_RUNTIME_CODE_TENANT_MISMATCH");
  if (value.runtime.dirty && !value.runtime.dirtyStateArtifact)
    throw new Error("BENCHMARK_RUNTIME_DIRTY_SNAPSHOT_REQUIRED");
  const inputs = new OfflineBenchmarkInputCatalog(value.inputs as OfflineBenchmarkInputGrant[]);
  const profiles = new RegisteredBenchmarkProfileCatalog(value.profiles as RegisteredBenchmarkProfileGrant[]);
  const replays = new RegisteredBenchmarkReplayCatalog(value.replays as RegisteredBenchmarkReplayGrant[]);
  const sources = new RegisteredBenchmarkSourceImportCatalog(value.sources as RegisteredBenchmarkSourceImportGrant[]);
  const policies = new VerificationSealPolicyCatalog(value.policies as VerificationSealPolicyGrant[]);
  if (
    value.inputs.length !== value.profiles.length ||
    value.inputs.length !== value.replays.length ||
    value.inputs.length !== value.sources.length
  )
    throw new Error("BENCHMARK_RUNTIME_GRANT_COVERAGE_INVALID");
  for (const grant of value.inputs as OfflineBenchmarkInputGrant[]) {
    const request = RunBenchmarkRequestSchema.parse({
      verificationContractVersion: "verification.v1",
      dataset: grant.dataset,
      experimentDefinition: grant.experiment,
      executionMode: "offline_recorded",
    });
    inputs.resolve(value.tenantId, request);
    profiles.resolve(value.tenantId, grant.dataset, grant.experiment);
    replays.resolve(value.tenantId, grant.dataset, grant.experiment);
    sources.resolve(value.tenantId, grant.dataset, grant.experiment);
  }
  if (
    !(value.policies as VerificationSealPolicyGrant[]).some((grant) => grant.policyVersion === "diagnostics-policy.v1")
  )
    throw new Error("BENCHMARK_RUNTIME_POLICY_GRANT_REQUIRED");
  return Object.freeze({
    tenantId: value.tenantId,
    runtime: value.runtime,
    inputs,
    profiles,
    replays,
    sources,
    policies,
  });
}
