import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ArtifactLedger, ReadExecutor } from "../../src/db-read/index.js";
import { PostgresCanonicalRepository, TenantPostgres } from "@aiengineer/knowledge-persistence";
import { LocalArtifactStore, digestBytes } from "@aiengineer/knowledge-core";
import { loadWorkspace } from "../../src/schema-workspace/index.js";
import { describe, expect, it } from "vitest";
import { disposableDatabaseUrl } from "../../../persistence/test/disposable.mjs";
import { IngestionExecutor } from "../../src/ingestion/executor.js";
import { declaredRunsOracle } from "./declared-evidence.mjs";
import type { IngestionIntentInput } from "../../src/ingestion/intent.js";
import { prepareCurrentSchemaFixture } from "./preparation-fixture.mjs";

const url = disposableDatabaseUrl();
const workspacePath = resolve(import.meta.dirname, "../../../../../../aiengineer/ai-engineer-db-contract/workspace");

describe.skipIf(!url)("required isolated current-schema vertical path", () => {
  it("persists preparation, synthetic service admission, snapshot, claim, fact, event and replayable receipt", async () => {
    const tenantId = randomUUID();
    const foreignTenant = randomUUID();
    const artifactDirectory = mkdtempSync(join(tmpdir(), "ks-p0-vertical-"));
    process.stdout.write(
      `${JSON.stringify({ proof: "synthetic-current-schema-vertical/start", tenantId, artifactDirectory })}\n`,
    );
    const db = new TenantPostgres({ connectionString: url! });
    const canonical = new PostgresCanonicalRepository({ connectionString: url! });
    const workspace = loadWorkspace(workspacePath);
    const store = new LocalArtifactStore(artifactDirectory);
    const artifacts = new ArtifactLedger({
      db,
      store,
      bucket: "research-ingestion-intents",
      uploaded: false,
      executorVersion: "synthetic-p0-vertical/v1",
      readStores: { "source-captures": store, "content-derivatives": store },
    });
    const reads = new ReadExecutor({ db, workspace, artifacts, executorVersion: "synthetic-p0-vertical/v1" });
    // This declared-run oracle is an explicit P0 fixture adapter, not production admission evidence.
    const ingestion = new IngestionExecutor({
      db,
      workspace,
      artifacts,
      executorVersion: "synthetic-p0-vertical/v1",
      evidence: declaredRunsOracle,
    });
    try {
      expect(workspace.migrationHead).toMatch(/^\d{14}$/);
      expect(await db.migrationHead()).toBe(workspace.migrationHead);
      const fixture = await prepareCurrentSchemaFixture({ database: canonical, tenantId, store });
      expect(fixture.producer).not.toBe(fixture.reviewer);
      const projectionId = fixture.promoted.proposal.projectionIds[0]!;
      expect(fixture.promoted.proposal.projectionIds).toHaveLength(1);
      const preparationRows = await db.transaction({ tenantId, readOnly: true }, (client) =>
        client.query(
          `select d.document_type_code,r.representation_class,
        rd.decision representation_decision,cs.status chunk_status,t.target_kind,t.chunk_id,
        pd.decision promotion_decision,ps.selected_text_sha256,sp.source_text
        from retrieval.search_projection sp
        join retrieval.projection_target t on t.tenant_id=sp.tenant_id and t.id=sp.projection_target_id
        join retrieval.search_projection_chunk_support ps on ps.tenant_id=sp.tenant_id and ps.search_projection_id=sp.id
        join retrieval.retrieval_chunk c on c.tenant_id=ps.tenant_id and c.id=ps.chunk_id
        join retrieval.chunk_set cs on cs.tenant_id=c.tenant_id and cs.id=c.chunk_set_id
        join content.document_representation r on r.tenant_id=cs.tenant_id and r.id=cs.representation_id
        join content.document_version v on v.tenant_id=r.tenant_id and v.id=r.document_version_id
        join content.document d on d.tenant_id=v.tenant_id and d.id=v.document_id
        join content.representation_decision rd on rd.tenant_id=r.tenant_id and rd.representation_id=r.id and rd.id=$2
        join retrieval.content_promotion_decision pd on pd.tenant_id=sp.tenant_id and pd.id=$3
        where sp.id=$1 and sp.tenant_id=$4`,
          [projectionId, fixture.represented.decisionId, fixture.promoted.decisionId, tenantId],
        ),
      );
      expect(preparationRows.rows).toEqual([
        {
          document_type_code: "official_docs_page",
          representation_class: "structural_extraction",
          representation_decision: "accept",
          chunk_status: "succeeded",
          target_kind: "chunk",
          chunk_id: fixture.chunked.input.chunks[0]!.id,
          promotion_decision: "accept",
          selected_text_sha256: fixture.chunked.input.chunks[0]!.sourceTextDigest.slice(7),
          source_text: fixture.sourceText,
        },
      ]);

      const snapshot = await reads.runIntent(
        {
          schemaVersion: "knowledge-read-intent.v1",
          intentId: `p0-read-${tenantId}`,
          context: { tenantId },
          contract: { migrationHead: workspace.migrationHead },
          operations: [
            { opId: "head", kind: "named_query", query: "knowledge.head" },
            {
              opId: "capture",
              kind: "named_query",
              query: "evidence.captures_for_source",
              params: { source_id: fixture.captured.input.sourceId },
            },
            {
              opId: "structural",
              kind: "artifact",
              artifactId: fixture.represented.structural.artifactId,
              include: "inline",
            },
          ],
        },
        { persist: true },
      );
      expect(snapshot.operations.map((operation) => operation.status)).toEqual(["ok", "ok", "ok"]);
      expect(snapshot.operations[1]!.rows).toEqual([
        expect.objectContaining({
          id: fixture.captured.input.captureId,
          source_id: fixture.captured.input.sourceId,
          artifact_id: fixture.captured.sourceArtifact.artifactId,
          content_sha256: fixture.captured.sourceArtifact.digest.slice(7),
          capture_method: "manual",
        }),
      ]);
      expect(snapshot.knowledgeHead.knowledgeSeq).toBe(0);
      expect(snapshot.headChanged).toBe(false);
      expect(snapshot.storage?.artifactId).toBeDefined();
      const restoredSnapshot = await artifacts.get(tenantId, snapshot.storage!.artifactId);
      expect(restoredSnapshot.json).toMatchObject({
        snapshotId: snapshot.snapshotId,
        snapshotDigest: snapshot.snapshotDigest,
      });
      const runId = `synthetic-p0-${tenantId}`;
      const evidence = [{ runId, claimId: "synthetic-claim" }];
      const intent: IngestionIntentInput = {
        schemaVersion: "knowledge-ingestion-intent.v1",
        intentId: `p0-ingest-${tenantId}`,
        context: {
          tenantId,
          missionId: fixture.parents.missionId,
          attemptId: fixture.parents.attemptId,
          actor: { kind: "service", id: fixture.producer },
        },
        contract: { migrationHead: workspace.migrationHead },
        inputSnapshot: {
          artifactId: snapshot.storage!.artifactId,
          snapshotId: snapshot.snapshotId,
          snapshotDigest: snapshot.snapshotDigest,
          knowledgeSeq: 0,
        },
        expectedKnowledgeHead: 0,
        evidence: {
          verificationRuns: [{ runId }],
          claims: [
            {
              runId,
              claimId: "synthetic-claim",
              claimType: "attribute",
              statement: fixture.sourceText,
              subjects: [{ ref: "org", role: "subject" }],
            },
          ],
        },
        subjects: [{ ref: "org", mode: "resolved", entityId: fixture.parents.entityId, kind: "organization" }],
        proposals: [
          { proposalId: "claim", kind: "claim.materialize", runId, claimIds: ["synthetic-claim"] },
          {
            proposalId: "fact",
            kind: "fact.assert_state",
            subjectRef: "org",
            streamKind: "organization_status",
            status: "operating",
            worldInterval: { from: "2026-01-01T00:00:00Z" },
            temporalBasis: "observation_bounded",
            evidence,
            dependsOn: ["claim"],
          },
          {
            proposalId: "event",
            kind: "event.assert",
            subjectRef: "org",
            eventKind: "founded",
            occurredDuring: { from: "2026-01-01T00:00:00Z", to: "2026-01-02T00:00:00Z" },
            evidence,
            dependsOn: ["claim"],
          },
        ],
        notes: "Synthetic schema proof; does not close P1 authoritative verification/admission",
      };
      const receipt = await ingestion.apply(intent);
      expect(receipt.outcome).toBe("applied");
      expect(receipt.head).toEqual({ before: 0, after: 1, rebased: false });
      expect(receipt.proposals.map((proposal) => proposal.outcome)).toEqual(["admitted", "admitted", "admitted"]);
      const claimId = receipt.claims[0]!.claimRowId!;
      expect(claimId).toMatch(/^[0-9a-f-]{36}$/);
      const persisted = await reads.sqlReadonly({
        tenantId,
        sql: `select c.id claim_id,c.statement,c.producer_attempt_id,
        s.id segment_id,s.status,s.k_from,eo.id occurrence_id,e.kind event_kind,eo.primary_claim_id event_claim,
        cs.entity_id subject_entity from evidence.claim c
        join evidence.claim_subject cs on cs.tenant_id=c.tenant_id and cs.claim_id=c.id
        join temporal.segment s on s.tenant_id=c.tenant_id and s.primary_claim_id=c.id
        join temporal.event_occurrence eo on eo.tenant_id=c.tenant_id and eo.primary_claim_id=c.id
        join temporal.event e on e.tenant_id=eo.tenant_id and e.id=eo.event_id where c.id=$1`,
        params: [claimId],
      });
      expect(persisted.rows).toHaveLength(1);
      expect(persisted.rows[0]).toMatchObject({
        claim_id: claimId,
        statement: fixture.sourceText,
        producer_attempt_id: fixture.parents.attemptId,
        status: "operating",
        event_kind: "founded",
        event_claim: claimId,
        subject_entity: fixture.parents.entityId,
      });
      expect(Number(persisted.rows[0]!.k_from)).toBe(1);
      expect(receipt.affectedRefs).toEqual(
        expect.arrayContaining([
          { schema: "evidence", table: "claim", id: claimId },
          { schema: "temporal", table: "segment", id: persisted.rows[0]!.segment_id },
          { schema: "temporal", table: "event_occurrence", id: persisted.rows[0]!.occurrence_id },
        ]),
      );
      expect(receipt.affectedRefs).toHaveLength(3);
      const restored = await ingestion.receipt(receipt.receiptId, tenantId);
      expect(restored.receiptId).toBe(receipt.receiptId);
      expect(restored.affectedRefs).toEqual(receipt.affectedRefs);
      const receiptRow = await db.transaction(
        { tenantId, role: "executor_service", readOnly: true },
        async (client) =>
          (
            await client.query(
              "select changes_summary,affected_refs from orchestration.operation_receipt where id=$1",
              [receipt.receiptId],
            )
          ).rows[0],
      );
      expect(receiptRow!.changes_summary).toMatchObject({ receiptArtifactId: receipt.storage.receiptArtifactId });
      expect(receiptRow!.affected_refs).toEqual(receipt.affectedRefs);
      for (const artifactId of [
        fixture.captured.sourceArtifact.artifactId,
        fixture.represented.structural.artifactId,
        snapshot.storage!.artifactId,
        receipt.storage.intentArtifactId!,
        receipt.storage.planArtifactId!,
        receipt.storage.receiptArtifactId!,
      ]) {
        const fetched = await artifacts.get(tenantId, artifactId);
        const bytes = await store.get(tenantId, fetched.record.digest);
        expect(bytes).toBeDefined();
        expect(digestBytes(bytes!)).toBe(fetched.record.digest);
      }
      const duplicate = await ingestion.apply(intent);
      expect(duplicate.duplicateOf).toBe(receipt.receiptId);
      expect((await reads.head(tenantId)).knowledgeSeq).toBe(1);
      await expect(ingestion.receipt(receipt.receiptId, foreignTenant)).rejects.toMatchObject({
        code: "RECEIPT_NOT_FOUND",
      });
      const foreign = await reads.sqlReadonly({
        tenantId: foreignTenant,
        sql: "select id from evidence.claim where id=$1",
        params: [claimId],
      });
      expect(foreign.rows).toEqual([]);
      process.stdout.write(
        `${JSON.stringify({
          proof: "synthetic-current-schema-vertical/v1",
          tenantId,
          migrationHead: workspace.migrationHead,
          artifactDirectory,
          captureId: fixture.captured.input.captureId,
          representationId: fixture.represented.input.structuralRepresentationId,
          chunkSetId: fixture.chunked.input.chunkSetId,
          projectionId,
          promotionDecisionId: fixture.promoted.decisionId,
          snapshotId: snapshot.snapshotId,
          snapshotArtifactId: snapshot.storage!.artifactId,
          snapshotDigest: snapshot.snapshotDigest,
          receiptId: receipt.receiptId,
          receiptArtifactId: receipt.storage.receiptArtifactId,
          claimId,
          syntheticAdmission: true,
          humanApproval: false,
          remoteStorageProven: false,
          dbAffectedRefsPendingP23: true,
        })}\n`,
      );
    } finally {
      await canonical.close();
      await db.close();
    }
  }, 120_000);
});
