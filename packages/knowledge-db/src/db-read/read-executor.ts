import type { KnowledgeRole, KnowledgeDatabase, KnowledgeSqlClient } from "../ports.js";
import {
  assertHeadMatches,
  domainError,
  infrastructureError,
  requireCatalog,
  type CatalogEntry,
  type QueryCatalog,
  type Workspace,
} from "../schema-workspace/index.js";
import type { ArtifactLedger } from "./artifacts.js";
import { digestOf, type Digest } from "./canonical.js";
import { bindKnowledgeClock, snapshotDigest } from "./snapshot.js";
import { applyDefaults, validateSchema } from "./json-schema.js";
import {
  MAX_STATEMENT_TIMEOUT_MS,
  ReadIntentSchema,
  type KnowledgeHead,
  type OperationResult,
  type ReadIntent,
  type ReadOperation,
  type ReadSnapshot,
} from "./read-intent.js";
import { resolveReferences } from "./references.js";
import { jsonSafeRow, type Row } from "./rows.js";
import { assertSingleReadStatement } from "./sql-guard.js";
import { uuidv7 } from "./uuid.js";

export interface ReadExecutorConfig {
  readonly db: KnowledgeDatabase;
  readonly workspace: Workspace;
  readonly artifacts?: ArtifactLedger;
  readonly executorVersion: string;
  /** Experiments only: run even when the workspace head ≠ database head. Recorded in every snapshot. */
  readonly allowStale?: boolean;
}

export interface RunIntentOptions {
  readonly persist?: boolean;
}

export interface SqlReadInput {
  readonly tenantId: string;
  readonly sql: string;
  readonly params?: readonly unknown[];
  readonly limit?: number;
  readonly statementTimeoutMs?: number;
}

export interface SqlReadResult {
  readonly columns: readonly string[];
  readonly rows: readonly Row[];
  readonly rowCount: number;
  readonly truncated: boolean;
  readonly role: KnowledgeRole;
  readonly knowledgeHead: KnowledgeHead;
  readonly contentDigest: Digest;
  readonly durationMs: number;
}

const HEAD_SQL = "select knowledge_seq, updated_at from api.knowledge_head()";
const SQL_SURFACE_ROLE: KnowledgeRole = "pipeline_agent";
const DEFAULT_SQL_LIMIT = 200;
const INLINE_ARTIFACT_MAX_BYTES = 256_000;
const ROLE_RANK: Record<string, number> = { app_reader: 0, pipeline_agent: 1 };

const wrapWithCap = (sql: string, cap: number): string =>
  `select * from (${sql.trim().replace(/;\s*$/, "")}) knowledge_q limit ${cap + 1}`;

export class ReadExecutor {
  constructor(private readonly config: ReadExecutorConfig) {}

  get workspace(): Workspace {
    return this.config.workspace;
  }

  catalog(): QueryCatalog {
    return requireCatalog(this.config.workspace);
  }

  async databaseHead(): Promise<string | undefined> {
    try {
      return await this.config.db.migrationHead();
    } catch (error) {
      throw infrastructureError("DB_UNAVAILABLE", error instanceof Error ? error.message : String(error));
    }
  }

  async head(tenantId: string): Promise<KnowledgeHead> {
    return this.config.db.transaction({ tenantId, role: "app_reader", readOnly: true }, (client) => readHead(client));
  }

