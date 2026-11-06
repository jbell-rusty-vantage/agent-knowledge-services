import type { VerificationArtifactHandle } from "@aiengineer/knowledge-contracts";
import { digestCanonicalJson } from "@aiengineer/knowledge-verification";

export const EXECUTOR_STORAGE_PROFILE = Object.freeze({
  schemaVersion: "knowledge-storage-profile.v1",
  profileId: "pre-mission-control.v1",
  maximumArtifactBytes: 64_000_000,
  captures: { bucket: "ai-engineer-cloud-bucket", bucketClass: "source_captures" },
  intermediate: { bucket: "ai-engineer-cloud-bucket", bucketClass: "candidate" },
  ledger: { bucket: "research-ingestion-intents", bucketClass: "ledger" },
  reports: { bucket: "research-reports", bucketClass: "candidate" },
  retention: "retain-while-referenced.v1",
} as const);

export const EXECUTOR_STORAGE_PROFILE_DIGEST = digestCanonicalJson(EXECUTOR_STORAGE_PROFILE);

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  "verification-bundle": "verification_bundle",
  "deterministic-verification-result": "deterministic_verification_result",
  "verification-extraction-result": "verification_extraction_candidate",
  "provider-request": "verification_provider_request",
  "provider-response": "verification_provider_raw_response",
  "verification-semantic-assessments": "verification_report_ledger",
  "verification-policy": "verification_policy",
  "verification-policy-inputs": "verification_policy_inputs",
  "verification-policy-decision": "verification_policy_decision",
  "verification-report-check": "verification_report_result",
  "verification-run-manifest": "verification_run_manifest",
  "verification-audit-bundle": "verification_audit_bundle",
};

export function artifactDestination(handle: VerificationArtifactHandle) {
  if (/^verification-executor:capture(?:_original)?(?::[0-9a-f]{64})?$/.test(handle.producerActivityId)) {
    return { ...EXECUTOR_STORAGE_PROFILE.captures, artifactType: "source_capture" };
  }
  const kind = /^application\/vnd\.aiengineer\.([^+]+)\+json$/.exec(handle.mediaType)?.[1];
  return {
    ...EXECUTOR_STORAGE_PROFILE.intermediate,
    artifactType: kind ? (MEDIA_TYPES[kind] ?? "workspace_file") : "workspace_file",
  };
}
