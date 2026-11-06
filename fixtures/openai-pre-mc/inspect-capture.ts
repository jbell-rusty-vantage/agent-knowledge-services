import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PostgresCanonicalRepository, PostgresVerificationRepository } from "@aiengineer/knowledge-persistence";
import { SupabaseArtifactStore } from "@aiengineer/knowledge-runtime";
import { disposableDatabaseUrl, disposableStorageConfig } from "../../packages/persistence/test/disposable.mjs";

const databaseUrl = disposableDatabaseUrl();
const storage = disposableStorageConfig();
assert.ok(databaseUrl && storage, "GUARDED_DISPOSABLE_REQUIRED");
const inventory = (await readFile(resolve(import.meta.dirname, "sources.jsonl"), "utf8")).trim().split(/\r?\n/u).map(line => JSON.parse(line));
const source = inventory.find(row => row.leadId === process.argv[2] && row.terminalStatus === "succeeded" && row.tenantId);
assert.ok(source?.resultArtifactId, "ADMITTED_CAPTURE_WITH_TENANT_REQUIRED");
const database = new PostgresCanonicalRepository({ connectionString: databaseUrl });
const repository = new PostgresVerificationRepository(database, new SupabaseArtifactStore({ projectUrl: storage.projectUrl,
  serviceRoleKey: storage.secretKey, bucket: "ai-engineer-cloud-bucket", maximumBytes: 8_000_000 }),
{ async authorize(input) { assert.equal(input.tenantId, source.tenantId); } });
try {
  const artifact = await repository.getLogicalArtifact({ tenantId: source.tenantId, artifactId: source.resultArtifactId });
  assert.ok(artifact);
  const result = JSON.parse(new TextDecoder().decode(artifact.bytes));
  const projection = result.output.projections.find((item: { projectionKind: string }) => ["pdf_text", "html_dom"].includes(item.projectionKind));
  assert.ok(projection);
  const content = await repository.getLogicalArtifact({ tenantId: source.tenantId, artifactId: projection.projectionArtifact.artifactId });
  assert.ok(content);
  const parsed = JSON.parse(new TextDecoder().decode(content.bytes));
  const firstPage = Number(process.argv[3] ?? 1);
  const pageLimit = Number(process.argv[4] ?? 4);
  assert.ok(Number.isSafeInteger(firstPage) && firstPage > 0 && Number.isSafeInteger(pageLimit) && pageLimit > 0 && pageLimit <= 10);
  const selected = parsed.kind === "pdf_text" ? { ...parsed, pages: parsed.pages.filter((page: { physicalPageNumber: number }) => page.physicalPageNumber >= firstPage && page.physicalPageNumber < firstPage + pageLimit), residuals: parsed.residuals?.filter((item: { physicalPageNumber: number }) => item.physicalPageNumber >= firstPage && item.physicalPageNumber < firstPage + pageLimit) } : parsed.kind === "html_dom" && parsed.canonicalText ? { kind: parsed.kind, canonicalText: parsed.canonicalText } : parsed;
  console.log(JSON.stringify({ leadId: source.leadId, captureId: source.captureId, contentDigest: source.contentDigest,
    origin: source.origin, capturedAt: source.capturedAt, tenantId: source.tenantId,
    projectionArtifactId: content.handle.artifactId, projectionDigest: content.handle.digest,
    projection: selected }, null, 2).slice(0, 35000));
} finally { await database.close(); }