  /** Static validation only: schema, catalog membership, params, role lattice, limits. Touches no database. */
  validateIntent(raw: unknown): ReadIntent {
    const parsed = ReadIntentSchema.safeParse(raw);
    if (!parsed.success)
      throw domainError("INTENT_SCHEMA_INVALID", "read intent does not match knowledge-read-intent.v1", {
        issues: parsed.error.issues,
      });
    const intent = parsed.data;
    const catalog = this.catalog();
    if (intent.contract?.migrationHead && intent.contract.migrationHead !== this.config.workspace.migrationHead)
      throw infrastructureError("WORKSPACE_STALE", "intent.contract.migrationHead ≠ executor workspace head", {
        intent: intent.contract.migrationHead,
        workspace: this.config.workspace.migrationHead,
      });
    if (
      intent.contract?.workspaceFingerprint &&
      this.config.workspace.fingerprint &&
      intent.contract.workspaceFingerprint !== this.config.workspace.fingerprint
    )
      throw infrastructureError(
        "WORKSPACE_STALE",
        "intent.contract.workspaceFingerprint ≠ executor workspace fingerprint",
      );
    if (intent.limits?.statementTimeoutMs && intent.limits.statementTimeoutMs > MAX_STATEMENT_TIMEOUT_MS)
      throw domainError("LIMITS_EXCEEDED", "statementTimeoutMs above executor maximum");
    const seen = new Set<string>();
    for (const operation of intent.operations) {
      if (seen.has(operation.opId)) throw domainError("INTENT_SCHEMA_INVALID", `duplicate opId ${operation.opId}`);
      seen.add(operation.opId);
      if (operation.kind === "artifact") continue;
      const entry = findEntry(catalog, operation.query);
      if (operation.role && (ROLE_RANK[operation.role] ?? 0) > (ROLE_RANK[entry.role] ?? 0))
        throw domainError(
          "ROLE_DENIED",
          `${operation.opId}: role ${operation.role} exceeds catalog role ${entry.role}`,
        );
      if (operation.limit && operation.limit > catalog.defaults.maxLimit)
        throw domainError("LIMITS_EXCEEDED", `${operation.opId}: limit above ${catalog.defaults.maxLimit}`);
      if (!Object.values(operation.params).some((value) => typeof value === "string" && value.startsWith("$")))
        assertParams(entry, applyDefaults(entry.params, operation.params), operation.opId);
    }
    return intent;
  }

  async runIntent(raw: unknown, options: RunIntentOptions = {}): Promise<ReadSnapshot> {
    const intent = this.validateIntent(raw);
    const headCheck = assertHeadMatches(
      this.config.workspace,
      await this.databaseHead(),
      this.config.allowStale ?? false,
    );
    const catalog = this.catalog();
    const timeoutFor = (entry: CatalogEntry): number =>
      Math.min(
        intent.limits?.statementTimeoutMs ?? Number.MAX_SAFE_INTEGER,
        catalog.defaults.statementTimeoutMs[entry.cost_class] ?? 15_000,
      );
    const executedAt = new Date().toISOString();
    const artifactResults = await this.artifactOperations(intent);
    const run = await this.config.db.transaction(
      { tenantId: intent.context.tenantId, readOnly: true, isolationLevel: "repeatable read" },
      async (client) => {
        await setRole(client, "app_reader");
        const before = await readHead(client);
        const atKnowledgeSeq = intent.atKnowledgeSeq ?? before.knowledgeSeq;
        if (atKnowledgeSeq > before.knowledgeSeq)
          throw domainError(
            "HEAD_MISMATCH",
            `atKnowledgeSeq ${atKnowledgeSeq} is ahead of the tenant head ${before.knowledgeSeq}`,
          );
        const completed = new Map<string, OperationResult>(artifactResults.map((result) => [result.opId, result]));
        const results: OperationResult[] = [];
        for (const [index, operation] of intent.operations.entries()) {
          const result =
            operation.kind === "artifact"
              ? completed.get(operation.opId)!
              : await this.runQueryOperation(client, {
                  operation,
                  index,
                  intent,
                  catalog,
                  completed,
                  timeoutFor,
                  atKnowledgeSeq,
                  currentKnowledgeSeq: before.knowledgeSeq,
                });
          completed.set(operation.opId, result);
          results.push(result);
        }
        await setRole(client, "app_reader");
        const after = await readHead(client);
        if (before.knowledgeSeq !== after.knowledgeSeq)
          throw domainError(
            "SNAPSHOT_HEAD_CHANGED",
            "Knowledge head changed inside the snapshot; retry the read intent",
          );
        return { before, after, atKnowledgeSeq, results };
      },
    );
    const intentDigest = digestOf(raw);
    const snapshot: ReadSnapshot = {
      schemaVersion: "knowledge-read-snapshot.v1",
      snapshotId: uuidv7(),
      intentRef: { intentId: intent.intentId, intentDigest },
      context: { ...intent.context, executorVersion: this.config.executorVersion },
      contract: {
        migrationHead: this.config.workspace.migrationHead,
        ...(this.config.workspace.fingerprint ? { workspaceFingerprint: this.config.workspace.fingerprint } : {}),
        ...(catalog.catalogVersion ? { catalogVersion: catalog.catalogVersion } : {}),
        ...(headCheck.matches ? {} : { staleWorkspace: headCheck }),
      },
      knowledgeHead: run.before,
      knowledgeHeadAfter: run.after,
      headChanged: run.before.knowledgeSeq !== run.after.knowledgeSeq,
      atKnowledgeSeq: run.atKnowledgeSeq,
      executedAt,
      operations: run.results,
      snapshotDigest: snapshotDigest(run.results, run.atKnowledgeSeq),
    };
    return options.persist ? this.persist(raw, snapshot) : snapshot;
  }

