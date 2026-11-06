import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContentLinkOperationSchema, type ContentLinkOperation } from "@aiengineer/knowledge-contracts";
import { sha256Digest } from "@aiengineer/knowledge-core";
import type { ArtifactLedger, ArtifactRecord, PutArtifactInput } from "../../db-read/index.js";
import type { ContentAdmission, KnowledgeSqlClient, KnowledgeTransactions } from "../../ports.js";
import { ContentSourceReader } from "./sources.js";
import { contentLinkEffect } from "./operations.js";
import { ContentSummaryPreparer } from "./summary-preparation.js";
import type { AuthenticatedContentEvidence } from "./types.js";

const admission = {
  persistPreparedSummary: vi.fn(async () => undefined),
  readRepresentationAdmission: vi.fn(async () => ({
    accepted: false,
    decisionId: null as string | null,
    decision: null as string | null,
  })),
} satisfies ContentAdmission;
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  admission.readRepresentationAdmission.mockResolvedValue({ accepted: false, decisionId: null, decision: null });
});
const tenantId = randomUUID(),
  missionId = randomUUID(),
  attemptId = randomUUID(),
  sourceArtifactId = randomUUID();
const sourceId = randomUUID(),
  representationId = randomUUID(),
  documentVersionId = randomUUID(),
  captureId = randomUUID();
const selectedText = "Café 😀 works on β only.",
  qualifiers = ["β only"],
  text = `${selectedText}\nβ only`,
  digest = sha256Digest("input");
function fixture(capturedText = selectedText) {
  const renderedText = `${capturedText}\nβ only`;
  const reference = {
    claimId: randomUUID(),
    claimKey: "summary",
    claimDigest: digest,
    runId: randomUUID(),
    manifest: { id: randomUUID(), digest },
    assessment: { id: randomUUID(), digest },
    locatorId: randomUUID(),
    captureId,
    role: "supports",
  };
  const operation = ContentLinkOperationSchema.parse({
    kind: "summary.materialize",
    operationId: "summary",
    dependsOn: [],
    evidence: [reference],
    rationale: "Literal admitted summary",
    applicability: { validFrom: null, validTo: null, qualifiers },
    summaryId: randomUUID(),
    documentVersion: { id: documentVersionId, digest },
    representation: { id: randomUUID(), digest: sha256Digest(renderedText) },
    derivedFrom: { id: representationId, digest },
    transformationRunId: randomUUID(),
    summaryKind: "technical",
    scope: "document",
    audience: "engineer",
    text: renderedText,
    tokenCount: 12,
    sources: [{ id: sourceId, representationId, digest, weight: 1 }],
  });
  const evidence: AuthenticatedContentEvidence = {
    reference: operation.evidence[0]!,
    statement: capturedText,
    qualifiers,
    value: contentLinkEffect(operation),
    entityBindings: [],
    downstreamUse: ["content_link:summary.materialize"],
    verdict: "directly_supported",
    policyOutcome: "pass",
    policyDigest: digest,
    eligible: true,
    selectedText: capturedText,
    selectedContentDigest: sha256Digest(capturedText),
    representationArtifactId: sourceArtifactId,
    captureArtifactId: sourceArtifactId,
  };
  const client = {
    query: vi.fn(async () => ({ rows: [{ acceptance_state: "pending" }] })),
  } as unknown as KnowledgeSqlClient;
  const db = {
    transaction: async (_scope: unknown, work: (client: KnowledgeSqlClient) => Promise<unknown>) => work(client),
  } as unknown as KnowledgeTransactions;
  const retained = new Map<string, ArtifactRecord>(),
    values: PutArtifactInput[] = [];
  const artifacts = {
    async putWith(transaction: KnowledgeSqlClient, input: PutArtifactInput) {
      expect(transaction).toBe(client);
      values.push(input);
      const content = input.text ?? JSON.stringify(input.value),
        hash = sha256Digest(content);
      const old = retained.get(hash);
      if (old) return { ...old, reused: true };
      const record: ArtifactRecord = {
        artifactId: randomUUID(),
        artifactType: input.artifactType,
        digest: hash,
        bucket: "test",
        objectPath: hash,
        storageState: "available",
        mediaType: input.mediaType ?? "application/json",
        sizeBytes: new TextEncoder().encode(content).byteLength,
        reused: false,
      };
      retained.set(hash, record);
      return record;
    },
    link: vi.fn(async () => "written"),
  } as unknown as ArtifactLedger;
  vi.spyOn(ContentSourceReader.prototype, "documentVersion").mockResolvedValue({});
  vi.spyOn(ContentSourceReader.prototype, "representation").mockResolvedValue({
    representation_class: "structural_extraction",
    artifact_id: sourceArtifactId,
  });
  vi.spyOn(ContentSourceReader.prototype, "node").mockResolvedValue({
    id: sourceId,
    representationId,
    text: capturedText,
    kind: "paragraph",
  });
  const lineage = vi.spyOn(ContentSourceReader.prototype, "representationCapture").mockResolvedValue({});
  const authority = {
    authenticate: vi.fn(async (input: { client: KnowledgeSqlClient }) => {
      expect(input.client).toBe(client);
      return evidence;
    }),
  };
  const service = new ContentSummaryPreparer({
    db,
    admission,
    artifacts,
    authority,
    tenantId,
    missionId,
    attemptId,
    policyDigest: digest,
  });
  return { operation, evidence, service, values, lineage, authority, client };
}

