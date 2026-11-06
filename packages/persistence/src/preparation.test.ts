import { randomUUID } from "node:crypto";
import { sha256Digest } from "@aiengineer/knowledge-core";
import { describe, expect, it } from "vitest";
import { PostgresCanonicalRepository } from "./postgres.js";
import { PostgresPreparationRepository } from "./preparation.js";
import type { PersistedPreparationArtifact } from "./types.js";
import { disposableDatabaseUrl } from "../test/disposable.mjs";

const databaseUrl = disposableDatabaseUrl();
const live = databaseUrl ? describe : describe.skip;
const tenantId = "00000000-0000-7000-8000-000000000001";
const digest = (value: unknown) => sha256Digest(JSON.parse(JSON.stringify(value))) as `sha256:${string}`;
function artifact(
  id: string,
  value: string,
  type: string,
  bucketClass: PersistedPreparationArtifact["bucketClass"],
): PersistedPreparationArtifact {
  const valueDigest = digest(value);
  return {
    artifactId: id,
    digest: valueDigest,
    mediaType: type === "report_markdown" ? "text/markdown" : "application/json",
    byteLength: value.length,
    storageKey: `${tenantId}/${valueDigest.slice(7, 9)}/${valueDigest.slice(7)}`,
    artifactType: type,
    bucketClass,
    storageBucket: "source-captures",
  };
}

