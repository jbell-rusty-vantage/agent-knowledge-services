import {
  type OperationResult,
  type ReadExecutor,
  type ReadSnapshot,
  type Workspace,
  getPage,
  isKnowledgeError,
  searchWorkspace,
  uuidv7,
} from "@aiengineer/knowledge-db";
import {
  type KnowledgeReadIntentPort,
  type ReadIntentAnswer,
  refusal,
} from "@aiengineer/knowledge-host/knowledge-operation";
import {
  type JsonDocument,
  type ProtocolErrorCode,
  READ_INTENT_CONTRACT,
  READ_INTENT_NAMED_QUERIES,
  type ReadIntentOperationResult,
  digestCanonical,
  readIntentContentDigest,
  readIntentSnapshotDigest,
  toWireJson,
} from "@aiengineer/knowledge-operation-protocol";

/**
 * `knowledge.read_intent` of the AI Engineer binding (OVE-204 slice 4): the knowledge-db `ReadExecutor` (repeatable-read
 * named queries over the pinned AIDB workspace catalog) and the workspace `schema_search`/`schema_get` pages, behind
 * the production allowlist. It needs the AI Engineer knowledge database, so the executable builds it and injects it
 * (`HostInjection.readIntent`); without it `knowledge.read_intent` answers SCHEMA_UNSUPPORTED.
 *
 * Tenant guard: the K01 scope tenant must be the executor's AIDB tenant (`KS_DEFAULT_TENANT_ID`), like the MCP
 * `tenantOf` guard; any other tenant refuses SCOPE_DENIED before any read. `persist` is passed to the executor, which
 * retains the native intent and snapshot as AIDB ledger artifacts (named queries only). Every digest is K01
 * `digestCanonical` over protocol JSON (`toWireJson`), never the executor's own JCS digests.
 */
export const READ_INTENT_ALLOWLIST: ReadonlySet<string> = new Set(READ_INTENT_NAMED_QUERIES);

/** Native read failures as typed K01 refusals. */
const NATIVE_CODES: Readonly<Record<string, ProtocolErrorCode>> = {
  QUERY_UNKNOWN: "INVALID_ENVELOPE",
  PARAMS_INVALID: "INVALID_ENVELOPE",
  INTENT_SCHEMA_INVALID: "INVALID_ENVELOPE",
  LIMITS_EXCEEDED: "INVALID_ENVELOPE",
  ROLE_DENIED: "SCOPE_DENIED",
  HEAD_MISMATCH: "EXACT_REVISION_UNAVAILABLE",
  SNAPSHOT_HEAD_CHANGED: "EXACT_REVISION_UNAVAILABLE",
  WORKSPACE_STALE: "SCHEMA_UNSUPPORTED",
  DB_UNAVAILABLE: "CAPABILITY_UNAVAILABLE",
  ARTIFACTS_UNAVAILABLE: "CAPABILITY_UNAVAILABLE",
};

type Correlation = { readonly dispatchId: string };

function nativeRefusal(error: unknown, correlation: Correlation): unknown {
  if (!isKnowledgeError(error)) return error;
  const code = NATIVE_CODES[error.code] ?? (error.exit === 1 ? "INVALID_ENVELOPE" : "INTERNAL");
  return refusal(code, `${error.code}: ${error.message}`, correlation, { nativeCode: error.code });
}

/** A K01 instant: RFC 3339 UTC with no trailing zeros in the fraction. */
export function protocolInstant(value: string): string {
  const parsed = new Date(value);
  const iso = Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
  return iso.replace(/\.(\d*?)0+Z$/, (_, digits: string) => (digits.length > 0 ? `.${digits}Z` : "Z"));
}

type WireOperation = Omit<ReadIntentOperationResult, "bodyWithheld"> & { readonly bodyWithheld: false };

function namedResult(result: OperationResult, query: string): WireOperation {
  const rows = result.rows === undefined ? undefined : (toWireJson(result.rows) as Record<string, JsonDocument>[]);
  const value = result.rows === undefined && result.value !== undefined ? toWireJson(result.value) : undefined;
  const body = rows ?? value ?? null;
  const failure =
    result.error ??
    (result.status === "skipped" ? { code: result.reason ?? "SKIPPED", message: "operation skipped" } : undefined);
  return {
    opId: result.opId,
    kind: "named_query",
    query: result.query ?? query,
    status: result.status,
    rowCount: result.rowCount,
    truncated: result.truncated,
    contentDigest: readIntentContentDigest(body),
    bodyWithheld: false,
    ...(result.columns ? { columns: [...result.columns] } : {}),
    ...(rows !== undefined ? { rows } : {}),
    ...(value !== undefined ? { value } : {}),
    ...(failure ? { error: { code: failure.code.slice(0, 120), message: failure.message.slice(0, 2000) } } : {}),
  };
}

function failedSchemaRead(
  opId: string,
  kind: "schema_search" | "schema_get",
  query: string,
  error: unknown,
): WireOperation {
  if (!isKnowledgeError(error)) throw error;
  return {
    opId,
    kind,
    query,
    status: "error",
    rowCount: 0,
    truncated: false,
    contentDigest: readIntentContentDigest(null),
    bodyWithheld: false,
    error: { code: error.code.slice(0, 120), message: error.message.slice(0, 2000) },
  };
}

