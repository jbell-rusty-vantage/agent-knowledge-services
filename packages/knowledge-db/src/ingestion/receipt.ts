import type { Digest } from "../db-read/index.js";
import type { PlannedOutcome, ProposalOutcome } from "./plan.js";

/** `knowledge-ingestion-receipt.v1` — backed by `orchestration.operation_receipt` plus `temporal.knowledge_batch`. */

export interface ProposalReceipt {
  readonly proposalId: string;
  readonly outcome: ProposalOutcome;
  readonly created?: Readonly<Record<string, string | readonly string[]>>;
  readonly existing?: Readonly<Record<string, unknown>>;
  readonly supersedes?: readonly string[];
  readonly reason?: string;
  readonly noop?: boolean;
}

export interface ReceiptFailure {
  readonly code: string;
  readonly message: string;
  readonly sqlstate?: string;
  readonly details?: unknown;
  readonly whatChanged?: readonly unknown[];
  readonly touchedBy?: readonly string[];
}

export interface AffectedRef {
  readonly schema: string;
  readonly table: string;
  readonly id: string;
}

export type ReceiptTargetRole = "subject" | "canonical" | "supporting" | "provenance" | "staging" | "projection";
export type ReceiptTargetAction = "created" | "reused" | "superseded" | "staged";

/**
 * One native row this receipt created, reused (already present, not rewritten), superseded (closed) or staged, as
 * written to `orchestration.operation_receipt_target` (AIDB 20261031010000). Unlike `affectedRefs` (the K01 effect
 * receipt payload, unchanged), targets name the proposal that touched the row, include reused rows, and carry the
 * entity (id and kind, from `corpus.entity`) and the evidence claim when the row has one. Composite ids are JSON tuples.
 */
export interface ReceiptTarget {
  readonly schema: string;
  readonly table: string;
  readonly id: string;
  readonly role: ReceiptTargetRole;
  readonly action: ReceiptTargetAction;
  readonly proposalId: string | null;
  readonly entityId: string | null;
  readonly entityKind: string | null;
  readonly claimId: string | null;
}

/** The `research.report_v2_*` projection an AI Engineer exact-use apply wrote (aidb_guard path only). */
export interface ReceiptReportProjection {
  readonly reportId: string;
  readonly revision: number;
  readonly reportRevisionId: string;
  readonly reportRevisionDigest: string;
  readonly runId: string;
  readonly verificationSnapshotDigest: string;
  readonly useDecisionId: string;
  readonly subjectKind: "report" | "assertion";
  /** Present for an assertion-subject decision: the assertion ref digest the ingestion row names. */
  readonly assertionRefDigest: string | null;
  /** How the revision was chosen: the decision names it, or the latest revision citing the decided assertion. */
  readonly resolution: "report_subject" | "latest_revision_citing_assertion";
  /** Revisions citing the decided assertion (1 for a report subject); more than one means the choice above was made. */
  readonly candidateRevisions: number;
  readonly assertions: number;
}

export interface IngestionReceipt {
  readonly schemaVersion: "knowledge-ingestion-receipt.v1";
  readonly receiptId: string;
  readonly operationIntentId: string;
  readonly intentRef: {
    readonly intentId: string;
    readonly intentDigest: Digest;
    readonly idempotencyKey: Digest;
  };
  readonly planRef: { readonly planId: string; readonly artifactId?: string };
  readonly outcome: PlannedOutcome;
  readonly knowledgeBatch: {
    readonly knowledgeSeq: number;
    readonly inputDigest: string;
  } | null;
  readonly head: {
    readonly before: number;
    readonly after: number;
    readonly rebased: boolean;
  };
  readonly proposals: readonly ProposalReceipt[];
  readonly subjects: readonly {
    ref: string;
    entityId: string | null;
    created: boolean;
  }[];
  readonly claims: readonly {
    runId: string;
    claimId: string;
    claimRowId: string | null;
  }[];
  readonly affectedRefs: readonly AffectedRef[];
  /** Additive (v1): normalized targets as written to `orchestration.operation_receipt_target`; absent on older receipts. */
  readonly targets?: readonly ReceiptTarget[];
  /** Additive (v1): the report_v2 projection written by an AI Engineer exact-use apply. */
  readonly report?: ReceiptReportProjection | null;
  readonly duplicateOf: string | null;
  readonly priorReceiptsForIntentId: readonly string[];
  readonly failure: ReceiptFailure | null;
  readonly storage: {
    readonly intentArtifactId?: string;
    readonly planArtifactId?: string;
    readonly receiptArtifactId?: string;
    readonly storageState: "stored" | "pending" | "none";
    readonly lineage?: "written" | "denied";
  };
  readonly verify: { readonly suggestedReadIntent: unknown } | null;
  readonly executedAt: string;
  readonly executorVersion: string;
}