live("PostgresPreparationRepository", () => {
  it("is replay-safe and rejects changed immutable capture, node, and span identities", async () => {
    const database = new PostgresCanonicalRepository({ connectionString: databaseUrl! });
    const repository = new PostgresPreparationRepository(database);
    const namespace = randomUUID();
    const sourceArtifact = artifact(randomUUID(), `source-${namespace}`, "source_capture", "source_captures");
    const captureOperationId = randomUUID();
    const capture = {
      operationId: captureOperationId,
      sourceId: randomUUID(),
      captureId: randomUUID(),
      sourceClass: "web_page" as const,
      canonicalUrl: `https://example.com/${namespace}`,
      publisher: "Example",
      sensitivity: "public" as const,
      artifact: sourceArtifact,
      captureMethod: "manual@1",
      captureMethodVersion: "1",
      requestUrl: `https://example.com/${namespace}`,
      httpStatus: 200,
      observations: { verified: true },
      capturedAt: "2026-09-04T12:00:00.000Z",
    };
    try {
      await database.createOperation({
        id: captureOperationId,
        tenantId,
        operationKind: "capture",
        idempotencyKey: `preparation-test:${namespace}`,
        correlationId: randomUUID(),
        actorIdentity: "persistence-test",
        request: { schemaVersion: "test/v1" },
        steps: [],
      });
      const first = await repository.persistCapture(tenantId, capture);
      expect(first.artifact.artifactId).toBe(sourceArtifact.artifactId);
      expect(first.captureMethod).toBe("manual@1");
      const storedCapture = await database.transaction(
        tenantId,
        async (client) =>
          (
            await client.query(
              "select capture_method,capture_method_version,context->>'captureMethod' adapter from evidence.source_capture where tenant_id=$1 and id=$2",
              [tenantId, capture.captureId],
            )
          ).rows[0],
      );
      expect(storedCapture).toEqual({ capture_method: "manual", capture_method_version: "1", adapter: "manual@1" });
      expect((await repository.getCaptureByOperation(tenantId, captureOperationId))?.artifact.artifactId).toBe(
        sourceArtifact.artifactId,
      );
      await expect(repository.persistCapture(tenantId, capture)).resolves.toEqual(first);
      await expect(repository.persistCapture(tenantId, { ...capture, captureMethod: "manual@2" })).rejects.toThrow(
        /CAPTURE_IDEMPOTENCY_CONFLICT/,
      );
      await expect(
        repository.persistCapture(tenantId, { ...capture, artifact: { ...sourceArtifact, digest: digest("changed") } }),
      ).rejects.toThrow(/ARTIFACT_METADATA_CONFLICT/);

      const structural = artifact(randomUUID(), `native-${namespace}`, "report_json", "candidate");
      const markdown = artifact(randomUUID(), `markdown-${namespace}`, "report_markdown", "candidate");
      const plain = artifact(randomUUID(), `plain-${namespace}`, "report_json", "candidate");
      const representationId = randomUUID();
      const nodeId = randomUUID();
      const representation = {
        operationId: randomUUID(),
        transformationRunId: randomUUID(),
        sourceCaptureId: capture.captureId,
        sourceArtifact,
        documentId: randomUUID(),
        documentKind: "official_docs",
        canonicalTitle: `Fixture ${namespace}`,
        canonicalSourceId: capture.sourceId,
        identifier: { type: "url" as const, value: capture.canonicalUrl },
        documentVersionId: randomUUID(),
        versionLabel: "v1",
        manifestDigest: digest("manifest"),
        sourceNativeRepresentationId: randomUUID(),
        structuralRepresentationId: representationId,
        providerKey: "fixture",
        providerVersion: "1",
        profileDigest: digest("profile"),
        requestDigest: digest("request"),
        receiptDigest: digest("receipt"),
        outputArtifacts: [structural, markdown, plain],
        structuralArtifactId: structural.artifactId,
        structuralArtifactDigest: structural.digest,
        nodes: [
          {
            id: nodeId,
            tenantId,
            representationId,
            createdAt: "2026-09-04T12:00:00.000Z",
            ordinal: 0,
            stableLocalKey: "paragraph-0",
            kind: "paragraph",
            text: "Durable activity",
            digest: digest("Durable activity"),
            locator: { representationId, nodeId, quoteDigest: digest("Durable activity") },
          },
        ],
        fidelity: { grade: "high" as const, coverage: 1, locatorCoverage: 1, findings: [] },
        receipt: { stable: true },
        completedAt: "2026-09-04T12:00:00.000Z",
      };
      await database.createOperation({
        id: representation.operationId,
        tenantId,
        operationKind: "transformation",
        idempotencyKey: `representation-test:${namespace}`,
        correlationId: randomUUID(),
        actorIdentity: "persistence-test",
        request: { schemaVersion: "test/v1" },
        steps: [],
      });
      const represented = await repository.persistRepresentation(tenantId, representation);
      const lineage = await database.transaction(
        tenantId,
        async (client) =>
          (
            await client.query(
              `select from_artifact_id,to_artifact_id,relation_kind from orchestration.artifact_lineage
          where tenant_id=$1 and transformation_run_id=$2 order by from_artifact_id`,
              [tenantId, representation.transformationRunId],
            )
          ).rows,
      );
      expect(lineage).toEqual(
        representation.outputArtifacts
          .map((output) => ({
            from_artifact_id: output.artifactId,
            to_artifact_id: sourceArtifact.artifactId,
            relation_kind: "derived_from",
          }))
          .sort((a, b) => a.from_artifact_id.localeCompare(b.from_artifact_id)),
      );
      const storedRepresentation = await database.transaction(
        tenantId,
        async (client) =>
          (
            await client.query(
              `select d.document_type_code,t.transformation_kind,t.provider_route,t.parameters from content.document d
          join content.document_version v on v.tenant_id=d.tenant_id and v.document_id=d.id
          join content.document_representation r on r.tenant_id=v.tenant_id and r.document_version_id=v.id
          join content.transformation_run t on t.tenant_id=r.tenant_id and t.id=r.transformation_run_id
          where d.tenant_id=$1 and r.id=$2`,
              [tenantId, representationId],
            )
          ).rows[0],
      );
      expect(storedRepresentation).toMatchObject({
        document_type_code: "official_docs_page",
        transformation_kind: "structural_parse",
        provider_route: "fixture@1",
        parameters: {
          providerKey: "fixture",
          providerVersion: "1",
          documentKind: "official_docs",
          transformationKind: "structural_conversion",
        },
      });
      await expect(repository.persistRepresentation(tenantId, representation)).resolves.toEqual(represented);
      await expect(
        repository.persistRepresentation(tenantId, { ...representation, providerVersion: "2" }),
      ).rejects.toThrow(/TRANSFORMATION_IDEMPOTENCY_CONFLICT/);
      await expect(
        repository.persistRepresentation(tenantId, {
          ...representation,
          nodes: [{ ...representation.nodes[0]!, digest: digest("tampered-node") }],
        }),
      ).rejects.toThrow(/DOCUMENT_NODE_CONFLICT/);

      const chunk = {
        operationId: randomUUID(),
        representationId,
        procedureVersionId: randomUUID(),
        procedureSlug: `fixture-${namespace}`,
        procedureVersion: "1",
        tokenizer: "unicode-word-punctuation-v1",
        profile: { targetTokens: 10 },
        inputDigest: digest("chunk-input"),
        outputDigest: digest(`chunk-output-${namespace}`),
        chunkSetId: randomUUID(),
        chunks: [
          {
            id: randomUUID(),
            ordinal: 0,
            sourceText: "Durable activity",
            contextualPrefix: "",
            embeddingText: "Durable activity",
            sourceTextDigest: digest("Durable activity"),
            embeddingTextDigest: digest("Durable activity"),
            sourceTokenCount: 2,
            embeddingTokenCount: 2,
            role: "headings",
            spans: [{ nodeId, startOffset: 0, endOffset: 16, selectedTextDigest: digest("Durable activity") }],
          },
        ],
      };
      const chunked = await repository.persistChunkSet(tenantId, chunk);
      await expect(repository.persistChunkSet(tenantId, chunk)).resolves.toEqual(chunked);
      await expect(
        repository.persistChunkSet(tenantId, { ...chunk, procedureVersionId: randomUUID() }),
      ).resolves.toEqual(chunked);
      await expect(
        repository.persistChunkSet(tenantId, {
          ...chunk,
          procedureVersionId: randomUUID(),
          profile: { targetTokens: 20 },
        }),
      ).rejects.toThrow("CHUNK_PROCEDURE_CONFLICT");
      await expect(
        repository.persistChunkSet(tenantId, {
          ...chunk,
          chunks: [
            {
              ...chunk.chunks[0]!,
              spans: [{ ...chunk.chunks[0]!.spans[0]!, selectedTextDigest: digest("tampered-span") }],
            },
          ],
        }),
      ).rejects.toThrow(/CHUNK_SPAN_CONFLICT/);
    } finally {
      await database.close();
    }
  });
});