  async sqlReadonly(input: SqlReadInput): Promise<SqlReadResult> {
    const statement = assertSingleReadStatement(input.sql);
    const cap = Math.min(input.limit ?? DEFAULT_SQL_LIMIT, this.catalog().defaults.maxLimit);
    const timeout = Math.min(input.statementTimeoutMs ?? 15_000, MAX_STATEMENT_TIMEOUT_MS);
    return this.config.db.transaction(
      {
        tenantId: input.tenantId,
        role: SQL_SURFACE_ROLE,
        readOnly: true,
        isolationLevel: "repeatable read",
        statementTimeoutMs: timeout,
      },
      async (client) => {
        const knowledgeHead = await readHead(client);
        const started = performance.now();
        const fetched = await runSql(client, wrapWithCap(statement, cap), input.params ?? []);
        const rows = fetched.rows.slice(0, cap);
        return {
          columns: fetched.columns,
          rows,
          rowCount: rows.length,
          truncated: fetched.rows.length > cap,
          role: SQL_SURFACE_ROLE,
          knowledgeHead,
          contentDigest: digestOf(rows),
          durationMs: Math.round(performance.now() - started),
        };
      },
    );
  }

  async explain(
    input: Pick<SqlReadInput, "tenantId" | "sql" | "params">,
  ): Promise<{ plan: unknown; role: KnowledgeRole }> {
    const statement = assertSingleReadStatement(input.sql);
    return this.config.db.transaction(
      { tenantId: input.tenantId, role: SQL_SURFACE_ROLE, readOnly: true, statementTimeoutMs: 15_000 },
      async (client) => {
        const result = await runSql(client, `explain (format json, costs true) ${statement}`, input.params ?? []);
        return { plan: result.rows[0]?.["QUERY PLAN"] ?? result.rows, role: SQL_SURFACE_ROLE };
      },
    );
  }

  private async artifactOperations(intent: ReadIntent): Promise<OperationResult[]> {
    const results: OperationResult[] = [];
    for (const operation of intent.operations) {
      if (operation.kind !== "artifact") continue;
      const started = performance.now();
      if (!this.config.artifacts) {
        results.push(skipped(operation, "ARTIFACTS_UNAVAILABLE", started));
        continue;
      }
      try {
        const fetched = await this.config.artifacts.get(intent.context.tenantId, operation.artifactId);
        if (fetched.json === undefined && fetched.text === undefined) {
          results.push(skipped(operation, "ARTIFACT_BYTES_UNAVAILABLE", started));
          continue;
        }
        const inline = operation.include === "inline" && fetched.record.sizeBytes <= INLINE_ARTIFACT_MAX_BYTES;
        results.push({
          opId: operation.opId,
          kind: "artifact",
          artifactId: operation.artifactId,
          status: "ok",
          rowCount: 1,
          truncated: false,
          ...(inline ? { value: fetched.json ?? fetched.text } : {}),
          contentDigest: fetched.record.digest,
          durationMs: Math.round(performance.now() - started),
        });
      } catch (error) {
        results.push(
          skipped(
            operation,
            error instanceof Error && "code" in error
              ? String((error as { code: unknown }).code)
              : "ARTIFACT_NOT_FOUND",
            started,
          ),
        );
      }
    }
    return results;
  }

