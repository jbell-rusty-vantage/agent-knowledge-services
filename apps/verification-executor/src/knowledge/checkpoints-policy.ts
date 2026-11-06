import { digestCanonicalJson } from "@aiengineer/knowledge-verification";
import { EXECUTOR_STORAGE_PROFILE, EXECUTOR_STORAGE_PROFILE_DIGEST } from "../store-custody-profile.js";

export const CHECKPOINT_RETENTION_POLICY = Object.freeze({
  policyId: "retain-while-referenced.v1",
  minimumOrphanAgeSeconds: 2_592_000,
  retainHistoricalCheckpoints: true,
  retainLineage: true,
});
export const CHECKPOINT_CAPABILITY_PROFILE = Object.freeze({
  profileId: "standalone-checkpoints.v1",
  stateSchema: "executor-checkpoint-state.v1",
  allowedRoots: [
    "inputs",
    "discovery",
    "captures",
    "claims",
    "reports",
    "ingestion",
    "retrieval",
    "notes",
    "drafts",
    "gaps",
    "manifest.json",
    "handoff.md",
    "00-plan.md",
    "10-captures.md",
    "20-quote-ledger.md",
    "30-claims-intent.json",
    "40-extraction-intent.json",
    "50-report.md",
    "60-report-intent.json",
    "70-run-summary.md",
  ],
  maximumFiles: 2_000,
  maximumBytes: 64_000_000,
  maximumClosureArtifacts: 10_000,
  maximumClosureBytes: 256_000_000,
  maximumManifestBytes: 16_000_000,
});
export const CHECKPOINT_PROFILE_PINS = Object.freeze({
  storageProfileVersion: EXECUTOR_STORAGE_PROFILE.profileId,
  storageProfileDigest: EXECUTOR_STORAGE_PROFILE_DIGEST,
  retentionPolicyVersion: CHECKPOINT_RETENTION_POLICY.policyId,
  retentionPolicyDigest: digestCanonicalJson(CHECKPOINT_RETENTION_POLICY),
  capabilityProfileVersion: CHECKPOINT_CAPABILITY_PROFILE.profileId,
  capabilityProfileDigest: digestCanonicalJson(CHECKPOINT_CAPABILITY_PROFILE),
});
export const CHECKPOINT_POLICY = Object.freeze({
  profilePins: CHECKPOINT_PROFILE_PINS,
  allowedRoots: CHECKPOINT_CAPABILITY_PROFILE.allowedRoots,
  maximumFiles: CHECKPOINT_CAPABILITY_PROFILE.maximumFiles,
  maximumBytes: CHECKPOINT_CAPABILITY_PROFILE.maximumBytes,
  maximumClosureArtifacts: CHECKPOINT_CAPABILITY_PROFILE.maximumClosureArtifacts,
  maximumClosureBytes: CHECKPOINT_CAPABILITY_PROFILE.maximumClosureBytes,
  maximumManifestBytes: CHECKPOINT_CAPABILITY_PROFILE.maximumManifestBytes,
});
