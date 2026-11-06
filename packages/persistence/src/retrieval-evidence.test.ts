import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { digestCanonicalJson, resolveEvidenceSelector } from "@aiengineer/knowledge-verification";
import type { VerificationSelector } from "@aiengineer/knowledge-contracts";
import type { TenantSqlClient } from "./postgres.js";
import { RETRIEVAL_SUPPORT_LIMITS, RetrievalCitationReplay, RetrievalSupportResolver } from "./retrieval-evidence.js";

vi.mock("./content-representation-admission.js", () => ({
  readContentRepresentationAdmission: vi.fn(async () => ({ accepted: true })),
}));

const hash = (value: Uint8Array) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
function fixture() {
  const tenantId = randomUUID(),
    locatorId = randomUUID(),
    captureId = randomUUID(),
    artifactId = randomUUID(),
    sourceId = randomUUID();
  const bytes = new TextEncoder().encode("Café e\u0301 😀 preview only."),
    expectedDigest = hash(bytes);
  const selector: VerificationSelector = { kind: "text_quote", quote: "e\u0301 😀", normalization: "none" };
  const selected = resolveEvidenceSelector({
    captureId,
    representationArtifactId: artifactId,
    representationDigest: expectedDigest,
    selector,
    content: bytes,
  })!;
  const row: Record<string, unknown> = {
    tenant_id: tenantId,
    id: locatorId,
    capture_id: captureId,
    source_family_id: sourceId,
    capture_artifact_id: artifactId,
    representation_artifact_id: artifactId,
    capture_sha256: expectedDigest.slice(7),
    resolution_state: "resolved",
    selector,
    selector_sha256: digestCanonicalJson(selector).slice(7),
    selected_content_sha256: selected.resolution.selectedContentDigest!.slice(7),
    selected_size_bytes: selected.selectedContent.byteLength,
    occurrence_count: selected.resolution.occurrenceCount,
    normalization_policy: selected.resolution.normalization,
    resolution_version: selected.resolution.resolverVersion,
  };
  const metadata: Record<string, unknown> = {
    tenant_id: tenantId,
    id: artifactId,
    sha256: expectedDigest.slice(7),
    storage_state: "available",
    size_bytes: bytes.byteLength,
    media_type: "text/plain",
  };
  const client = {
    query: vi.fn(async (sql: string) => ({
      rows: [sql.includes("from evidence.locator") ? row : metadata],
      rowCount: 1,
    })),
  } as unknown as TenantSqlClient;
  const read = vi.fn(async () => ({ bytes, mediaType: "text/plain" }));
  const input = {
    tenantId,
    locatorId,
    selectorDigest: `sha256:${row.selector_sha256}`,
    selectedContentDigest: `sha256:${row.selected_content_sha256}`,
  };
  return { replay: new RetrievalCitationReplay(client, read), client, read, row, metadata, input, bytes, sourceId };
}