describe("authenticated deterministic summary preparation", () => {
  it("renders exact admitted Unicode and qualifiers, retains its receipt, and leaves review pending", async () => {
    const value = fixture(),
      result = await value.service.prepare(value.operation);
    expect(result.acceptanceState).toBe("pending");
    expect(value.values[0]).toMatchObject({ artifactType: "content_summary_text", text });
    expect(value.values[1]).toMatchObject({ artifactType: "content_summary_preparation_receipt" });
    expect(value.lineage).toHaveBeenCalledWith(
      value.operation.kind === "summary.materialize" ? value.operation.derivedFrom : {},
      documentVersionId,
      captureId,
    );
    expect(admission.persistPreparedSummary).toHaveBeenCalledWith(
      value.client,
      expect.objectContaining({ tenantId, missionId, attemptId }),
    );
  });
  it("replays stable receipt bytes despite the artifact store's reused flag", async () => {
    const value = fixture(),
      first = await value.service.prepare(value.operation),
      second = await value.service.prepare(value.operation);
    expect(second.outputArtifact.artifactId).toBe(first.outputArtifact.artifactId);
    expect(second.receiptArtifact.artifactId).toBe(first.receiptArtifact.artifactId);
  });
  it("retains decomposed Unicode bytes in the output and JSON receipt without NFC normalization", async () => {
    const decomposed = "Cafe\u0301 😀 works on β only.",
      value = fixture(decomposed);
    await value.service.prepare(value.operation);
    expect(value.values[0]!.text).toBe(`${decomposed}\nβ only`);
    const receipt = value.values[1]!;
    expect(receipt.value).toBeUndefined();
    expect(receipt.mediaType).toBe("application/json");
    const parsed = JSON.parse(receipt.text!);
    expect(parsed.operation.text).toBe(`${decomposed}\nβ only`);
    expect(parsed.admittedClaims[0].selectedText).toBe(decomposed);
    expect(parsed.admittedClaims[0].selectedContentDigest).toBe(sha256Digest(decomposed));
    expect(parsed.admittedClaims[0].selectedText).not.toBe(decomposed.normalize("NFC"));
  });
  it.each(["effect", "policy", "qualifiers", "text", "verdict"])(
    "rejects changed %s before uploading or marking a transformation complete",
    async (field) => {
      const value = fixture();
      const evidence = value.evidence as {
        value: unknown;
        policyDigest: string;
        qualifiers: readonly string[];
        statement: string;
        verdict: string;
      };
      if (field === "effect") evidence.value = "unverified effect";
      if (field === "policy") evidence.policyDigest = sha256Digest("foreign policy");
      if (field === "qualifiers") evidence.qualifiers = [];
      if (field === "text") evidence.statement = "Invented text";
      if (field === "verdict") evidence.verdict = "not_supported";
      await expect(value.service.prepare(value.operation)).rejects.toThrow();
      expect(value.values).toHaveLength(0);
      expect(admission.persistPreparedSummary).not.toHaveBeenCalled();
    },
  );
  it("rejects caller acceptance and undeclared output fields at its strict proposal seam", async () => {
    const value = fixture();
    await expect(value.service.prepare({ ...value.operation, accepted: true })).rejects.toThrow();
    expect(value.authority.authenticate).not.toHaveBeenCalled();
  });
  it("rejects source lineage failure without creating a summary transformation", async () => {
    const value = fixture();
    value.lineage.mockRejectedValue(new Error("CONTENT_SOURCE_BINDING_INVALID"));
    await expect(value.service.prepare(value.operation)).rejects.toThrow("CONTENT_SOURCE_BINDING_INVALID");
    expect(value.values).toHaveLength(0);
  });
});

it.each(["reject", "quarantine", "defer", "request_changes"])(
  "reports latest %s on preparation replay",
  async (decision) => {
    const value = fixture();
    admission.readRepresentationAdmission.mockResolvedValue({ accepted: false, decisionId: "review", decision });
    expect((await value.service.prepare(value.operation)).acceptanceState).toBe(decision);
  },
);
it("reports effective accepted review while the immutable output label remains pending", async () => {
  const value = fixture();
  admission.readRepresentationAdmission.mockResolvedValue({ accepted: true, decisionId: "review", decision: "accept" });
  expect((await value.service.prepare(value.operation)).acceptanceState).toBe("accepted");
});
