import {
  type BindingDescriptor,
  BindingDescriptorSchema,
  PROTOCOL_VERSION,
} from "@aiengineer/knowledge-operation-protocol";
import { BIOTECH_REPORT_KINDS, INTENT_V2, TARGET_BINDING } from "./contracts.js";

/** BKS biotech-schema-v2.2.0 release digest (BKS `GET /describe`; pinned on 2026-10-25 by SV-11). */
export const BIOTECH_SCHEMA_RELEASE_V2_2_0 = "sha256:2df9d3bc0548b92d317fc27ee1e3283fb6326a15709f199457423b6d9b025a74";

/**
 * What the Biotech graph binding advertises (K01 `BindingDescriptor`): outbox delivery (`marker_plus_outbox`: the graph
 * effect and its marker are one Neo4j transaction, PostgreSQL and Neo4j are not), exact-revision reads, no native
 * cancellation (stop-dispatch plus reconciliation), exact-use admission with epoch-checked revocation, both K08 report
 * kinds. Qualification receipts are supplied by the caller from recorded proofs; declaring a capability never
 * qualifies it.
 */
export function biotechGraphDescriptor(input: {
  readonly describedAt: string;
  readonly schemaReleaseDigest?: string;
  readonly signingIssuer?: string;
  readonly qualification?: BindingDescriptor["qualification"];
}): BindingDescriptor {
  return BindingDescriptorSchema.parse({
    protocolVersions: [PROTOCOL_VERSION],
    binding: TARGET_BINDING,
    application: "biotech",
    coreSchemas: [
      "research-core.task.v2",
      "research-core.assertion.v2",
      "research-core.fragment.v2",
      "research-core.support_set.v2",
      "research-core.observation.v2",
      "research-report.v2",
      "research-core.run_manifest.v2",
      "research-core.use_decision.v2",
      "research-core.report_assessment.v1",
    ],
    operations: [
      "knowledge.describe",
      "knowledge.read",
      "knowledge.apply",
      "report.register",
      "report.assess",
      "operation.get",
      "operation.cancel",
      "receipt.get",
    ],
    auditorKind: "independent",
    reportKinds: [...BIOTECH_REPORT_KINDS],
    media: ["markdown", "json"],
    guarantees: {
      exactRead: "exact_revision",
      receiptLookup: "by_effect_key",
      nativeCancellation: "stop_dispatch_and_reconcile",
      admission: "exact_use_decision",
      revocation: "epoch_checked",
      writeAtomicity: "marker_plus_outbox",
    },
    signingIssuer: input.signingIssuer ?? "knowledge-services",
    pinnedSchema: {
      name: "biotech-schema",
      version: INTENT_V2,
      digest: input.schemaReleaseDigest ?? BIOTECH_SCHEMA_RELEASE_V2_2_0,
    },
    qualification: input.qualification ?? [],
    describedAt: input.describedAt,
  });
}