  private async runQueryOperation(client: KnowledgeSqlClient, step: QueryStep): Promise<OperationResult> {
    const { operation, intent, catalog, completed } = step;
    const started = performance.now();
    if (operation.kind === "retrieval") return skipped(operation, "RETRIEVAL_UNAVAILABLE", started);
    const entry = findEntry(catalog, operation.query);
    const role: KnowledgeRole = operation.role ?? entry.role;
    const references = resolveReferences(operation.params, completed);
    if (references.unresolved.length > 0)
      return {
        ...skipped(operation, "REF_UNRESOLVED", started),
        query: entry.name,
        role,
        params: operation.params,
        ...(Object.keys(references.resolvedFrom).length ? { resolvedFrom: references.resolvedFrom } : {}),
      };
    const params = bindKnowledgeClock(
      entry,
      applyDefaults(entry.params, references.params),
      step.atKnowledgeSeq,
      step.currentKnowledgeSeq,
    );
    assertParams(entry, params, operation.opId);
    const cap = Math.min(
      operation.limit ?? intent.limits?.maxRowsPerOp ?? catalog.defaults.limit,
      catalog.defaults.maxLimit,
    );
    const positional = entry.paramOrder.map((name) => params[name] ?? null);
    const savepoint = `op_${step.index}`;
    await client.query(`savepoint ${savepoint}`);
    try {
      await setRole(client, role);
      await client.query(`set local statement_timeout = ${step.timeoutFor(entry)}`);
      const fetched = await runSql(client, wrapWithCap(entry.sql, cap), positional);
      await client.query(`release savepoint ${savepoint}`);
      return shapeResult({
        operation,
        entry,
        role,
        params,
        resolvedFrom: references.resolvedFrom,
        fetched,
        cap,
        started,
      });
    } catch (error) {
      await client.query(`rollback to savepoint ${savepoint}`);
      if (error instanceof Error && error.name === "KnowledgeError") throw error;
      const pgError = error as { code?: string; message?: string };
      return {
        opId: operation.opId,
        kind: operation.kind,
        query: entry.name,
        role,
        params,
        status: "error",
        rowCount: 0,
        truncated: false,
        contentDigest: digestOf(null),
        error: { code: pgError.code ?? "SQL_ERROR", message: pgError.message ?? String(error) },
        durationMs: Math.round(performance.now() - started),
        ...(entry.volatile ? { volatile: true } : {}),
      };
    }
  }

  private async persist(raw: unknown, snapshot: ReadSnapshot): Promise<ReadSnapshot> {
    if (!this.config.artifacts)
      throw infrastructureError("ARTIFACTS_UNAVAILABLE", "persist requested but no artifact ledger is configured");
    const ledger = this.config.artifacts;
    const tenantId = snapshot.context.tenantId;
    return this.config.db.transaction({ tenantId, role: "executor_service" }, async (client) => {
      const intentRecord = await ledger.putWith(client, {
        tenantId,
        artifactType: "knowledge_read_intent",
        value: raw,
        ...(snapshot.context.missionId ? { missionId: snapshot.context.missionId } : {}),
      });
      const snapshotRecord = await ledger.putWith(client, {
        tenantId,
        artifactType: "knowledge_read_snapshot",
        value: { ...snapshot, intentRef: { ...snapshot.intentRef, artifactId: intentRecord.artifactId } },
      });
      const lineage = await ledger.link(client, {
        tenantId,
        from: snapshotRecord.artifactId,
        to: intentRecord.artifactId,
        relation: "derived_from",
      });
      return {
        ...snapshot,
        intentRef: { ...snapshot.intentRef, artifactId: intentRecord.artifactId },
        storage: {
          artifactId: snapshotRecord.artifactId,
          bucket: snapshotRecord.bucket,
          objectPath: snapshotRecord.objectPath,
          storageState: snapshotRecord.storageState,
          lineage: [{ relation: "derived_from", to: intentRecord.artifactId, state: lineage }],
        },
      };
    });
  }
}

type QueryOperation = Extract<ReadOperation, { kind: "named_query" | "retrieval" }>;

interface QueryStep {
  readonly operation: QueryOperation;
  readonly index: number;
  readonly intent: ReadIntent;
  readonly catalog: QueryCatalog;
  readonly completed: ReadonlyMap<string, OperationResult>;
  readonly timeoutFor: (entry: CatalogEntry) => number;
  readonly atKnowledgeSeq: number;
  readonly currentKnowledgeSeq: number;
}

