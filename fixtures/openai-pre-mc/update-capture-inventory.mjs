import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";

const root = import.meta.dirname;
const readJson = async name => JSON.parse(await readFile(resolve(root, name), "utf8"));
const readLines = async name => (await readFile(resolve(root, name), "utf8")).trim().split(/\r?\n/u).filter(Boolean).map(JSON.parse);
const rows = await readLines("sources.jsonl");
const sources = new Map(rows.filter(row => row.captureId).map(row => [row.captureId, row]));
const leads = new Map((await readLines("source-leads.jsonl")).filter(row => row.url).map(row => [row.seedId, row]));
const manifest = await readJson("fixture.manifest.json");
for (const name of process.argv.slice(2)) {
  assert.equal(basename(name), name, "Receipt must be a named file in this fixture directory");
  assert.match(name, /^capture-primary-sources(?:\.[a-f0-9-]+)?\.result\.json$/u);
  const receipt = await readJson(name);
  assert.equal(receipt.schemaVersion, "openai-pre-mc-capture-result.v1");
  for (const capture of receipt.sources ?? receipt.partialSources ?? []) {
    assert.match(capture.contentDigest, /^sha256:[a-f0-9]{64}$/u);
    assert.ok(["succeeded", "captured_parser_failed"].includes(capture.terminalStatus));
    const existing = sources.get(capture.captureId);
    if (existing) assert.equal(existing.contentDigest, capture.contentDigest, "Capture identity changed");
    sources.set(capture.captureId, {
      ...existing,
      sourceInventoryId: existing?.sourceInventoryId ?? `openai-pre-mc-${capture.captureId}`,
      leadId: capture.seedId, origin: capture.requestedUrl, sourceKind: leads.get(capture.seedId)?.sourceKind ?? "web_page",
      tenantId: receipt.tenantId, sourceId: capture.sourceId, captureId: capture.captureId,
      operationId: capture.operationId, capturedAt: capture.capturedAt, contentDigest: capture.contentDigest,
      contentBytes: capture.contentBytes, sourceArtifactId: capture.sourceArtifactId,
      acquisitionReceiptArtifactId: capture.acquisitionReceiptArtifactId,
      ...(capture.resultArtifactId ? { resultArtifactId: capture.resultArtifactId } : {}),
      captureMethod: "https_acquire", captureMethodVersion: "verification-source-acquisition.v1",
      authority: capture.authority, rights: capture.rights, temporal: capture.temporal,
      terminalStatus: capture.terminalStatus, projectionStatus: capture.terminalStatus === "succeeded" ? "admitted" : "not_admitted",
      reviewStatus: "review_required", proofReceipt: name,
    });
  }
  const bytes = await readFile(resolve(root, name));
  manifest.captureReceipts ??= {};
  manifest.captureReceipts[name] = { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length, passed: receipt.passed };
}
const captures = [...sources.values()];
const documents = new Map();
for (const capture of captures) {
  const key = `${capture.origin}\n${capture.contentDigest}`;
  if (!documents.has(key) || capture.terminalStatus === "succeeded") documents.set(key, capture);
}
const header = { _status: "incomplete", _kind: "source_inventory_header", notAdmissionGold: true,
  schemaNote: "Distinct origin/digest documents and capture attempts are counted separately. Parser failure retains raw custody only. Candidate inclusion, year coverage, labels, and human review remain incomplete." };
await writeFile(resolve(root, "sources.jsonl"), [header, ...captures].map(row => JSON.stringify(row)).join("\n") + "\n");
manifest.artifactStorage.captures = [...documents.values()];
manifest.custodyProgress = { captureAttempts: captures.length, distinctOriginDigests: documents.size,
  admittedDocuments: [...documents.values()].filter(row => row.terminalStatus === "succeeded").length,
  requiredDocuments: 36, candidateLabelsComplete: false, inclusionReview: "review_required" };
manifest.missingCaptureBytes = { note: "Captured bytes are retained in the configured artifact store and referenced above; no raw documents are copied into this fixture directory." };
for (const artifact of Object.values(manifest.artifacts)) {
  const bytes = await readFile(resolve(root, artifact.path));
  artifact.sha256 = createHash("sha256").update(bytes).digest("hex");
  artifact.bytes = bytes.length;
}
await writeFile(resolve(root, "fixture.manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify(manifest.custodyProgress));