describe("bounded canonical citation byte replay", () => {
  it("replays actual native Unicode selectors and groups by canonical capture source", async () => {
    const value = fixture();
    expect(await value.replay.replay(value.input)).toMatchObject({
      selectedText: "e\u0301 😀",
      sourceFamilyId: value.sourceId,
      selectedContentDigest: value.input.selectedContentDigest,
      selectedSizeBytes: 8,
    });
    await value.replay.replay(value.input);
    expect(value.read).toHaveBeenCalledTimes(1);
  });
  it.each(["tenant", "selector", "quote", "resolution", "count", "size", "normalization", "resolver"])(
    "rejects altered %s after valid replay",
    async (field) => {
      const value = fixture();
      await expect(value.replay.replay(value.input)).resolves.toHaveProperty("selectedText");
      const change: Record<string, unknown> = {
        tenant: { tenant_id: randomUUID() },
        selector: { selector_sha256: "0".repeat(64) },
        quote: { selected_content_sha256: "0".repeat(64) },
        resolution: { resolution_state: "ambiguous" },
        count: { occurrence_count: 2 },
        size: { selected_size_bytes: 1 },
        normalization: { normalization_policy: "lf" },
        resolver: { resolution_version: "invented" },
      };
      Object.assign(value.row, change[field]);
      await expect(value.replay.replay(value.input)).rejects.toThrow();
    },
  );
  it.each(["bytes", "length", "media"])("rejects remote %s drift", async (field) => {
    const value = fixture();
    value.read.mockResolvedValue({
      bytes:
        field === "bytes"
          ? value.bytes.map((byte) => byte ^ 1)
          : field === "length"
            ? value.bytes.slice(1)
            : value.bytes,
      mediaType: field === "media" ? "application/json" : "text/plain",
    });
    await expect(value.replay.replay(value.input)).rejects.toThrow("RETRIEVAL_ARTIFACT_BYTES_MISMATCH");
  });
  it.each(["missing", "foreign", "oversize", "digest"])(
    "denies %s canonical artifact metadata before remote read",
    async (field) => {
      const value = fixture();
      const change: Record<string, unknown> = {
        missing: { storage_state: "missing" },
        foreign: { tenant_id: randomUUID() },
        oversize: { size_bytes: 8_000_001 },
        digest: { sha256: "0".repeat(64) },
      };
      Object.assign(value.metadata, change[field]);
      await expect(value.replay.replay(value.input)).rejects.toThrow("RETRIEVAL_ARTIFACT_UNAVAILABLE");
      expect(value.read).not.toHaveBeenCalled();
    },
  );
  it("bounds citation operations even when all bytes are cached", async () => {
    const value = fixture();
    for (let i = 0; i < 128; i++) await value.replay.replay(value.input);
    await expect(value.replay.replay(value.input)).rejects.toThrow("RETRIEVAL_CITATION_LIMIT");
    expect(value.read).toHaveBeenCalledTimes(1);
  });
  it("rejects remote missing objects without substituting persisted metadata", async () => {
    const value = fixture();
    value.read.mockRejectedValue(new Error("OBJECT_MISSING"));
    await expect(value.replay.replay(value.input)).rejects.toThrow("OBJECT_MISSING");
  });
});

function supportFixture(
  overrides: {
    paths?: number;
    conflicts?: boolean;
    superseded?: boolean;
    captureBytes?: number;
    temporal?: boolean;
  } = {},
) {
  const tenantId = randomUUID(),
    vectorItemId = randomUUID(),
    projectionId = randomUUID(),
    targetId = randomUUID();
  const recordId = randomUUID(),
    otherClaimId = randomUUID(),
    olderClaimId = randomUUID();
  const sha = (seed: string) => createHash("sha256").update(seed).digest("hex");
  const paths = Array.from({ length: overrides.paths ?? 1 }, (_, index) => ({
    vector_item_id: vectorItemId,
    claim_id: randomUUID(),
    claim_status: "verified",
    verification_run_id: randomUUID(),
    admission_digest: `sha256:${sha(`audit-${index}`)}`,
    qualifiers: ["in preview"],
    assessment_verdict: "directly_supported",
    locator_id: randomUUID(),
    selector_sha256: sha(`selector-${index}`),
    selected_content_sha256: sha(`selected-${index}`),
    capture_id: randomUUID(),
    source_family_id: index % 2 === 0 ? "11111111-1111-4111-8111-111111111111" : "22222222-2222-4222-8222-222222222222",
    representation_id: randomUUID(),
    capture_artifact_id: randomUUID(),
    capture_artifact_sha256: sha(`capture-${index}`),
    capture_media_type: "text/plain",
    capture_size_bytes: overrides.captureBytes ?? 32,
  }));
  const targetRow = {
    vector_item_id: vectorItemId,
    search_projection_id: projectionId,
    projection_target_id: targetId,
    target_kind: "record",
    entity_id: null,
    record_id: recordId,
    chunk_id: null,
    claim_id: null,
    summary_id: null,
  };
  const conflictRows = overrides.conflicts ? [{ claim_a_id: paths[0]!.claim_id, claim_b_id: otherClaimId }] : [];
  const lineageRows = paths.map((path) => ({
    claim_id: path.claim_id,
    superseded_by_id: otherClaimId,
    older_id: overrides.superseded ? olderClaimId : null,
  }));
  const client = {
    query: vi.fn(async (sql: string) => {
      if (sql.includes("with recursive required_edges"))
        return {
          rows: paths.map((path) => ({
            artifact_id: path.capture_artifact_id,
            storage_state: "available",
            representation_id: path.representation_id,
            authorized: true,
            capture_root: true,
            report_version_id: null,
          })),
        };
      if (sql.includes("from retrieval.vector_item vi\n      join retrieval.search_projection sp"))
        return { rows: [targetRow], rowCount: 1 };
      if (sql.includes("evidence.claim_conflict")) return { rows: conflictRows, rowCount: conflictRows.length };
      if (sql.includes("older.superseded_by_id=c.id")) return { rows: lineageRows, rowCount: lineageRows.length };
      if (sql.includes("from temporal.segment newer"))
        return {
          rows: overrides.temporal
            ? [
                { relation: "supersedes", claim_id: paths[0]!.claim_id, other_claim_id: olderClaimId },
                { relation: "challenges", claim_id: otherClaimId, other_claim_id: paths[0]!.claim_id },
              ]
            : [],
        };
      return { rows: paths, rowCount: paths.length };
    }),
  } as unknown as TenantSqlClient;
  return {
    tenantId,
    vectorItemId,
    recordId,
    targetId,
    otherClaimId,
    olderClaimId,
    paths,
    client,
    resolver: new RetrievalSupportResolver(client),
    request: { tenantId, vectorItemIds: [vectorItemId], knowledgeSeq: 7 },
  };
}