interface Fetched {
  readonly columns: readonly string[];
  readonly rows: readonly Row[];
}

async function runSql(client: KnowledgeSqlClient, sql: string, params: readonly unknown[]): Promise<Fetched> {
  const result = await client.query<Row>(sql, params.map(sqlParam));
  const rows = result.rows.map(jsonSafeRow);
  const columns = rows[0] ? Object.keys(rows[0]) : [];
  return { columns, rows };
}

/** Object and array parameters travel as JSON text so `$n::jsonb` / `$n::text[]` casts in catalog SQL receive a single literal. */
function sqlParam(value: unknown): unknown {
  if (value !== null && typeof value === "object" && !(value instanceof Date) && !Array.isArray(value))
    return JSON.stringify(value);
  return value;
}

async function setRole(client: KnowledgeSqlClient, role: KnowledgeRole): Promise<void> {
  await client.query(`set local role ${role}`);
}

async function readHead(client: KnowledgeSqlClient): Promise<KnowledgeHead> {
  const row = (await client.query<{ knowledge_seq: string | number; updated_at: Date | string }>(HEAD_SQL)).rows[0];
  return {
    knowledgeSeq: Number(row?.knowledge_seq ?? 0),
    updatedAt:
      row?.updated_at instanceof Date
        ? row.updated_at.toISOString()
        : String(row?.updated_at ?? "1970-01-01T00:00:00.000Z"),
  };
}

function findEntry(catalog: QueryCatalog, name: string): CatalogEntry {
  const entry = catalog.entries.find((item) => item.name === name || item.id === name || item.id === `q:${name}`);
  if (!entry)
    throw domainError("QUERY_UNKNOWN", `${name} is not in the named-query catalog`, {
      known: catalog.entries.map((item) => item.name),
    });
  return entry;
}

function assertParams(entry: CatalogEntry, params: Record<string, unknown>, opId: string): void {
  const issues = validateSchema(entry.params, params);
  if (issues.length > 0)
    throw domainError("PARAMS_INVALID", `${opId}: parameters violate the catalog schema for ${entry.name}`, { issues });
}

function skipped(operation: ReadOperation, reason: string, started: number): OperationResult {
  return {
    opId: operation.opId,
    kind: operation.kind,
    status: "skipped",
    rowCount: 0,
    truncated: false,
    contentDigest: digestOf(null),
    reason,
    durationMs: Math.round(performance.now() - started),
  };
}

interface ShapeInput {
  operation: QueryOperation;
  entry: CatalogEntry;
  role: KnowledgeRole;
  params: Record<string, unknown>;
  resolvedFrom: Record<string, string>;
  fetched: Fetched;
  cap: number;
  started: number;
}

function shapeResult(input: ShapeInput): OperationResult {
  const { operation, entry, fetched, cap } = input;
  const truncated = fetched.rows.length > cap;
  const rows = fetched.rows.slice(0, cap);
  const base = {
    opId: operation.opId,
    kind: operation.kind,
    query: entry.name,
    role: input.role,
    params: input.params,
    ...(Object.keys(input.resolvedFrom).length ? { resolvedFrom: input.resolvedFrom } : {}),
    truncated,
    durationMs: Math.round(performance.now() - input.started),
    ...(entry.volatile ? { volatile: true } : {}),
  };
  if (entry.result.shape === "single_json") {
    const value = rows[0] ? (rows[0][fetched.columns[0] ?? ""] ?? null) : null;
    return {
      ...base,
      status: value === null ? "empty" : "ok",
      rowCount: rows.length,
      value,
      contentDigest: digestOf(value),
    };
  }
  if (entry.result.shape === "single_row") {
    const value = rows[0] ?? null;
    return {
      ...base,
      status: value === null ? "empty" : "ok",
      rowCount: rows.length,
      columns: fetched.columns,
      value,
      contentDigest: digestOf(value),
    };
  }
  return {
    ...base,
    status: truncated ? "truncated" : rows.length === 0 ? "empty" : "ok",
    rowCount: rows.length,
    columns: fetched.columns,
    rows,
    contentDigest: digestOf(rows),
  };
}
