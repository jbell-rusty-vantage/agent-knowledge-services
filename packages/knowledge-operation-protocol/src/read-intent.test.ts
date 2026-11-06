import { describe, expect, it } from "vitest";
import { digestCanonical } from "./canonical.js";
import type { JsonValue } from "./canonical.js";
import {
  EFFECTFUL_OPERATIONS,
  EFFECT_DESCRIBING_OPERATIONS,
  EVALUATOR_OPERATIONS,
  HANDLE_OPERATIONS,
  OperationEnvelopeSchema,
  RESULT_OPERATIONS,
} from "./envelope.js";
import {
  KnowledgeReadIntentRequestSchema,
  READ_INTENT_CONTRACT,
  readIntentContentDigest,
  readIntentSnapshotDigest,
  toWireJson,
} from "./read-intent.js";
import { applyEnvelope } from "./test-support.js";

const REQUEST = {
  schemaVersion: "knowledge-read-intent-request.v1",
  purpose: "discovery",
  operations: [{ opId: "head", kind: "named_query", query: "knowledge.head" }],
};

function readIntentEnvelope(overrides: Record<string, unknown> = {}) {
  const base = applyEnvelope();
  const payload = REQUEST as unknown as JsonValue;
  const bytes = Buffer.byteLength(JSON.stringify(payload));
  return {
    ...base,
    operation: "knowledge.read_intent",
    effect: null,
    input: {
      nativeContract: READ_INTENT_CONTRACT,
      payloadDigest: digestCanonical(payload),
      payloadBytes: bytes,
      payloadRef: null,
      inlinePayload: payload,
      upstream: [],
    },
    ...overrides,
  };
}

describe("knowledge.read_intent (OVE-204 slice 4)", () => {
  it("is a synchronous result operation: not effectful, effect-describing, handle or evaluator", () => {
    expect(RESULT_OPERATIONS.has("knowledge.read_intent")).toBe(true);
    expect(EFFECTFUL_OPERATIONS.has("knowledge.read_intent")).toBe(false);
    expect(EFFECT_DESCRIBING_OPERATIONS.has("knowledge.read_intent")).toBe(false);
    expect(HANDLE_OPERATIONS.has("knowledge.read_intent")).toBe(false);
    expect(EVALUATOR_OPERATIONS.has("knowledge.read_intent")).toBe(false);
  });

  it("parses with no effect and no declared use; refuses an effect binding or a use", () => {
    expect(OperationEnvelopeSchema.safeParse(readIntentEnvelope()).success).toBe(true);
    expect(OperationEnvelopeSchema.safeParse(readIntentEnvelope({ effect: applyEnvelope().effect })).success).toBe(
      false,
    );
    expect(
      OperationEnvelopeSchema.safeParse(readIntentEnvelope({ use: "internal_research", audience: "team" })).success,
    ).toBe(false);
  });

  it("allows only the allowlisted named queries and unique op ids, at most 32 operations", () => {
    const parsed = KnowledgeReadIntentRequestSchema.parse(REQUEST);
    expect(parsed.persist).toBe(false);
    expect(parsed.atKnowledgeSeq).toBeNull();
    const query = (name: string) =>
      KnowledgeReadIntentRequestSchema.safeParse({
        ...REQUEST,
        operations: [{ opId: "a", kind: "named_query", query: name }],
      }).success;
    expect(query("entity.card")).toBe(true);
    expect(query("admin.everything")).toBe(false);
    expect(
      KnowledgeReadIntentRequestSchema.safeParse({
        ...REQUEST,
        operations: [
          { opId: "a", kind: "schema_search", query: "entity" },
          { opId: "a", kind: "schema_get", id: "rel:knowledge.entity" },
        ],
      }).success,
    ).toBe(false);
    expect(
      KnowledgeReadIntentRequestSchema.safeParse({
        ...REQUEST,
        operations: Array.from({ length: 33 }, (_, index) => ({
          opId: `op${index}`,
          kind: "schema_search",
          query: "x",
        })),
      }).success,
    ).toBe(false);
    expect(KnowledgeReadIntentRequestSchema.safeParse({ ...REQUEST, sql: "select 1" }).success).toBe(false);
  });

  it("digests protocol JSON: floats become decimal strings, one K01 scheme", () => {
    expect(toWireJson({ a: 0.5, b: 3, c: -0, d: undefined, e: [1.25] })).toEqual({ a: "0.5", b: 3, c: 0, e: ["1.25"] });
    expect(readIntentContentDigest([{ x: 0.5 }])).toBe(digestCanonical([{ x: "0.5" }]));
    expect(readIntentContentDigest(null)).toBe(digestCanonical(null));
    const ops = [
      {
        opId: "a",
        kind: "named_query" as const,
        query: "knowledge.head",
        status: "ok" as const,
        rowCount: 1,
        truncated: false,
        contentDigest: readIntentContentDigest({ knowledge_seq: 3 }),
      },
    ];
    expect(readIntentSnapshotDigest(3, ops)).toBe(
      digestCanonical({ atKnowledgeSeq: 3, operations: ops.map((operation) => ({ ...operation })) }),
    );
  });
});
