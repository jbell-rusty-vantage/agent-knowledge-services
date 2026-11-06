import { z } from "zod";

/**
 * The BKS wire contracts this binding produces or consumes (published by BKS as JSON Schemas under
 * `biotech/biotech-knowledge-services/packages/contracts/json-schema/`; KS never imports BKS TypeScript). Only the
 * fields the binding reads are modelled; responses are parsed leniently (unknown fields kept out of the typed view)
 * and every digest is recomputed over the raw response JSON.
 */
export const ADMISSION_DISPATCH_V1 = "biotech-knowledge-admission.v1" as const;
export const ADMISSION_ACK_V1 = "biotech-knowledge-admission-ack.v1" as const;
export const ADMISSION_CONSUME_REQUEST_V1 = "biotech-knowledge-admission-consume-request.v1" as const;
export const ADMISSION_CONSUME_REPORT_V1 = "biotech-knowledge-admission-consume.v1" as const;
export const INTENT_MARKER_V2 = "bks-intent-marker.v2" as const;
export const INTENT_V2 = "biotech-knowledge-intent.v2" as const;
export const ADMISSION_PAYLOAD_MEDIA_TYPE = "application/vnd.belllabs.biotech-knowledge-admission.v1+json" as const;
export const TARGET_BINDING = "biotech-graph" as const;
export const READ_INTENT_V3 = "biotech-knowledge-read-intent.v3" as const;
export const READ_RESULT_V3 = "biotech-knowledge-read-result.v3" as const;
export const ELIGIBILITY_V1 = "bks-read-eligibility.v1" as const;
export const READ_RESULT_DIGEST_V2 = "bks-read-result-digest.v2" as const;
export const BKS_MARKER_DIGEST_V1 = "bks-intent-marker-digest.v1" as const;
/** The component's expected-marker scheme (knowledge_verification 2.2.0 `dispatch_outbox.marker_scheme`). */
export const KS_MARKER_SCHEME = "ks-intent-marker.v1" as const;

export const BIOTECH_REPORT_KINDS = ["evidence_report", "study_appraisal"] as const;
export type BiotechReportKind = (typeof BIOTECH_REPORT_KINDS)[number];
export const GRAPH_REPORT_KIND: Record<BiotechReportKind, string> = {
  evidence_report: "EVIDENCE_REPORT",
  study_appraisal: "STUDY_APPRAISAL",
};
/** Run seal kinds the admission payload accepts (BKS `AdmissionRunRef.sealKind`). */
export const PAYLOAD_SEAL_KINDS = ["verification_snapshot", "decision_snapshot", "admission_snapshot"] as const;
export type PayloadSealKind = (typeof PAYLOAD_SEAL_KINDS)[number];

const DigestText = z.string().regex(/^sha256:[0-9a-f]{64}$/);

export interface CustodyRef {
  readonly role: "report_body" | "report_structured_body" | "report_ledger" | "evidence_bundle";
  readonly digest: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly locator: {
    readonly kind: "inline" | "bucket" | "volume" | "external";
    readonly artifactId: string;
    readonly uri: string | null;
  };
}

/** biotech-knowledge-admission.v1: the dispatch payload KS stores as the inline artifact_custody row of the dispatch. */
export interface AdmissionPayload {
  readonly schemaVersion: typeof ADMISSION_DISPATCH_V1;
  readonly tenantId: string;
  readonly installationId: string;
  readonly applicationId: string;
  readonly targetBinding: typeof TARGET_BINDING;
  readonly dispatchId: string;
  readonly effectKey: string;
  readonly boundEffectDigest: string;
  readonly semanticPayloadDigest: string;
  readonly originatingOriginDigest: string;
  readonly useDecision: { readonly id: string; readonly digest: string };
  readonly report: {
    readonly reportRevisionId: string;
    readonly reportId: string;
    readonly revision: number;
    readonly reportKind: BiotechReportKind;
    readonly reportKindRef: string;
    readonly reportSchema: string;
    readonly digest: string;
  } | null;
  readonly run: { readonly runId: string; readonly manifestDigest: string; readonly sealKind: PayloadSealKind };
  readonly revocationEpochAtDecision: number;
  readonly decidedAt: string;
  readonly intent: Record<string, unknown>;
  readonly custody: readonly CustodyRef[];
  readonly expectedMarkerSchemaVersion: typeof INTENT_MARKER_V2;
}

export const DispatchOutcomeSchema = z.enum(["applied", "duplicate", "revoked", "refused", "deferred"]);
export type DispatchOutcome = z.infer<typeof DispatchOutcomeSchema>;

