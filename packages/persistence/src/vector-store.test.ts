import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresCanonicalRepository } from "./postgres.js";
import { PostgresKnowledgeOperationService } from "./operation-service.js";
import { PostgresVectorStoreLifecycleRepository } from "./vector-store.js";

describe.skipIf(process.env.RUN_LOCAL_PERSISTENCE_TESTS !== "1")(
  "vector-store lifecycle local PostgreSQL integration",
  () => {
    let database: PostgresCanonicalRepository;
    beforeAll(() => {
      const connectionString = process.env.POSTGRES_URL;
      if (!connectionString) throw new Error("POSTGRES_URL_REQUIRED");
      database = new PostgresCanonicalRepository({ connectionString, localOnly: true });
    });
    afterAll(async () => database?.close());

    it("persists immutable operation/owner identity, maps store classes, replays exactly, and isolates tenants", async () => {
      const tenantId = randomUUID(),
        operationId = randomUUID(),
        actorId = randomUUID(),
        slug = `store-${randomUUID()}`;
      const context = {
        tenantId,
        operationId,
        attemptId: randomUUID(),
        correlationId: randomUUID(),
        actor: { kind: "service" as const, id: actorId, serviceIdentity: "knowledge_api" as const },
        capabilityVersion: "vector-store/v1",
        idempotencyKey: `vector-store:${randomUUID()}`,
        reason: "vector store persistence integration",
        contractVersion: "v1" as const,
      };
      const input = {
        schemaVersion: "knowledge.vector-store/v1",
        slug,
        name: "Integration store",
        purpose: "verify durable lifecycle",
        storeClass: "internal_exploratory" as const,
        visibility: "tenant" as const,
        quotaProfile: { maximumDocuments: 1000, maximumBytes: 1000000, maximumSpaces: 8 },
        retentionPolicy: { mode: "duration", days: 90 },
        deletionPolicy: { mode: "review_required", minimumRetentionDays: 30 },
      };
      await new PostgresKnowledgeOperationService(database).submit(
        "vector_store_create",
        { context, input, expectedVersions: { api: "v1" } },
        "https://knowledge.example",
      );
      const repository = new PostgresVectorStoreLifecycleRepository(database),
        vectorStoreId = randomUUID();
      const persist = {
        operationId,
        vectorStoreId,
        ownerIdentity: `service:${actorId}`,
        storeClass: input.storeClass,
        slug,
        name: input.name,
        purpose: input.purpose,
        visibility: input.visibility,
        quotaProfile: input.quotaProfile,
        retentionPolicy: input.retentionPolicy,
        deletionPolicy: input.deletionPolicy,
      };
      const first = await repository.persistVectorStore(tenantId, persist),
        replay = await repository.persistVectorStore(tenantId, persist);
      expect(first).toEqual(replay);
      expect(first).toMatchObject({
        id: vectorStoreId,
        tenantId,
        ownerIdentity: `service:${actorId}`,
        storeClass: "internal_exploratory",
        slug,
        documentCount: 0,
      });
      await expect(repository.persistVectorStore(tenantId, { ...persist, name: "Substituted" })).rejects.toThrow(
        "VECTOR_STORE_REPLAY_CONFLICT",
      );
      expect(await database.getVectorStoreResource(randomUUID(), vectorStoreId)).toBeUndefined();
      await expect(
        database.transaction(tenantId, (client) =>
          client.query("update retrieval.vector_store set owner_identity='attacker' where tenant_id=$1 and id=$2", [
            tenantId,
            vectorStoreId,
          ]),
        ),
      ).rejects.toThrow(/immutable/i);

      const secondOperationId = randomUUID(),
        secondContext = {
          ...context,
          operationId: secondOperationId,
          attemptId: randomUUID(),
          idempotencyKey: `vector-store:${randomUUID()}`,
        };
      await new PostgresKnowledgeOperationService(database).submit(
        "vector_store_create",
        { context: secondContext, input, expectedVersions: { api: "v1" } },
        "https://knowledge.example",
      );
      await expect(
        repository.persistVectorStore(tenantId, {
          ...persist,
          operationId: secondOperationId,
          vectorStoreId: randomUUID(),
        }),
      ).rejects.toThrow("VECTOR_STORE_SLUG_CONFLICT");
    });

    it("attaches only consistent accepted representations under owner, quota, lifecycle, and replay guards", async () => {
      const tenantId = randomUUID(),
        actorId = randomUUID(),
        ownerIdentity = `service:${actorId}`;
      const service = new PostgresKnowledgeOperationService(database),
        repository = new PostgresVectorStoreLifecycleRepository(database);
      const submit = async (kind: "vector_store_create" | "vector_store_documents") => {
        const operationId = randomUUID();
        await service.submit(
          kind,
          {
            context: {
              tenantId,
              operationId,
              attemptId: randomUUID(),
              correlationId: randomUUID(),
              actor: { kind: "service", id: actorId, serviceIdentity: "knowledge_api" },
              capabilityVersion: "vector-store/v1",
              idempotencyKey: `${kind}:${randomUUID()}`,
              reason: "vector store attachment integration",
              contractVersion: "v1",
            },
            input: { fixture: true },
            expectedVersions: { api: "v1" },
          },
          "https://knowledge.example",
        );
        return operationId;
      };
      const createStore = async (
        storeClass: "internal_exploratory" | "official_canonical" = "internal_exploratory",
        maximumDocuments = 1,
      ) => {
        const operationId = await submit("vector_store_create"),
          vectorStoreId = randomUUID();
        await repository.persistVectorStore(tenantId, {
          operationId,
          vectorStoreId,
          ownerIdentity,
          storeClass,
          slug: `store-${randomUUID()}`,
          name: "Attachment integration",
          purpose: "negative authority and identity drills",
          visibility: "tenant",
          quotaProfile: { maximumDocuments, maximumBytes: 1000, maximumSpaces: 2 },
          retentionPolicy: { mode: "duration", days: 30 },
          deletionPolicy: { mode: "review_required", minimumRetentionDays: 1 },
        });
        return vectorStoreId;
      };
      const createDocument = async (sizeBytes: number) => {
        const documentId = randomUUID(),
          documentVersionId = randomUUID(),
          representationId = randomUUID(),
          artifactId = randomUUID(),
          transformationRunId = randomUUID();
        const digest = randomUUID().replaceAll("-", "").padEnd(64, "a").slice(0, 64),
          transformationOperationId = randomUUID();
        await database.transaction(tenantId, async (client) => {
          const artifactType = String(
            (await client.query<{ code: string }>("select code from orchestration.artifact_type order by code limit 1"))
              .rows[0]!.code,
          );
          await client.query(
            `insert into knowledge_service.operation(id,tenant_id,operation_kind,idempotency_key,correlation_id,actor_identity,request,request_sha256,status,completed_at)
          values($1,$2,'transformation',$3,$4,$5,'{}',$6,'succeeded',now())`,
            [transformationOperationId, tenantId, `transform:${randomUUID()}`, randomUUID(), ownerIdentity, digest],
          );
          await client.query(
            `insert into orchestration.artifact(id,tenant_id,artifact_type,sha256,bucket_class,storage_bucket,object_path,media_type,size_bytes)
          values($1,$2,$3,$4,'accepted','content-derivatives',$5,'text/markdown',$6)`,
            [artifactId, tenantId, artifactType, digest, `${tenantId}/${artifactId}`, sizeBytes],
          );
          await client.query(
            `insert into content.document(id,tenant_id,document_kind,canonical_title) values($1,$2,'article','Integration document')`,
            [documentId, tenantId],
          );
          await client.query(
            `insert into content.document_version(id,tenant_id,document_id,version_label,manifest_sha256) values($1,$2,$3,'v1',$4)`,
            [documentVersionId, tenantId, documentId, digest],
          );
          await client.query(
            `insert into content.transformation_run(id,tenant_id,transformation_kind,contract_version,parameters,parameters_sha256,operation_id,status,idempotency_key,receipt,ended_at)
          values($1,$2,'structural','v1','{}',$3,$4,'succeeded',$5,'{}',now())`,
            [
              transformationRunId,
              tenantId,
              digest,
              transformationOperationId,
              `transformation:${transformationOperationId}`,
            ],
          );
          await client.query(
            `insert into content.document_representation(id,tenant_id,document_version_id,artifact_id,representation_kind,representation_class,media_type,content_sha256,transformation_run_id,acceptance_state)
          values($1,$2,$3,$4,'markdown','structural_extraction','text/markdown',$5,$6,'accepted')`,
            [representationId, tenantId, documentVersionId, artifactId, digest, transformationRunId],
          );
        });
        return { documentId, documentVersionId, representationId };
      };
      const first = await createDocument(100),
        second = await createDocument(100),
        storeId = await createStore();
      const attachOperationId = await submit("vector_store_documents"),
        attachmentId = randomUUID();
      const attachment = {
        operationId: attachOperationId,
        vectorStoreId: storeId,
        actorIdentity: ownerIdentity,
        controlPlaneOverride: false,
        documents: [{ id: attachmentId, ...first, requestedProfile: { profile: "official-v1" } }],
      };
      await expect(repository.attachDocuments(tenantId, attachment)).resolves.toMatchObject({
        attachmentIds: [attachmentId],
        attachmentCount: 1,
        state: "requested",
      });
      await expect(repository.attachDocuments(tenantId, attachment)).resolves.toMatchObject({
        attachmentIds: [attachmentId],
      });
      await expect(
        repository.attachDocuments(tenantId, {
          ...attachment,
          documents: [{ ...attachment.documents[0]!, requestedProfile: { profile: "substituted" } }],
        }),
      ).rejects.toThrow("VECTOR_STORE_DOCUMENT_REPLAY_CONFLICT");

      const quotaOperationId = await submit("vector_store_documents");
      await expect(
        repository.attachDocuments(tenantId, {
          ...attachment,
          operationId: quotaOperationId,
          documents: [{ id: randomUUID(), ...second, requestedProfile: {} }],
        }),
      ).rejects.toThrow("VECTOR_STORE_DOCUMENT_QUOTA_EXCEEDED");
      await expect(
        repository.attachDocuments(tenantId, {
          ...attachment,
          operationId: await submit("vector_store_documents"),
          actorIdentity: "service:attacker",
          documents: [{ id: randomUUID(), ...second, requestedProfile: {} }],
        }),
      ).rejects.toThrow("VECTOR_STORE_OWNER_MISMATCH");

      const identityStore = await createStore("internal_exploratory", 5);
      await expect(
        repository.attachDocuments(tenantId, {
          ...attachment,
          operationId: await submit("vector_store_documents"),
          vectorStoreId: identityStore,
          documents: [
            {
              id: randomUUID(),
              documentId: first.documentId,
              documentVersionId: second.documentVersionId,
              representationId: second.representationId,
              requestedProfile: {},
            },
          ],
        }),
      ).rejects.toThrow("VECTOR_STORE_DOCUMENT_VERSION_MISMATCH");
      await expect(
        repository.attachDocuments(tenantId, {
          ...attachment,
          operationId: await submit("vector_store_documents"),
          vectorStoreId: identityStore,
          documents: [
            {
              id: randomUUID(),
              documentId: first.documentId,
              documentVersionId: first.documentVersionId,
              representationId: second.representationId,
              requestedProfile: {},
            },
          ],
        }),
      ).rejects.toThrow("VECTOR_STORE_REPRESENTATION_MISMATCH");

      const inactiveStore = randomUUID(),
        inactiveOperation = await submit("vector_store_create");
      await database.transaction(tenantId, (client) =>
        client.query(
          `insert into retrieval.vector_store
      (id,tenant_id,owner_identity,store_class,slug,name,purpose,visibility,lifecycle,quota_profile,retention_policy,deletion_policy,created_by_operation_id)
      values($1,$2,$3,'exploratory',$4,'Suspended store','inactive drill','tenant','suspended',$5::jsonb,'{}','{}',$6)`,
          [
            inactiveStore,
            tenantId,
            ownerIdentity,
            `inactive-${randomUUID()}`,
            JSON.stringify({ maximumDocuments: 5, maximumBytes: 1000, maximumSpaces: 2 }),
            inactiveOperation,
          ],
        ),
      );
      await expect(
        repository.attachDocuments(tenantId, {
          ...attachment,
          operationId: await submit("vector_store_documents"),
          vectorStoreId: inactiveStore,
        }),
      ).rejects.toThrow("VECTOR_STORE_INACTIVE");

      const officialStore = await createStore("official_canonical", 5),
        officialOperationId = await submit("vector_store_documents");
      const officialAttachment = {
        ...attachment,
        operationId: officialOperationId,
        vectorStoreId: officialStore,
        documents: [{ ...attachment.documents[0]!, id: randomUUID() }],
      };
      await expect(repository.attachDocuments(tenantId, officialAttachment)).rejects.toThrow(
        "CONTROL_PLANE_AUTHORITY_REQUIRED",
      );
      await expect(
        repository.attachDocuments(tenantId, { ...officialAttachment, controlPlaneOverride: true }),
      ).resolves.toMatchObject({ storeClass: "official_canonical" });
    });
  },
);
