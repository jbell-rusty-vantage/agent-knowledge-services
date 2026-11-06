import { describe, expect, it } from "vitest";
import { digestOf } from "./canonical.js";
import { snapshotDigest, validatePersistedSnapshot } from "./snapshot.js";
import type { ReadIntentInput, ReadSnapshot } from "./read-intent.js";

const tenantId = "00000000-0000-7000-8000-000000000001";
const uuid = "00000000-0000-7000-8000-000000000002";
const head = { knowledgeSeq: 4, updatedAt: "2026-01-01T00:00:00Z" };
function fixture() {
  const intent: ReadIntentInput = {
    schemaVersion: "knowledge-read-intent.v1",
    intentId: "preflight",
    context: { tenantId },
    operations: [{ opId: "facts", query: "entity.at", params: { entity_id: uuid, at: "2026-01-01T00:00:00Z" } }],
  };
  const operations: ReadSnapshot["operations"] = [
    {
      opId: "facts",
      kind: "named_query",
      query: "entity.at",
      params: { entity_id: uuid, at: "2026-01-01T00:00:00Z", k: 4 },
      status: "empty",
      truncated: false,
      rowCount: 0,
      rows: [],
      contentDigest: digestOf([]),
      durationMs: 1,
    },
  ];
  const snapshot: ReadSnapshot = {
    schemaVersion: "knowledge-read-snapshot.v1",
    snapshotId: uuid,
    intentRef: { intentId: intent.intentId, intentDigest: digestOf(intent), artifactId: uuid },
    context: { tenantId, executorVersion: "test" },
    contract: { migrationHead: "20260913020000" },
    knowledgeHead: head,
    knowledgeHeadAfter: head,
    headChanged: false,
    atKnowledgeSeq: 4,
    executedAt: head.updatedAt,
    operations,
    snapshotDigest: snapshotDigest(operations, 4),
  };
  const expected = {
    tenantId,
    snapshotDigest: snapshot.snapshotDigest,
    knowledgeSeq: 4,
    migrationHead: snapshot.contract.migrationHead,
  };
  return { intent, snapshot, expected };
}

describe("persisted snapshot admission", () => {
  it("accepts a complete empty result as evidence of absence", () => {
    const { snapshot, intent, expected } = fixture();
    expect(validatePersistedSnapshot(snapshot, intent, expected).snapshotId).toBe(uuid);
  });
  it.each(["skipped", "error", "truncated"] as const)(
    "rejects required %s outcomes even when their digest is valid",
    (status) => {
      const { snapshot, intent, expected } = fixture();
      const operations = [{ ...snapshot.operations[0]!, status }];
      const digest = snapshotDigest(operations, 4);
      expect(() =>
        validatePersistedSnapshot({ ...snapshot, operations, snapshotDigest: digest }, intent, {
          ...expected,
          snapshotDigest: digest,
        }),
      ).toThrowError(expect.objectContaining({ code: "SNAPSHOT_INCOMPLETE" }));
    },
  );
  it("retains optional unavailable retrieval while rejecting it as a required preflight", () => {
    const { snapshot, intent, expected } = fixture();
    const rawIntent = {
      ...intent,
      operations: [{ opId: "search", kind: "retrieval", query: "retrieval.hybrid_search", required: false }],
    };
    const operations: ReadSnapshot["operations"] = [
      {
        opId: "search",
        kind: "retrieval",
        status: "skipped",
        reason: "RETRIEVAL_UNAVAILABLE",
        rowCount: 0,
        truncated: false,
        contentDigest: digestOf(null),
        durationMs: 1,
      },
    ];
    const digest = snapshotDigest(operations, 4);
    const stored = {
      ...snapshot,
      operations,
      snapshotDigest: digest,
      intentRef: { ...snapshot.intentRef, intentDigest: digestOf(rawIntent) },
    };
    expect(
      validatePersistedSnapshot(stored, rawIntent, { ...expected, snapshotDigest: digest }).operations[0]!.reason,
    ).toBe("RETRIEVAL_UNAVAILABLE");
  });
  it("rejects omitted operations, forged rows, changed intent and foreign tenant", () => {
    const { snapshot, intent, expected } = fixture();
    expect(() => validatePersistedSnapshot({ ...snapshot, operations: [] }, intent, expected)).toThrow();
    expect(() =>
      validatePersistedSnapshot(
        { ...snapshot, operations: [{ ...snapshot.operations[0], rows: [{ status: "invented" }] }] },
        intent,
        expected,
      ),
    ).toThrowError(expect.objectContaining({ code: "SNAPSHOT_DIGEST_MISMATCH" }));
    expect(() => validatePersistedSnapshot(snapshot, { ...intent, intentId: "other" }, expected)).toThrowError(
      expect.objectContaining({ code: "SNAPSHOT_DIGEST_MISMATCH" }),
    );
    expect(() => validatePersistedSnapshot(snapshot, intent, { ...expected, tenantId: uuid })).toThrowError(
      expect.objectContaining({ code: "SNAPSHOT_UNAVAILABLE" }),
    );
  });
  it("rejects changed heads, contradictory clocks and stale contracts", () => {
    const { snapshot, intent, expected } = fixture();
    expect(() =>
      validatePersistedSnapshot({ ...snapshot, knowledgeHeadAfter: { ...head, knowledgeSeq: 5 } }, intent, expected),
    ).toThrowError(expect.objectContaining({ code: "SNAPSHOT_CLOCK_CONFLICT" }));
    expect(() => validatePersistedSnapshot(snapshot, intent, { ...expected, knowledgeSeq: 3 })).toThrowError(
      expect.objectContaining({ code: "SNAPSHOT_CLOCK_CONFLICT" }),
    );
    expect(() => validatePersistedSnapshot(snapshot, intent, { ...expected, migrationHead: "other" })).toThrowError(
      expect.objectContaining({ code: "SNAPSHOT_CONTRACT_MISMATCH" }),
    );
  });
});