export const AcknowledgmentSchema = z.object({
  schemaVersion: z.literal(ADMISSION_ACK_V1),
  tenantId: z.string(),
  dispatchId: z.string(),
  effectKey: z.string(),
  outcome: DispatchOutcomeSchema,
  markerDigest: DigestText.nullable(),
  payloadDigest: DigestText.nullable(),
  planDigest: DigestText.nullable(),
  receiptId: z.string().nullable(),
  graph: z.object({
    bookmark: z.string().nullable(),
    graphRevision: z.number().int().nullable(),
    markerKey: z.string().nullable(),
  }),
  appliedAt: z.string().nullable(),
  componentState: z.enum(["pending", "dispatched", "acknowledged", "failed", "revoked"]).nullable(),
  acknowledged: z.boolean(),
  reason: z.object({ code: z.string(), message: z.string() }).nullable(),
  retryAfterSeconds: z.number().int().nullable(),
  processedAt: z.string(),
});
export type Acknowledgment = z.infer<typeof AcknowledgmentSchema>;

export const ConsumeReportSchema = z.object({
  schemaVersion: z.literal(ADMISSION_CONSUME_REPORT_V1),
  tenantId: z.string(),
  claimed: z.number().int().nonnegative(),
  results: z.array(AcknowledgmentSchema),
  startedAt: z.string(),
  finishedAt: z.string(),
});
export type ConsumeReport = z.infer<typeof ConsumeReportSchema>;

/**
 * bks-read-values.v1 decoding of scalar row values: integral numbers written by a JavaScript driver are stored as
 * Neo4j Floats and read back as {"$type":"Float","value":"<digits>"}; large integers as {"$type":"Integer","value"};
 * temporal values as {"$type":"DateTime","value":"<instant>"}.
 */
function readValue(v: unknown): unknown {
  if (v !== null && typeof v === "object" && "$type" in v && "value" in v) {
    const typed = v as { $type: string; value: unknown };
    if ((typed.$type === "Float" || typed.$type === "Integer") && typeof typed.value === "string")
      return Number(typed.value);
    if (typeof typed.value === "string") return typed.value;
  }
  return v;
}
const ReadInt = z.preprocess(readValue, z.number().int());
const ReadText = z.preprocess(readValue, z.string());

/** bks-intent-marker.v2 as the v3 `marker` read projects it. */
export const MarkerSchema = z.object({
  markerKey: z.string(),
  effectKey: z.string(),
  status: z.string(),
  intentDigest: z.string().nullable().optional(),
  planRef: z.string().nullable().optional(),
  planDigest: DigestText.nullable().optional(),
  receiptId: z.string().nullable().optional(),
  graphRevision: ReadInt.nullable().optional(),
  markerSchemaVersion: z.string().nullable().optional(),
  dispatchId: z.string().nullable().optional(),
  markerDigest: DigestText.nullable().optional(),
  payloadDigest: DigestText.nullable().optional(),
  boundEffectDigest: DigestText.nullable().optional(),
  useDecisionRef: z.string().nullable().optional(),
  useDecisionDigest: DigestText.nullable().optional(),
  revocationEpoch: ReadInt.nullable().optional(),
  appliedAt: ReadText.nullable().optional(),
});
export type Marker = z.infer<typeof MarkerSchema>;

export const EligibilityItemSchema = z.object({
  opId: z.string(),
  recordUid: z.string(),
  useDecisionId: z.string().nullable(),
  useDecisionDigest: DigestText.nullable(),
  state: z.enum(["eligible", "revoked", "stale", "unadmitted", "authority_unavailable"]),
  served: z.boolean(),
  reason: z.string().nullable(),
  decisionEpoch: z.number().int().nullable(),
  disposition: z.string().nullable(),
  expiresAt: z.string().nullable(),
});

export const EligibilitySchema = z.object({
  format: z.literal(ELIGIBILITY_V1),
  checkedAt: z.string(),
  authoritativeEpoch: z.number().int().nullable(),
  decisionEpoch: z.number().int().nullable(),
  state: z.enum(["eligible", "revoked", "stale", "authority_unavailable"]),
  authority: z.object({ available: z.boolean() }).passthrough(),
  items: z.array(EligibilityItemSchema),
  excluded: z.number().int().nonnegative(),
  held: z.number().int().nonnegative(),
});
export type Eligibility = z.infer<typeof EligibilitySchema>;

export const ReadPartSchema = z.object({
  opId: z.string(),
  op: z.string(),
  status: z.string(),
  reasons: z.array(z.object({ code: z.string(), message: z.string() }).passthrough()),
  columns: z.array(z.string()),
  rows: z.array(z.record(z.string(), z.unknown())),
  rowCount: z.number().int(),
  truncations: z.array(z.unknown()),
});

export const ReadResultV3Schema = z.object({
  schemaVersion: z.literal(READ_RESULT_V3),
  intentId: z.string(),
  intentKind: z.literal(READ_INTENT_V3),
  status: z.string(),
  reasons: z.array(z.unknown()),
  parts: z.array(ReadPartSchema),
  ordering: z.string(),
  pins: z.object({ releaseId: z.string(), schemaReleaseDigest: DigestText }).passthrough(),
  digests: z.object({ queryDigest: DigestText, resultDigest: DigestText, receiptDigest: DigestText }),
  use: z.object({ officialUse: z.boolean(), useName: z.string().nullable(), audience: z.string().nullable() }),
  eligibility: EligibilitySchema.nullable(),
});
export type ReadResultV3 = z.infer<typeof ReadResultV3Schema>;