describe("bounded canonical target, claim and assessment resolution", () => {
  it.each([0, 6])(
    "requires exact current knowledge equality for unversioned relations at K=%i",
    async (knowledgeSeq) => {
      const f = supportFixture();
      const [support] = await f.resolver.resolve({ ...f.request, knowledgeSeq });
      expect(support!.contradictionIds).toEqual([]);
      expect(support!.supersedesIds).toEqual([]);
      const calls = (f.client.query as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([sql]) => sql.includes("evidence.claim_conflict") || sql.includes("older.superseded_by_id=c.id"),
      );
      expect(calls).toHaveLength(2);
      for (const [sql, parameters] of calls) {
        expect(parameters[2]).toBe(knowledgeSeq);
        expect(sql).toContain("$3=(select knowledge_seq from temporal.knowledge_head where tenant_id=$1)");
        expect(sql).not.toContain("coalesce");
      }
    },
  );
  it("bounds legacy conflict and supersession endpoints by tenant, admission and requested knowledge", async () => {
    const f = supportFixture({ superseded: true });
    const [support] = await f.resolver.resolve(f.request);
    expect(support!.supersedesIds).toEqual([f.olderClaimId]);
    expect(support!.contradictionIds).toEqual([]);
    const calls = (f.client.query as ReturnType<typeof vi.fn>).mock.calls;
    for (const [needle, aliases] of [
      ["evidence.claim_conflict", ["a", "b"]],
      ["older.superseded_by_id=c.id", ["c", "older"]],
    ] as const) {
      const call = calls.find(([sql]) => sql.includes(needle))!;
      expect(call[1]).toEqual([f.tenantId, [f.paths[0]!.claim_id], 7]);
      expect(call[0]).toContain("$3=(select knowledge_seq from temporal.knowledge_head where tenant_id=$1)");
      for (const alias of aliases) {
        expect(call[0]).toContain(`retrieval.history_claim_authorized(${alias}.id)`);
        expect(call[0]).toContain(`retrieval.history_receipt_k(${alias}.created_by_receipt_id)<=$3`);
      }
      expect(call[0]).toContain(`limit ${RETRIEVAL_SUPPORT_LIMITS.maximumRows + 1}`);
    }
    expect(calls.find(([sql]) => sql.includes("evidence.claim_conflict"))![0]).toContain(
      "k.conflict_kind='contradiction'",
    );
  });
  it("reads admitted temporal corrections and explicit challenges at the requested knowledge sequence", async () => {
    const f = supportFixture({ temporal: true });
    const [support] = await f.resolver.resolve(f.request);
    expect(support!.supersedesIds).toEqual([f.olderClaimId]);
    expect(support!.contradictionIds).toEqual([f.otherClaimId]);
    const call = (f.client.query as ReturnType<typeof vi.fn>).mock.calls.find(([sql]) =>
      sql.includes("from temporal.segment newer"),
    );
    expect(call![1]).toEqual([f.tenantId, [f.paths[0]!.claim_id], 7]);
    expect(call![0]).toContain("older.k_to=newer.k_from");
    expect(call![0]).toContain("support.role='challenges'");
    expect(call![0]).toContain("retrieval.history_claim_authorized(support.claim_id)");
  });
  it("binds the canonical target, admitted claims, locators and source families", async () => {
    const f = supportFixture({ paths: 2, conflicts: true, superseded: true });
    const [support] = await f.resolver.resolve(f.request);
    expect(support).toMatchObject({
      vectorItemId: f.vectorItemId,
      truncated: false,
      target: { kind: "record", canonicalId: f.recordId, projectionTargetId: f.targetId },
    });
    expect(support!.paths).toHaveLength(2);
    expect(support!.paths[0]!.qualifiers).toEqual(["in preview"]);
    expect(support!.sourceFamilyIds).toEqual([
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    ]);
    expect(support!.graphPaths[0]).toEqual([
      `projection_target:${f.targetId}`,
      `claim:${f.paths[0]!.claim_id}`,
      `locator:${f.paths[0]!.locator_id}`,
      `capture:${f.paths[0]!.capture_id}`,
      `source:${f.paths[0]!.source_family_id}`,
    ]);
    expect(support!.contradictionIds).toContain(f.otherClaimId);
    expect(support!.supersedesIds).toEqual([f.olderClaimId]);
  });
  it("marks a candidate truncated instead of returning an unbounded closure", async () => {
    const f = supportFixture({ paths: RETRIEVAL_SUPPORT_LIMITS.maximumPathsPerCandidate + 3 });
    const [support] = await f.resolver.resolve(f.request);
    expect(support!.paths).toHaveLength(RETRIEVAL_SUPPORT_LIMITS.maximumPathsPerCandidate);
    expect(support!.truncated).toBe(true);
  });
  it("refuses a traversal whose capture bytes exceed the query budget", async () => {
    const f = supportFixture({ paths: 8, captureBytes: RETRIEVAL_SUPPORT_LIMITS.maximumCaptureBytes });
    await expect(f.resolver.resolve(f.request)).rejects.toThrow("RETRIEVAL_SUPPORT_BYTE_LIMIT");
  });
  it("omits a candidate with no admitted support rather than reporting an unsupported member", async () => {
    const f = supportFixture();
    f.paths.length = 0;
    expect(await f.resolver.resolve(f.request)).toEqual([]);
  });
  it.each(["admission_digest", "selector_sha256", "assessment_verdict", "claim_status", "verification_run_id"])(
    "rejects an altered %s binding",
    async (field) => {
      const f = supportFixture();
      Object.assign(f.paths[0]!, {
        [field]:
          field === "assessment_verdict" ? "context_only" : field === "claim_status" ? "proposed" : "not-a-digest",
      });
      await expect(f.resolver.resolve(f.request)).rejects.toThrow("RETRIEVAL_SUPPORT_BINDING_INVALID");
    },
  );
  it.each([
    ["tenant", { tenantId: "not-a-uuid" }],
    ["clock", { knowledgeSeq: -1 }],
    ["duplicates", { vectorItemIds: ["11111111-1111-4111-8111-111111111111", "11111111-1111-4111-8111-111111111111"] }],
    ["candidate", { vectorItemIds: ["nope"] }],
  ])("refuses an invalid %s in the request", async (_label, patch) => {
    const f = supportFixture();
    await expect(f.resolver.resolve({ ...f.request, ...patch } as never)).rejects.toThrow(
      "RETRIEVAL_SUPPORT_REQUEST_INVALID",
    );
    expect(f.client.query).not.toHaveBeenCalled();
  });
  it("rejects a projection target whose typed canonical identity is missing", async () => {
    const f = supportFixture();
    const client = {
      query: vi.fn(async (sql: string) =>
        sql.includes("join retrieval.search_projection sp")
          ? {
              rows: [
                {
                  vector_item_id: f.vectorItemId,
                  search_projection_id: randomUUID(),
                  projection_target_id: f.targetId,
                  target_kind: "record",
                  entity_id: null,
                  record_id: null,
                  chunk_id: null,
                  claim_id: null,
                  summary_id: null,
                },
              ],
              rowCount: 1,
            }
          : { rows: [], rowCount: 0 },
      ),
    } as unknown as TenantSqlClient;
    await expect(new RetrievalSupportResolver(client).resolve(f.request)).rejects.toThrow(
      "RETRIEVAL_TARGET_IDENTITY_INVALID",
    );
  });
});
