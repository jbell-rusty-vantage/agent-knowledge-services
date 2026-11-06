// Ports knowledge-db owns and consumes. Persistence implements them (`TenantPostgres` is a
// `KnowledgeDatabase`, `postgresContentAdmission` a `ContentAdmission`) and the composition root injects
// them, so knowledge-db has no production dependency on persistence (FINAL-REVIEW R1).

/** One result row. Values are `any`, as in the driver, so row interfaces without an index signature fit. */
export type KnowledgeSqlRow = { [column: string]: any };

/** A client bound to one open tenant-scoped transaction. */
export interface KnowledgeSqlClient {
  query<R extends KnowledgeSqlRow = KnowledgeSqlRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
}

/** Bounded database roles a transaction may switch to with `set local role`. */
export type KnowledgeRole = "app_reader" | "pipeline_agent" | "executor_service" | "verifier_agent" | "control_plane";

export interface KnowledgeTransactionScope {
  readonly tenantId: string;
  readonly role?: KnowledgeRole;
  readonly readOnly?: boolean;
  readonly isolationLevel?: "read committed" | "repeatable read";
  readonly statementTimeoutMs?: number;
}

/** Runs `work` in one transaction under the scope's tenant, role and read-only/timeout settings; rolls back on failure. */
export interface KnowledgeTransactions {
  transaction<T>(scope: KnowledgeTransactionScope, work: (client: KnowledgeSqlClient) => Promise<T>): Promise<T>;
}

/** Transactions plus the applied migration head, which bounded reads compare with the workspace head. */
export interface KnowledgeDatabase extends KnowledgeTransactions {
  migrationHead(): Promise<string | undefined>;
}

export interface ContentRepresentationAdmission {
  readonly accepted: boolean;
  readonly decisionId: string | null;
  readonly decision: string | null;
}

interface ArtifactReference {
  readonly id: string;
  readonly digest: string;
}
export interface PreparedContentSummaryInput {
  readonly tenantId: string;
  readonly missionId: string;
  readonly attemptId: string;
  readonly transformationRunId: string;
  readonly representationId: string;
  readonly documentVersionId: string;
  readonly inputRepresentationId: string;
  readonly inputArtifact: ArtifactReference;
  readonly outputArtifact: ArtifactReference;
  readonly receiptArtifact: ArtifactReference;
  readonly requestDigest: string;
  readonly language?: string;
}

/**
 * Canonical content-representation admission and summary persistence, run inside the caller's transaction.
 * Members are function-typed properties so an adapter's parameters are checked strictly, not bivariantly.
 */
export interface ContentAdmission {
  /** The latest independent decision on an immutable representation; only an accepted one admits its bytes. */
  readonly readRepresentationAdmission: (
    client: KnowledgeSqlClient,
    input: {
      readonly tenantId: string;
      readonly representationId: string;
      readonly guardedDigest: string;
    },
  ) => Promise<ContentRepresentationAdmission>;
  /** Persists a completed deterministic summary rendering; its acceptance stays pending until independent review. */
  readonly persistPreparedSummary: (client: KnowledgeSqlClient, input: PreparedContentSummaryInput) => Promise<void>;
}