/**
 * The port over the executor's read services. `tenantId` is the AIDB tenant the executor serves (its
 * `defaultTenantId`); `executorVersion` names nothing on the wire (the native snapshot records it).
 */
export function createReadIntentPort(
  reads: Pick<ReadExecutor, "runIntent" | "head">,
  workspace: Workspace,
  tenantId: string,
): KnowledgeReadIntentPort {
  return {
    nativeContract: READ_INTENT_CONTRACT,
    async run(scope, { envelope, request }): Promise<ReadIntentAnswer> {
      const correlation = { dispatchId: envelope.dispatchId };
      if (scope.tenant !== tenantId) {
        throw refusal("SCOPE_DENIED", "this executor reads another AI Engineer tenant", correlation);
      }
      for (const operation of request.operations) {
        if (operation.kind === "named_query" && !READ_INTENT_ALLOWLIST.has(operation.query)) {
          throw refusal("SCOPE_DENIED", `${operation.query} is not an allowlisted named query`, correlation);
        }
      }
      const named = request.operations.filter((operation) => operation.kind === "named_query");
      let snapshot: ReadSnapshot | null = null;
      let head: { knowledgeSeq: number; updatedAt: string };
      let atKnowledgeSeq: number;
      try {
        if (named.length > 0) {
          snapshot = await reads.runIntent(
            {
              schemaVersion: "knowledge-read-intent.v1",
              intentId: `ri-${digestCanonical({ tenant: scope.tenant, requestId: envelope.requestId }).slice(7, 39)}`,
              context: { tenantId, correlationId: envelope.dispatchId },
              atKnowledgeSeq: request.atKnowledgeSeq,
              operations: named.map((operation) => ({
                opId: operation.opId,
                kind: "named_query",
                query: operation.query,
                params: operation.params,
                ...(operation.limit !== undefined ? { limit: operation.limit } : {}),
              })),
            },
            { persist: request.persist },
          );
          head = snapshot.knowledgeHead;
          atKnowledgeSeq = snapshot.atKnowledgeSeq;
        } else {
          head = await reads.head(tenantId);
          atKnowledgeSeq = request.atKnowledgeSeq ?? head.knowledgeSeq;
          if (atKnowledgeSeq > head.knowledgeSeq) {
            throw refusal(
              "EXACT_REVISION_UNAVAILABLE",
              `atKnowledgeSeq ${atKnowledgeSeq} is ahead of the tenant head ${head.knowledgeSeq}`,
              correlation,
            );
          }
        }
      } catch (error) {
        throw nativeRefusal(error, correlation);
      }
      const byOpId = new Map((snapshot?.operations ?? []).map((result) => [result.opId, result]));
      const operations: WireOperation[] = request.operations.map((operation) => {
        switch (operation.kind) {
          case "named_query": {
            const result = byOpId.get(operation.opId);
            if (result === undefined) throw refusal("INTERNAL", `no native result for ${operation.opId}`, correlation);
            return namedResult(result, operation.query);
          }
          case "schema_search": {
            try {
              const found = searchWorkspace(workspace, operation.query, {
                ...(operation.kinds ? { kinds: operation.kinds } : {}),
                ...(operation.limit ? { limit: operation.limit } : {}),
              });
              const value = toWireJson(found);
              return {
                opId: operation.opId,
                kind: "schema_search",
                query: operation.query,
                status: found.hits.length === 0 ? "empty" : "ok",
                rowCount: found.hits.length,
                truncated: false,
                contentDigest: readIntentContentDigest(value),
                bodyWithheld: false,
                value,
              };
            } catch (error) {
              return failedSchemaRead(operation.opId, "schema_search", operation.query, error);
            }
          }
          case "schema_get": {
            try {
              const page = getPage(workspace, operation.id, operation.maxBytes ? { maxBytes: operation.maxBytes } : {});
              const value = toWireJson(page);
              return {
                opId: operation.opId,
                kind: "schema_get",
                query: operation.id,
                status: page.truncated ? "truncated" : "ok",
                rowCount: 1,
                truncated: page.truncated,
                contentDigest: readIntentContentDigest(value),
                bodyWithheld: false,
                value,
              };
            } catch (error) {
              return failedSchemaRead(operation.opId, "schema_get", operation.id, error);
            }
          }
          default:
            throw refusal("INVALID_ENVELOPE", "unknown read intent operation kind", correlation);
        }
      });
      const catalogVersion = snapshot?.contract.catalogVersion ?? workspace.catalog?.catalogVersion;
      const fingerprint = snapshot?.contract.workspaceFingerprint ?? workspace.fingerprint;
      return {
        snapshotId: snapshot?.snapshotId ?? uuidv7(),
        snapshotDigest: readIntentSnapshotDigest(atKnowledgeSeq, operations),
        knowledgeHead: { knowledgeSeq: head.knowledgeSeq, updatedAt: protocolInstant(head.updatedAt) },
        atKnowledgeSeq,
        contract: {
          migrationHead: snapshot?.contract.migrationHead ?? workspace.migrationHead,
          ...(fingerprint ? { workspaceFingerprint: fingerprint } : {}),
          ...(catalogVersion ? { catalogVersion } : {}),
        },
        operations,
      };
    },
  };
}
