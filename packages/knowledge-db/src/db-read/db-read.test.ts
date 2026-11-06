import { describe, expect, it } from "vitest";
import { canonicalJson, digestOf } from "./canonical.js";
import { applyDefaults, validateSchema } from "./json-schema.js";
import type { OperationResult } from "./read-intent.js";
import { resolveReferences } from "./references.js";
import { assertSingleReadStatement } from "./sql-guard.js";
import { isUuid, uuidv7 } from "./uuid.js";

describe("canonicalJson (RFC 8785)", () => {
  it("sorts keys by code point, drops undefined, keeps array order, normalizes strings", () => {
    expect(canonicalJson({ b: 1, a: [3, 1, { z: null, y: undefined }], é: "e\u0301" })).toBe(
      '{"a":[3,1,{"z":null}],"b":1,"é":"é"}',
    );
  });

  it("encodes numbers in shortest round-trip form and rejects non-finite", () => {
    expect(canonicalJson({ n: 1e21, m: 0.1 + 0.2, k: 10 })).toBe('{"k":10,"m":0.30000000000000004,"n":1e+21}');
    expect(() => canonicalJson({ n: Number.NaN })).toThrow(TypeError);
  });

  it("yields identical digests for semantically equal objects", () => {
    expect(digestOf({ a: 1, b: [true] })).toBe(digestOf({ b: [true], a: 1 }));
    expect(digestOf({ a: 1 })).not.toBe(digestOf({ a: 2 }));
  });
});

describe("uuidv7", () => {
  it("produces valid, time-ordered identifiers", () => {
    const first = uuidv7(1_700_000_000_000);
    const second = uuidv7(1_700_000_000_001);
    expect(isUuid(first)).toBe(true);
    expect(first.slice(14, 15)).toBe("7");
    expect(first < second).toBe(true);
  });
});

describe("json-schema subset", () => {
  const schema = {
    type: "object",
    required: ["entity_id"],
    properties: {
      entity_id: { type: "string", format: "uuid" },
      k: { type: ["integer", "null"], default: null },
      limit: { type: "integer", minimum: 1, maximum: 100, default: 25 },
      kinds: { type: "array", items: { type: "string", enum: ["organization", "person"] } },
    },
    additionalProperties: false,
  };

  it("accepts valid params after defaults", () => {
    const params = applyDefaults(schema, { entity_id: "0192c0f1-1a2b-7c3d-8e4f-000000000001" });
    expect(params).toEqual({ entity_id: "0192c0f1-1a2b-7c3d-8e4f-000000000001", k: null, limit: 25 });
    expect(validateSchema(schema, params)).toEqual([]);
  });

  it("reports missing, extra, format, bound, and enum violations by path", () => {
    const issues = validateSchema(schema, { k: "x", limit: 500, extra: 1, kinds: ["robot"] });
    expect(issues.map((issue) => issue.path)).toEqual(["entity_id", "k", "limit", "extra", "kinds[0]"]);
    expect(validateSchema(schema, { entity_id: "not-a-uuid" })[0]?.message).toContain("uuid");
  });
});

describe("assertSingleReadStatement", () => {
  it("admits one select or with-select", () => {
    expect(assertSingleReadStatement("select 1;")).toBe("select 1");
    expect(assertSingleReadStatement("with h as (select 1) select * from h")).toContain("with h");
  });

  it("rejects writes, multi-statements, non-select, and context mutators", () => {
    expect(() => assertSingleReadStatement("delete from corpus.entity")).toThrowError(
      expect.objectContaining({ code: "SQL_NOT_SELECT" }),
    );
    expect(() => assertSingleReadStatement("select 1; select 2")).toThrowError(
      expect.objectContaining({ code: "SQL_MULTI_STATEMENT" }),
    );
    expect(() =>
      assertSingleReadStatement("with w as (delete from corpus.entity returning id) select * from w"),
    ).toThrowError(expect.objectContaining({ code: "SQL_FORBIDDEN_KEYWORD" }));
    expect(() => assertSingleReadStatement("select set_config('app.tenant_id','x',true)")).toThrowError(
      expect.objectContaining({ code: "SQL_FORBIDDEN_FUNCTION" }),
    );
    expect(assertSingleReadStatement("select 'delete; from' as literal")).toBeTruthy();
  });
});

describe("resolveReferences", () => {
  const completed = new Map<string, OperationResult>([
    [
      "resolve",
      {
        opId: "resolve",
        kind: "named_query",
        status: "ok",
        rowCount: 1,
        truncated: false,
        rows: [{ entity_id: "e-1", kind: "organization" }],
        contentDigest: "sha256:0",
        durationMs: 1,
      },
    ],
    [
      "card",
      {
        opId: "card",
        kind: "named_query",
        status: "ok",
        rowCount: 1,
        truncated: false,
        value: { entity: { id: "e-1" } },
        contentDigest: "sha256:0",
        durationMs: 1,
      },
    ],
  ]);

  it("resolves row and value paths and reports unresolved ones", () => {
    const result = resolveReferences(
      { a: "$resolve.rows[0].entity_id", b: "$card.value.entity.id", c: "$resolve.rows[9].entity_id", d: "literal" },
      completed,
    );
    expect(result.params).toEqual({ a: "e-1", b: "e-1", d: "literal" });
    expect(result.resolvedFrom).toEqual({ a: "$resolve.rows[0].entity_id", b: "$card.value.entity.id" });
    expect(result.unresolved).toEqual(["c ← $resolve.rows[9].entity_id"]);
  });
});
