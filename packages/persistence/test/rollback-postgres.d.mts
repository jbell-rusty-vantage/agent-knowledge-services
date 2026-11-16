export interface RollbackTransactionScope {
  readonly tenantId: string;
  readonly role?: "app_reader" | "pipeline_agent" | "executor_service" | "verifier_agent" | "control_plane";
  readonly readOnly?: boolean;
  readonly isolationLevel?: "read committed" | "repeatable read";
  readonly statementTimeoutMs?: number;
}

export interface RollbackSqlClient {
  // biome-ignore lint/suspicious/noExplicitAny: driver rows are untyped, as in the knowledge-db port
  query<R extends { [column: string]: any } = { [column: string]: any }>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
}

/** Savepoint-per-scope `KnowledgeDatabase` whose outer transaction `close()` rolls back; see rollback-postgres.mjs. */
export class RollbackPostgres {
  static open(config: string | { readonly connectionString: string }): Promise<RollbackPostgres>;
  /** The one connection, as the login role, for fixture rows inserted inside the outer transaction. */
  readonly client: RollbackSqlClient;
  transaction<T>(scope: RollbackTransactionScope, work: (client: RollbackSqlClient) => Promise<T>): Promise<T>;
  migrationHead(): Promise<string | undefined>;
  close(): Promise<void>;
}
