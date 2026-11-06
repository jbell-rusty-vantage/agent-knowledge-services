import { randomUUID } from "node:crypto";
import {
  ImportedSourceDiscoveryReceiptSchema,
  ManagedSourceDiscoveryRequestSchema,
  SourceDiscoveryAttemptSchema,
  SourceDiscoverySelectionRequestSchema,
  type SourceDiscoverySelectionRequest,
  type SourceDiscoverySelectionReceipt,
  type ImportedSourceDiscoveryReceipt,
  type ManagedSourceDiscoveryRequest,
  type SourceDiscoveryAttempt,
  SourceDiscoveryAttemptReadSchema,
  SourceDiscoveryReadOptionsSchema,
  type SourceDiscoveryReadOptions,
  type SourceDiscoveryAttemptRead,
  type SourceDiscoveryResult,
} from "@aiengineer/knowledge-contracts";
import type { SourceDiscoveryDispatchLease, SourceDiscoveryStore } from "@aiengineer/knowledge-application";
import { canonicalizeJson, sha256Digest } from "@aiengineer/knowledge-verification";
import type { PostgresCanonicalRepository, TenantSqlClient } from "./postgres.js";
type Artifact = SourceDiscoveryAttempt["requestArtifact"];
type Row = Record<string, unknown>;
function attempt(
  row: Row,
  requestArtifact: Artifact,
  rawOutputArtifact?: Artifact,
  externalReceiptArtifact?: Artifact,
  completionArtifact?: Artifact,
): SourceDiscoveryAttempt {
  return SourceDiscoveryAttemptSchema.parse({
    providerVersion: String(row.provider_version ?? "unspecified"),
    rootAttemptId: String(row.root_attempt_id ?? row.id),
    attemptOrdinal: Number(row.attempt_ordinal ?? 0),
    ...(row.retry_of_attempt_id
      ? {
          retryOfAttemptId: String(row.retry_of_attempt_id),
        }
      : {}),
    accountingCompleteness:
      (row.origin === "managed" && rawOutputArtifact && completionArtifact) ||
      (row.origin === "imported" && rawOutputArtifact && row.provider_version && row.provider_version !== "unspecified")
        ? "complete"
        : "partial",
    ...(completionArtifact
      ? {
          completionArtifact,
        }
      : {}),
    attemptId: String(row.id),
    origin: String(row.origin),
    providerCode: String(row.provider_code),
    trust: row.origin === "managed" ? "managed_host" : "self_reported",
    state: String(row.state),
    requestArtifact,
    ...(rawOutputArtifact
      ? {
          rawOutputArtifact,
        }
      : {}),
    ...(externalReceiptArtifact
      ? {
          externalReceiptArtifact,
        }
      : {}),
    resultCount: Number(row.result_count ?? 0),
    ...(row.failure_code
      ? {
          failureCode: String(row.failure_code),
        }
      : {}),
    ...(row.completed_at
      ? {
          completedAt:
            row.completed_at instanceof Date
              ? row.completed_at.toISOString()
              : new Date(String(row.completed_at)).toISOString(),
        }
      : {}),
  });
}
function requestHash(
  request: Pick<
    ManagedSourceDiscoveryRequest | ImportedSourceDiscoveryReceipt,
    "providerCode" | "providerVersion" | "queryText" | "purpose" | "parameters" | "requestedUrls"
  >,
): string {
  const { providerCode, providerVersion, queryText, purpose, parameters, requestedUrls } = request;
  return sha256Digest(
    canonicalizeJson({
      providerCode,
      providerVersion,
      queryText,
      purpose,
      parameters,
      requestedUrls,
    }),
  ).slice(7);
}
function completionHash(
  state: "succeeded" | "failed" | "uncertain" | "cancelled",
  failureCode: string | undefined,
  results: readonly SourceDiscoveryResult[],
): string {
  return sha256Digest(
    canonicalizeJson({
      state,
      failureCode: failureCode ?? null,
      results,
    }),
  ).slice(7);
}
async function queryId(
  client: TenantSqlClient,
  tenantId: string,
  request: Pick<
    ManagedSourceDiscoveryRequest | ImportedSourceDiscoveryReceipt,
    "providerCode" | "queryText" | "purpose" | "parameters"
  >,
): Promise<string> {
  const row = (
    await client.query<Row>(
      `insert into evidence.source_query(tenant_id,provider_code,query_text,purpose,parameters)
  values($1,$2,$3,$4,$5::jsonb) returning id`,
      [tenantId, request.providerCode, request.queryText, request.purpose, JSON.stringify(request.parameters)],
    )
  ).rows[0];
  if (!row) throw new Error("SOURCE_DISCOVERY_QUERY_CREATE");
  return String(row.id);
}
/** Durable source-attempt accounting. It stores lead metadata as untrusted discovery material only. */
export class PostgresSourceDiscoveryStore implements SourceDiscoveryStore {
  constructor(private readonly database: Pick<PostgresCanonicalRepository, "transaction">) {}
  async startManaged(input: {
    readonly tenantId: string;
    readonly request: ManagedSourceDiscoveryRequest;
    readonly requestArtifact: Artifact;
  }): Promise<{
    readonly attempt: SourceDiscoveryAttempt;
    readonly created: boolean;
  }> {
    const request = ManagedSourceDiscoveryRequestSchema.parse(structuredClone(input.request));
    if (input.requestArtifact.tenantId !== input.tenantId) throw new Error("SOURCE_DISCOVERY_REQUEST_ARTIFACT_TENANT");
    return this.database.transaction(input.tenantId, async (client) => {
      await this.#lockKey(client, input.tenantId, request.idempotencyKey);
      const existing = (
        await client.query<Row>(
          `select a.*,
     (select count(*) from evidence.provider_result r where r.tenant_id=a.tenant_id and r.source_provider_attempt_id=a.id) result_count
    from evidence.source_provider_attempt a where a.tenant_id=$1 and a.idempotency_key=$2 for update`,
          [input.tenantId, request.idempotencyKey],
        )
      ).rows[0];
      const digest = requestHash(request);
      if (existing) {
        if (
          existing.origin !== "managed" ||
          existing.request_sha256 !== digest ||
          (existing.retry_of_attempt_id ?? null) !== (request.retryOfAttemptId ?? null) ||
          existing.request_artifact_id !== input.requestArtifact.artifactId
        )
          throw new Error("SOURCE_DISCOVERY_IDEMPOTENCY_CONFLICT");
        const raw = existing.raw_output_artifact_id
          ? await this.#artifact(client, input.tenantId, String(existing.raw_output_artifact_id))
          : undefined;
        const completion = existing.completion_artifact_id
          ? await this.#artifact(client, input.tenantId, String(existing.completion_artifact_id))
          : undefined;
        return {
          attempt: attempt(existing, input.requestArtifact, raw, undefined, completion),
          created: false,
        };
      }
      const retry = await this.#retryBinding(client, input.tenantId, request);
      const sourceQueryId = retry?.queryId ?? (await queryId(client, input.tenantId, request));
      const created = (
        await client.query<Row>(
          `insert into evidence.source_provider_attempt
    (tenant_id,source_query_id,provider_code,origin,idempotency_key,request_sha256,requested_urls,request_artifact_id,state,provider_version,retry_of_attempt_id,root_attempt_id,attempt_ordinal)
    values($1,$2,$3,'managed',$4,$5,$6::jsonb,$7,'started',$8,$9,$10,$11) returning *,0 result_count`,
          [
            input.tenantId,
            sourceQueryId,
            request.providerCode,
            request.idempotencyKey,
            digest,
            JSON.stringify(request.requestedUrls),
            input.requestArtifact.artifactId,
            request.providerVersion,
            request.retryOfAttemptId ?? null,
            retry?.rootId ?? null,
            retry?.ordinal ?? 0,
          ],
        )
      ).rows[0];
      if (!created) throw new Error("SOURCE_DISCOVERY_ATTEMPT_CREATE");
      return {
        attempt: attempt(created, input.requestArtifact),
        created: true,
      };
    });
  }
  async claimManagedDispatch(input: {
    tenantId: string;
    attemptId: string;
    holderIdentity: string;
  }): Promise<SourceDiscoveryDispatchLease | undefined> {
    return this.#claim(input, "dispatch");
  }
  async claimManagedReconciliation(input: {
    tenantId: string;
    attemptId: string;
    holderIdentity: string;
  }): Promise<SourceDiscoveryDispatchLease | undefined> {
    return this.#claim(input, "reconcile");
  }
  async #claim(
    input: {
      tenantId: string;
      attemptId: string;
      holderIdentity: string;
    },
    mode: "dispatch" | "reconcile",
  ): Promise<SourceDiscoveryDispatchLease | undefined> {
    if (!input.holderIdentity.trim() || input.holderIdentity.length > 256)
      throw new Error("SOURCE_DISCOVERY_DISPATCH_OWNER");
    return this.database.transaction(input.tenantId, async (client) => {
      const row = (
        await client.query<Row>(
          `select *,dispatch_expires_at>clock_timestamp() as lease_live from evidence.source_provider_attempt where tenant_id=$1 and id=$2 and origin='managed' for update`,
          [input.tenantId, input.attemptId],
        )
      ).rows[0];
      if (!row || row.state !== "started" || row.lease_live) return undefined;
      if (mode === "dispatch" ? row.original_dispatch_token !== null : row.original_dispatch_token === null)
        return undefined;
      const token = randomUUID();
      const claimed = (
        await client.query<Row>(
          `update evidence.source_provider_attempt set dispatch_owner=$3,dispatch_token=$4,dispatch_fencing_token=dispatch_fencing_token+1,
    dispatch_claimed_at=clock_timestamp(),dispatch_expires_at=clock_timestamp()+interval '90 seconds',
    original_dispatch_token=coalesce(original_dispatch_token,$4),original_dispatch_fencing_token=coalesce(original_dispatch_fencing_token,dispatch_fencing_token+1)
    where tenant_id=$1 and id=$2 returning dispatch_token,dispatch_fencing_token,original_dispatch_token,original_dispatch_fencing_token`,
          [input.tenantId, input.attemptId, input.holderIdentity, token],
        )
      ).rows[0]!;
      return {
        token: String(claimed.dispatch_token),
        fencingToken: Number(claimed.dispatch_fencing_token),
        originalToken: String(claimed.original_dispatch_token),
        originalFencingToken: Number(claimed.original_dispatch_fencing_token),
      };
    });
  }
  async renewManagedDispatch(input: {
    tenantId: string;
    attemptId: string;
    holderIdentity: string;
    token: string;
    fencingToken: number;
  }): Promise<boolean> {
    return this.database.transaction(
      input.tenantId,
      async (client) =>
        (
          await client.query(
            `update evidence.source_provider_attempt set dispatch_expires_at=clock_timestamp()+interval '90 seconds'
   where tenant_id=$1 and id=$2 and origin='managed' and state='started' and dispatch_owner=$3 and dispatch_token=$4 and dispatch_fencing_token=$5 and dispatch_expires_at>clock_timestamp()`,
            [input.tenantId, input.attemptId, input.holderIdentity, input.token, input.fencingToken],
          )
        ).rowCount === 1,
    );
  }
  async findCompletionArtifacts(input: { tenantId: string; attemptId: string }): Promise<readonly Artifact[]> {
    return this.database.transaction(input.tenantId, async (client) => {
      const ids = (
        await client.query<Row>(
          `select a.id from orchestration.artifact a join orchestration.verification_artifact_metadata m on m.tenant_id=a.tenant_id and m.artifact_id=a.id
    join evidence.source_provider_attempt p on p.tenant_id=a.tenant_id and p.id=$2
    where a.tenant_id=$1 and a.verification_contract_version='verification.v1'
     and m.producer_activity_id=$3 and m.parent_artifact_ids=array[p.request_artifact_id]::uuid[] order by a.created_at,a.id`,
          [input.tenantId, input.attemptId, `knowledge:source-discovery-completion:${input.attemptId}`],
        )
      ).rows;
      return Promise.all(ids.map((row) => this.#artifact(client, input.tenantId, String(row.id), true)));
    });
  }
  async completeManaged(input: {
    readonly tenantId: string;
    readonly attemptId: string;
    readonly dispatchToken: string;
    readonly fencingToken: number;
    readonly originalDispatchToken: string;
    readonly originalFencingToken: number;
    readonly completionArtifact: Artifact;
    readonly state: "succeeded" | "failed" | "uncertain" | "cancelled";
    readonly failureCode?: string;
    readonly rawOutputArtifact: Artifact;
    readonly results: readonly SourceDiscoveryResult[];
  }): Promise<SourceDiscoveryAttempt> {
    if (
      input.completionArtifact.tenantId !== input.tenantId ||
      input.rawOutputArtifact.tenantId !== input.tenantId ||
      !Number.isSafeInteger(input.fencingToken) ||
      input.fencingToken < 1 ||
      (input.state === "succeeded") !== (input.failureCode === undefined) ||
      (input.state !== "succeeded" && input.results.length !== 0)
    )
      throw new Error("SOURCE_DISCOVERY_COMPLETION_INPUT");
    return this.database.transaction(input.tenantId, async (client) => {
      const prior = (
        await client.query<Row>(
          `select a.*,q.query_text,q.purpose,q.parameters from evidence.source_provider_attempt a join evidence.source_query q on q.id=a.source_query_id
    where a.tenant_id=$1 and a.id=$2 for update`,
          [input.tenantId, input.attemptId],
        )
      ).rows[0];
      if (!prior || prior.origin !== "managed") throw new Error("SOURCE_DISCOVERY_ATTEMPT_NOT_FOUND");
      const requestArtifact = await this.#artifact(client, input.tenantId, String(prior.request_artifact_id));
      const digest = completionHash(input.state, input.failureCode, input.results);
      if (
        prior.original_dispatch_token !== input.originalDispatchToken ||
        Number(prior.original_dispatch_fencing_token) !== input.originalFencingToken
      )
        throw new Error("SOURCE_DISCOVERY_ORIGINAL_DISPATCH_MISMATCH");
      await this.#artifact(client, input.tenantId, input.rawOutputArtifact.artifactId);
      await this.#artifact(client, input.tenantId, input.completionArtifact.artifactId);
      if (prior.state !== "started") {
        if (
          prior.state !== input.state ||
          prior.raw_output_artifact_id !== input.rawOutputArtifact.artifactId ||
          prior.completion_sha256 !== digest ||
          prior.completion_artifact_id !== input.completionArtifact.artifactId
        )
          throw new Error("SOURCE_DISCOVERY_COMPLETION_CONFLICT");
        const count = await this.#resultCount(client, input.tenantId, input.attemptId);
        return attempt(
          {
            ...prior,
            result_count: count,
          },
          requestArtifact,
          input.rawOutputArtifact,
          undefined,
          input.completionArtifact,
        );
      }
      const done = (
        await client.query<Row>(
          `update evidence.source_provider_attempt set state=$3,raw_output_artifact_id=$4,failure_code=$5,completion_sha256=$6,completion_artifact_id=$9,completed_at=clock_timestamp(),
    dispatch_owner=null,dispatch_token=null,dispatch_claimed_at=null,dispatch_expires_at=null
    where tenant_id=$1 and id=$2 and state='started' and dispatch_token=$7 and dispatch_fencing_token=$8 and dispatch_expires_at>clock_timestamp() returning *`,
          [
            input.tenantId,
            input.attemptId,
            input.state,
            input.rawOutputArtifact.artifactId,
            input.failureCode ?? null,
            digest,
            input.dispatchToken,
            input.fencingToken,
            input.completionArtifact.artifactId,
          ],
        )
      ).rows[0];
      if (!done) throw new Error("SOURCE_DISCOVERY_COMPLETION_RACE");
      for (const result of input.results) await this.#recordResult(client, input.tenantId, input.attemptId, result);
      if (input.state !== "succeeded")
        await this.#recordFailureEncounters(
          client,
          input.tenantId,
          input.attemptId,
          Array.isArray(prior.requested_urls) ? prior.requested_urls.map(String) : [],
          input.failureCode!,
        );
      await client.query("select evidence.rebuild_source_state()");
      return attempt(
        {
          ...done,
          result_count: input.results.length,
        },
        requestArtifact,
        input.rawOutputArtifact,
        undefined,
        input.completionArtifact,
      );
    });
  }
  async recordImported(input: {
    readonly tenantId: string;
    readonly receipt: ImportedSourceDiscoveryReceipt;
  }): Promise<SourceDiscoveryAttempt> {
    const receipt = ImportedSourceDiscoveryReceiptSchema.parse(structuredClone(input.receipt));
    if (
      receipt.externalReceiptArtifact.tenantId !== input.tenantId ||
      (receipt.rawOutputArtifact !== undefined && receipt.rawOutputArtifact.tenantId !== input.tenantId)
    )
      throw new Error("SOURCE_DISCOVERY_IMPORTED_ARTIFACT_TENANT");
    return this.database.transaction(input.tenantId, async (client) => {
      await this.#lockKey(client, input.tenantId, receipt.idempotencyKey);
      const existing = (
        await client.query<Row>(
          `select * from evidence.source_provider_attempt where tenant_id=$1 and idempotency_key=$2 for update`,
          [input.tenantId, receipt.idempotencyKey],
        )
      ).rows[0];
      const digest = requestHash(receipt);
      if (existing) {
        if (
          existing.origin !== "imported" ||
          existing.request_sha256 !== digest ||
          (existing.retry_of_attempt_id ?? null) !== (receipt.retryOfAttemptId ?? null) ||
          existing.external_receipt_artifact_id !== receipt.externalReceiptArtifact.artifactId ||
          (existing.provider_native_attempt_id ?? null) !== (receipt.externalAttemptId ?? null) ||
          new Date(existing.started_at as string | Date).toISOString() !== new Date(receipt.occurredAt).toISOString()
        )
          throw new Error("SOURCE_DISCOVERY_IDEMPOTENCY_CONFLICT");
        if (
          existing.completion_sha256 !== completionHash(receipt.state, receipt.failureCode, receipt.results) ||
          existing.raw_output_artifact_id !== (receipt.rawOutputArtifact?.artifactId ?? null)
        )
          throw new Error("SOURCE_DISCOVERY_COMPLETION_CONFLICT");
        return attempt(
          {
            ...existing,
            result_count: await this.#resultCount(client, input.tenantId, String(existing.id)),
          },
          receipt.externalReceiptArtifact,
          receipt.rawOutputArtifact,
          receipt.externalReceiptArtifact,
        );
      }
      const retry = await this.#retryBinding(client, input.tenantId, receipt);
      const sourceQueryId = retry?.queryId ?? (await queryId(client, input.tenantId, receipt));
      const inserted = (
        await client.query<Row>(
          `insert into evidence.source_provider_attempt
    (tenant_id,source_query_id,provider_code,origin,idempotency_key,request_sha256,requested_urls,request_artifact_id,raw_output_artifact_id,external_receipt_artifact_id,provider_native_attempt_id,state,failure_code,completion_sha256,started_at,completed_at,provider_version,retry_of_attempt_id,root_attempt_id,attempt_ordinal)
    values($1,$2,$3,'imported',$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14,$14,$15,$16,$17,$18) returning *`,
          [
            input.tenantId,
            sourceQueryId,
            receipt.providerCode,
            receipt.idempotencyKey,
            digest,
            JSON.stringify(receipt.requestedUrls),
            receipt.externalReceiptArtifact.artifactId,
            receipt.rawOutputArtifact?.artifactId ?? null,
            receipt.externalReceiptArtifact.artifactId,
            receipt.externalAttemptId ?? null,
            receipt.state,
            receipt.failureCode ?? null,
            completionHash(receipt.state, receipt.failureCode, receipt.results),
            receipt.occurredAt,
            receipt.providerVersion,
            receipt.retryOfAttemptId ?? null,
            retry?.rootId ?? null,
            retry?.ordinal ?? 0,
          ],
        )
      ).rows[0];
      if (!inserted) throw new Error("SOURCE_DISCOVERY_IMPORT_CREATE");
      for (const result of receipt.results)
        await this.#recordResult(client, input.tenantId, String(inserted.id), result);
      if (receipt.state !== "succeeded")
        await this.#recordFailureEncounters(
          client,
          input.tenantId,
          String(inserted.id),
          receipt.requestedUrls,
          receipt.failureCode!,
        );
      await client.query("select evidence.rebuild_source_state()");
      return attempt(
        {
          ...inserted,
          result_count: receipt.results.length,
        },
        receipt.externalReceiptArtifact,
        receipt.rawOutputArtifact,
        receipt.externalReceiptArtifact,
      );
    });
  }
  async recordSelection(input: {
    tenantId: string;
    request: SourceDiscoverySelectionRequest;
    artifact: Artifact;
  }): Promise<SourceDiscoverySelectionReceipt> {
    const request = SourceDiscoverySelectionRequestSchema.parse(input.request);
    if (input.artifact.tenantId !== input.tenantId) throw new Error("SOURCE_DISCOVERY_SELECTION_TENANT");
    return this.database.transaction(input.tenantId, async (client) => {
      await this.#lockKey(client, input.tenantId, `selection:${request.attemptId}`);
      const parent = (
        await client.query<Row>("select state from evidence.source_provider_attempt where tenant_id=$1 and id=$2", [
          input.tenantId,
          request.attemptId,
        ])
      ).rows[0];
      if (parent?.state !== "succeeded") throw new Error("SOURCE_DISCOVERY_SELECTION_REQUIRES_SUCCESS");
      await this.#artifact(client, input.tenantId, input.artifact.artifactId);
      const digest = sha256Digest(canonicalizeJson(request)).slice(7);
      const existing = (
        await client.query<Row>(
          "select revision,request_sha256,selection_artifact_id from evidence.source_selection_revision where tenant_id=$1 and attempt_id=$2 and idempotency_key=$3",
          [input.tenantId, request.attemptId, request.idempotencyKey],
        )
      ).rows[0];
      if (existing) {
        if (existing.selection_artifact_id !== input.artifact.artifactId || existing.request_sha256 !== digest)
          throw new Error("SOURCE_DISCOVERY_SELECTION_CONFLICT");
        return {
          attemptId: request.attemptId,
          selectionArtifact: input.artifact,
          decisionCount: request.decisions.length,
          revision: Number(existing.revision),
        };
      }
      const latest = (
        await client.query<Row>(
          "select coalesce(max(revision),0)+1 revision from evidence.source_selection_revision where tenant_id=$1 and attempt_id=$2",
          [input.tenantId, request.attemptId],
        )
      ).rows[0];
      const revision = Number(latest!.revision);
      await client.query(
        `insert into evidence.source_selection_revision(tenant_id,attempt_id,revision,idempotency_key,request_sha256,selection_artifact_id) values($1,$2,$3,$4,$5,$6)`,
        [input.tenantId, request.attemptId, revision, request.idempotencyKey, digest, input.artifact.artifactId],
      );
      for (const decision of request.decisions) {
        const result = (
          await client.query<Row>(
            "select id from evidence.provider_result where tenant_id=$1 and source_provider_attempt_id=$2 and rank=$3",
            [input.tenantId, request.attemptId, decision.rank],
          )
        ).rows[0];
        if (!result) throw new Error("SOURCE_DISCOVERY_SELECTION_RANK_UNKNOWN");
        await client.query(
          `insert into evidence.source_result_selection(tenant_id,attempt_id,revision,rank,disposition,reason,idempotency_key,selection_artifact_id) values($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            input.tenantId,
            request.attemptId,
            revision,
            decision.rank,
            decision.disposition,
            decision.reason,
            request.idempotencyKey,
            input.artifact.artifactId,
          ],
        );
      }
      return {
        attemptId: request.attemptId,
        selectionArtifact: input.artifact,
        decisionCount: request.decisions.length,
        revision,
      };
    });
  }
  /** Compact tenant-scoped discovery read. Raw receipt custody must be available before any lead is returned. */
  async readAttempt(
    tenantId: string,
    attemptId: string,
    options: SourceDiscoveryReadOptions = {},
  ): Promise<SourceDiscoveryAttemptRead> {
    const page = SourceDiscoveryReadOptionsSchema.parse(options);
    return this.database.transaction(tenantId, async (client) => {
      const row = (
        await client.query<Row>(
          `select a.*, (select count(*) from evidence.provider_result r where r.tenant_id=a.tenant_id and r.source_provider_attempt_id=a.id) result_count
    from evidence.source_provider_attempt a where a.tenant_id=$1 and a.id=$2`,
          [tenantId, attemptId],
        )
      ).rows[0];
      if (!row) throw new Error("SOURCE_DISCOVERY_ATTEMPT_NOT_FOUND");
      const requestArtifact = await this.#artifact(client, tenantId, String(row.request_artifact_id));
      if (row.state === "started")
        return SourceDiscoveryAttemptReadSchema.parse({
          attempt: attempt(row, requestArtifact),
          results: [],
          page: {
            ...page,
            total: 0,
            hasMore: false,
          },
        });
      const rawOutputArtifact = row.raw_output_artifact_id
        ? await this.#artifact(client, tenantId, String(row.raw_output_artifact_id))
        : undefined;
      const externalReceiptArtifact = row.external_receipt_artifact_id
        ? await this.#artifact(client, tenantId, String(row.external_receipt_artifact_id))
        : undefined;
      if ((row.origin === "managed" && !rawOutputArtifact) || (row.origin === "imported" && !externalReceiptArtifact))
        throw new Error("SOURCE_DISCOVERY_RECEIPT_UNAVAILABLE");
      const completionArtifact = row.completion_artifact_id
        ? await this.#artifact(client, tenantId, String(row.completion_artifact_id))
        : undefined;
      const resultRows = (
        await client.query<Row>(
          `select r.rank,e.requested_url,e.final_url,e.redirect_urls,coalesce(s.disposition,e.result_disposition) result_disposition,e.capture_id,s.selection_artifact_id
    from evidence.provider_result r join evidence.source_encounter e on e.tenant_id=r.tenant_id and e.provider_result_id=r.id
    left join lateral (select disposition,selection_artifact_id from evidence.source_result_selection s where s.tenant_id=r.tenant_id and s.attempt_id=r.source_provider_attempt_id and s.rank=r.rank order by s.revision desc limit 1) s on true
    where r.tenant_id=$1 and r.source_provider_attempt_id=$2 order by r.rank limit $3 offset $4`,
          [tenantId, attemptId, page.limit, page.offset],
        )
      ).rows;
      const selectionArtifacts = await Promise.all(
        [
          ...new Set(
            resultRows.flatMap((row) => (row.selection_artifact_id ? [String(row.selection_artifact_id)] : [])),
          ),
        ].map((id) => this.#artifact(client, tenantId, id)),
      );
      const results = resultRows.map((result) => ({
        rank: Number(result.rank),
        requestedUrl: String(result.requested_url),
        finalUrl: String(result.final_url),
        redirectUrls: Array.isArray(result.redirect_urls) ? result.redirect_urls.map(String) : [],
        disposition: String(result.result_disposition) as "selected" | "omitted" | "duplicate",
        ...(result.capture_id
          ? {
              captureId: String(result.capture_id),
            }
          : {}),
      }));
      if (results.length !== Math.min(page.limit, Math.max(0, Number(row.result_count) - page.offset)))
        throw new Error("SOURCE_DISCOVERY_RESULT_CUSTODY_MISMATCH");
      return SourceDiscoveryAttemptReadSchema.parse({
        attempt: attempt(row, requestArtifact, rawOutputArtifact, externalReceiptArtifact, completionArtifact),
        results,
        selectionArtifacts,
        page: {
          ...page,
          total: Number(row.result_count),
          hasMore: page.offset + results.length < Number(row.result_count),
        },
      });
    });
  }
  async #artifact(
    client: TenantSqlClient,
    tenantId: string,
    artifactId: string,
    includePending = false,
  ): Promise<Artifact> {
    const row = (
      await client.query<Row>(
        `select a.*,m.producer_activity_id,m.producer_version,m.content_encoding,m.encryption_class,m.retention_class,m.data_classification,m.parent_artifact_ids,m.transformation_signature,m.attestation_artifact_id,m.logical_object_key
   from orchestration.artifact a join orchestration.verification_artifact_metadata m on m.tenant_id=a.tenant_id and m.artifact_id=a.id
   where a.tenant_id=$1 and a.id=$2 and ($3::boolean or a.storage_state='available')`,
        [tenantId, artifactId, includePending],
      )
    ).rows[0];
    if (!row) throw new Error("SOURCE_DISCOVERY_ARTIFACT_UNAVAILABLE");
    return {
      artifactId: String(row.id),
      tenantId: String(row.tenant_id),
      digest: `sha256:${String(row.sha256)}`,
      mediaType: String(row.media_type),
      byteLength: Number(row.size_bytes),
      objectKey: String(row.logical_object_key ?? row.object_path),
      createdAt:
        row.created_at instanceof Date ? row.created_at.toISOString() : new Date(String(row.created_at)).toISOString(),
      producerActivityId: String(row.producer_activity_id),
      producerVersion: String(row.producer_version),
      encryptionClass: String(row.encryption_class),
      retentionClass: String(row.retention_class),
      dataClassification: String(row.data_classification),
      parentArtifactIds: Array.isArray(row.parent_artifact_ids) ? row.parent_artifact_ids.map(String) : [],
      ...(row.content_encoding
        ? {
            contentEncoding: String(row.content_encoding),
          }
        : {}),
      ...(row.transformation_signature
        ? {
            transformationSignature: `sha256:${String(row.transformation_signature)}`,
          }
        : {}),
      ...(row.attestation_artifact_id
        ? {
            attestationArtifactId: String(row.attestation_artifact_id),
          }
        : {}),
    } as Artifact;
  }
  async #lockKey(client: TenantSqlClient, tenantId: string, key: string): Promise<void> {
    await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`source-attempt:${tenantId}:${key}`]);
  }
  async #retryBinding(
    client: TenantSqlClient,
    tenantId: string,
    request: ManagedSourceDiscoveryRequest | ImportedSourceDiscoveryReceipt,
  ): Promise<
    | {
        queryId: string;
        rootId: string;
        ordinal: number;
      }
    | undefined
  > {
    if (!request.retryOfAttemptId) return undefined;
    const prior = (
      await client.query<Row>(
        "select * from evidence.source_provider_attempt where tenant_id=$1 and id=$2 for update",
        [tenantId, request.retryOfAttemptId],
      )
    ).rows[0];
    if (
      !prior ||
      prior.state === "started" ||
      prior.request_sha256 !== requestHash(request) ||
      prior.origin !== (request.schemaVersion === "source-discovery-managed-request.v1" ? "managed" : "imported")
    )
      throw new Error("SOURCE_DISCOVERY_RETRY_BINDING");
    await this.#lockKey(client, tenantId, `query:${String(prior.source_query_id)}`);
    const max = (
      await client.query<Row>(
        "select max(attempt_ordinal) ordinal from evidence.source_provider_attempt where tenant_id=$1 and source_query_id=$2",
        [tenantId, prior.source_query_id],
      )
    ).rows[0];
    return {
      queryId: String(prior.source_query_id),
      rootId: String(prior.root_attempt_id ?? prior.id),
      ordinal: Number(max?.ordinal ?? 0) + 1,
    };
  }
  async #resultCount(client: TenantSqlClient, tenantId: string, attemptId: string): Promise<number> {
    return Number(
      (
        await client.query<Row>(
          "select count(*) result_count from evidence.provider_result where tenant_id=$1 and source_provider_attempt_id=$2",
          [tenantId, attemptId],
        )
      ).rows[0]?.result_count ?? 0,
    );
  }
  async #recordResult(
    client: TenantSqlClient,
    tenantId: string,
    attemptId: string,
    result: SourceDiscoveryResult,
  ): Promise<void> {
    const source =
      (
        await client.query<Row>(
          `insert into evidence.source(tenant_id,source_class,canonical_url) values($1,$2,$3)
   on conflict do nothing returning id`,
          [tenantId, result.sourceClass, result.finalUrl],
        )
      ).rows[0] ??
      (
        await client.query<Row>("select id from evidence.source where tenant_id=$1 and canonical_url=$2", [
          tenantId,
          result.finalUrl,
        ])
      ).rows[0];
    if (!source) throw new Error("SOURCE_DISCOVERY_SOURCE_RESOLUTION");
    const providerResult = (
      await client.query<Row>(
        `insert into evidence.provider_result(tenant_id,query_id,rank,source_id,url,title,snippet,payload,source_provider_attempt_id,provider_native_result_id,disposition)
   select $1,a.source_query_id,$3,$4,$5,$6,$7,$8::jsonb,$2,$9,$10 from evidence.source_provider_attempt a where a.tenant_id=$1 and a.id=$2
   returning id`,
        [
          tenantId,
          attemptId,
          result.rank,
          source.id,
          result.finalUrl,
          result.title ?? null,
          result.snippet ?? null,
          JSON.stringify({
            payload_digest: result.payloadDigest,
            provenance: "untrusted_discovery",
          }),
          result.providerResultId ?? null,
          result.disposition,
        ],
      )
    ).rows[0];
    if (!providerResult) throw new Error("SOURCE_DISCOVERY_RESULT_CREATE");
    if (
      result.captureId &&
      !(
        await client.query<Row>(
          "select id from evidence.source_capture where tenant_id=$1 and id=$2 and source_id=$3",
          [tenantId, result.captureId, source.id],
        )
      ).rows[0]
    )
      throw new Error("SOURCE_DISCOVERY_CAPTURE_BINDING");
    await client.query(
      `insert into evidence.source_encounter(tenant_id,source_id,provider_result_id,source_provider_attempt_id,capture_id,encounter_kind,encountered_at,details,requested_url,final_url,redirect_urls,result_disposition)
   values($1,$2,$3,$4,$5,'discovered',clock_timestamp(),$6::jsonb,$7,$8,$9,$10)`,
      [
        tenantId,
        source.id,
        providerResult.id,
        attemptId,
        result.captureId ?? null,
        JSON.stringify({
          provenance: "untrusted_discovery",
          payload_digest: result.payloadDigest,
        }),
        result.requestedUrl,
        result.finalUrl,
        result.redirectUrls,
        result.disposition,
      ],
    );
  }
  async #recordFailureEncounters(
    client: TenantSqlClient,
    tenantId: string,
    attemptId: string,
    requestedUrls: readonly string[],
    failureCode: string,
  ): Promise<void> {
    for (const requestedUrl of requestedUrls) {
      const source =
        (
          await client.query<Row>(
            `insert into evidence.source(tenant_id,source_class,canonical_url) values($1,'web_page',$2) on conflict do nothing returning id`,
            [tenantId, requestedUrl],
          )
        ).rows[0] ??
        (
          await client.query<Row>("select id from evidence.source where tenant_id=$1 and canonical_url=$2", [
            tenantId,
            requestedUrl,
          ])
        ).rows[0];
      if (!source) throw new Error("SOURCE_DISCOVERY_SOURCE_RESOLUTION");
      await client.query(
        `insert into evidence.source_encounter(tenant_id,source_id,source_provider_attempt_id,encounter_kind,encountered_at,details,requested_url,final_url,redirect_urls,failure_code)
    values($1,$2,$3,'failed',clock_timestamp(),$4::jsonb,$5,$5,'{}',$6)`,
        [
          tenantId,
          source.id,
          attemptId,
          JSON.stringify({
            provenance: "untrusted_discovery",
            failure_code: failureCode,
          }),
          requestedUrl,
          failureCode,
        ],
      );
    }
  }
}
