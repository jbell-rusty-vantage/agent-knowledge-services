import { describe, expect, it } from "vitest";
import {
  admitExtractionSchema,
  validateExtractionCandidate,
  verifyExtractionFields,
  verifyExtractionFieldsWithEvidence,
  type AdmittedExtractionSchema,
  type ExtractionEvidence,
  type ExtractionFieldRule,
} from "./index.js";
import { canonicalizeJson, sha256Digest } from "../canonical/index.js";
import { ProjectionSelectorResolver } from "../evidence-selection/index.js";

const encoder = new TextEncoder();
const schema = (properties: Record<string, unknown>, required = Object.keys(properties)): AdmittedExtractionSchema => {
  const admitted = admitExtractionSchema({
    schemaId: "invoice",
    schemaVersion: "1",
    schema: {
      type: "object",
      description: "Invoice fields.",
      properties,
      required,
      additionalProperties: false,
    },
  });
  expect(admitted.admitted).toBe(true);
  return admitted.schema!;
};
const string = (description = "A semantic field.") => ({
  type: "string",
  description,
  maxLength: 128,
});
const representation = (value: unknown) => {
  const content = encoder.encode(JSON.stringify(value));
  return { content };
};
const digest = (bytes: Uint8Array): `sha256:${string}` => sha256Digest(bytes);
const verify = async (
  candidate: unknown,
  fields: readonly ExtractionFieldRule[],
  evidence: readonly Omit<ExtractionEvidence, "captureId" | "representationArtifactId" | "representationDigest">[],
  source: unknown = candidate,
) => {
  const item = representation(source);
  const contentDigest = digest(item.content);
  return verifyExtractionFields({
    schema: schema(
      Object.fromEntries(Object.keys(candidate as Record<string, unknown>).map((key) => [key, string()])),
      Object.keys(candidate as Record<string, unknown>),
    ),
    candidate,
    fields,
    evidence: evidence.map((entry) => ({
      ...entry,
      captureId: "capture-1",
      representationArtifactId: "artifact-1",
      representationDigest: contentDigest,
    })),
    representations: [
      {
        captureId: "capture-1",
        artifactId: "artifact-1",
        digest: contentDigest,
        content: item.content,
      },
    ],
  });
};

describe("bounded structured extraction", () => {
  it("admits only an explicit bounded subset and has a stable schema digest", () => {
    const good = {
      type: "object",
      description: "Record.",
      properties: { value: string("Measured value.") },
      required: ["value"],
      additionalProperties: false,
    };
    const first = admitExtractionSchema({
      schemaId: "record",
      schemaVersion: "1",
      schema: good,
    });
    const reordered = admitExtractionSchema({
      schemaId: "record",
      schemaVersion: "1",
      schema: {
        additionalProperties: false,
        required: ["value"],
        properties: { value: string("Measured value.") },
        description: "Record.",
        type: "object",
      },
    });
    expect(first.admitted).toBe(true);
    expect(first.schema!.schemaDigest).toBe(reordered.schema!.schemaDigest);
    const remoteRef = { ...good, $ref: "https://attacker/schema" };
    const unsafePattern = {
      ...good,
      properties: {
        value: {
          type: "string",
          description: "x",
          maxLength: 10,
          pattern: "(a+)+$",
        },
      },
    };
    const unboundedString = {
      ...good,
      properties: { value: { type: "string", description: "x" } },
    };
    expect(
      admitExtractionSchema({
        schemaId: "record",
        schemaVersion: "1",
        schema: remoteRef,
      }).admitted,
    ).toBe(false);
    expect(
      admitExtractionSchema({
        schemaId: "record",
        schemaVersion: "1",
        schema: unsafePattern,
      }).admitted,
    ).toBe(false);
    expect(
      admitExtractionSchema({
        schemaId: "record",
        schemaVersion: "1",
        schema: unboundedString,
      }).admitted,
    ).toBe(false);
  });

  it("keeps absent, null, and additional properties distinct", () => {
    const admitted = schema(
      {
        requiredValue: string(),
        nullableValue: {
          type: ["string", "null"],
          description: "Nullable semantic field.",
          maxLength: 128,
        },
      },
      ["requiredValue", "nullableValue"],
    );
    expect(validateExtractionCandidate(admitted, { nullableValue: null }).checks.map((item) => item.code)).toContain(
      "CANDIDATE_REQUIRED_MISSING",
    );
    expect(
      validateExtractionCandidate(admitted, {
        requiredValue: null,
        nullableValue: null,
      }).checks.map((item) => item.code),
    ).toContain("CANDIDATE_TYPE");
    expect(
      validateExtractionCandidate(admitted, {
        requiredValue: "ok",
        nullableValue: null,
        invented: "x",
      }).checks.map((item) => item.code),
    ).toContain("CANDIDATE_ADDITIONAL_PROPERTY");
    expect(
      validateExtractionCandidate(admitted, {
        requiredValue: "ok",
        nullableValue: null,
      }).valid,
    ).toBe(true);
    const open = admitExtractionSchema({
      schemaId: "open",
      schemaVersion: "1",
      schema: {
        type: "object",
        description: "Open record.",
        properties: {},
        required: [],
        additionalProperties: true,
      },
    }).schema!;
    expect(validateExtractionCandidate(open, { undeclared: { nested: "leaf" } }).leafPaths).toEqual([
      "/undeclared/nested",
    ]);
  });

  it("retains an immutable admitted snapshot and rejects inapplicable keywords, property bounds, and malformed candidates", () => {
    const mutable = {
      type: "object",
      description: "Record.",
      properties: {
        value: {
          type: "string",
          description: "Value.",
          maxLength: 2,
          enum: ["😀"],
        },
      },
      required: ["value"],
      additionalProperties: false,
      minProperties: 1,
      maxProperties: 1,
    };
    const admitted = admitExtractionSchema({
      schemaId: "immutable",
      schemaVersion: "1",
      schema: mutable,
    }).schema!;
    mutable.properties.value.maxLength = 128;
    mutable.properties.value.enum[0] = "ab";
    expect(validateExtractionCandidate(admitted, { value: "😀" }).valid).toBe(true); // JSON Schema length is Unicode code points.
    expect(validateExtractionCandidate(admitted, { value: "ab" }).valid).toBe(false);
    expect(
      admitExtractionSchema({
        schemaId: "bad",
        schemaVersion: "1",
        schema: {
          type: "object",
          description: "x",
          properties: {},
          required: [],
          additionalProperties: false,
          enum: [],
        },
      }).admitted,
    ).toBe(false);
    expect(
      admitExtractionSchema({
        schemaId: "bad",
        schemaVersion: "1",
        schema: { type: "number", description: "x", minLength: 1 },
      }).admitted,
    ).toBe(false);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(validateExtractionCandidate(admitted, cyclic).checks[0]?.code).toBe("CANDIDATE_NOT_JSON");
    const deep: Record<string, unknown> = {};
    let current = deep;
    for (let index = 0; index < 66; index += 1) {
      current.child = {};
      current = current.child as Record<string, unknown>;
    }
    current.value = "x";
    expect(validateExtractionCandidate(openSchema(), deep).checks.map((item) => item.code)).toContain(
      "CANDIDATE_PREFLIGHT_EXCEEDED",
    );
    expect(
      admitExtractionSchema({
        schemaId: "loose",
        schemaVersion: "1",
        schema: mutable,
        limits: { maxCandidateBytes: 1_048_577 },
      }).admitted,
    ).toBe(false);
  });

  it("re-resolves selected immutable evidence and rejects a wrong adjacent cell or forged success flag", async () => {
    const source = { rows: [{ amount: "10.00" }, { amount: "11.00" }] };
    const result = await verify(
      { amount: "10.00" },
      [{ path: "/amount", comparison: "decimal" }],
      [
        {
          path: "/amount",
          selector: { kind: "json_pointer", pointer: "/rows/1/amount" },
          status: "resolved",
        } as unknown as Omit<ExtractionEvidence, "captureId" | "representationArtifactId" | "representationDigest">,
      ],
      source,
    );
    expect(result.valid).toBe(false);
    expect(result.checks.some((item) => item.code === "FIELD_DECIMAL_MATCH" && item.status === "failed")).toBe(true);
  });

  it("uses exact decimal core for precision, totals, and duplicates", async () => {
    const result = await verify(
      { partA: "0.1", partB: "0.2", total: "0.3" },
      [
        { path: "/partA", comparison: "decimal" },
        { path: "/partB", comparison: "decimal" },
        { path: "/total", comparison: "decimal" },
      ],
      [
        {
          path: "/partA",
          selector: { kind: "json_pointer", pointer: "/partA" },
        },
        {
          path: "/partB",
          selector: { kind: "json_pointer", pointer: "/partB" },
        },
        {
          path: "/total",
          selector: { kind: "json_pointer", pointer: "/total" },
        },
      ],
      { partA: "0.1", partB: "0.2", total: "0.3" },
    );
    expect(result.valid).toBe(true);
    const invalid = { partA: "0.1", partB: "0.2", total: "0.31" };
    const content = encoder.encode(JSON.stringify(invalid));
    const contentDigest = digest(content);
    const totalRule = verifyExtractionFields({
      schema: schema({ partA: string(), partB: string(), total: string() }),
      candidate: invalid,
      fields: ["/partA", "/partB", "/total"].map((path) => ({
        path,
        comparison: "decimal",
      })),
      evidence: ["/partA", "/partB", "/total"].map((path) => ({
        path,
        captureId: "capture-1",
        representationArtifactId: "artifact-1",
        representationDigest: contentDigest,
        selector: { kind: "json_pointer", pointer: path },
      })),
      representations: [
        {
          captureId: "capture-1",
          artifactId: "artifact-1",
          digest: contentDigest,
          content,
        },
      ],
      totals: [
        {
          resultPath: "/total",
          operandPaths: ["/partA", "/partB"],
          operation: "sum",
        },
      ],
    });
    expect(totalRule.valid).toBe(false);
    expect(totalRule.checks.some((item) => item.code === "CROSS_FIELD_TOTAL_REPLAY" && item.status === "failed")).toBe(
      true,
    );
    const malformedOperation = verifyExtractionFields({
      ...{
        schema: schema({ partA: string(), partB: string(), total: string() }),
        candidate: invalid,
        fields: ["/partA", "/partB", "/total"].map((path) => ({
          path,
          comparison: "decimal" as const,
        })),
        evidence: ["/partA", "/partB", "/total"].map((path) => ({
          path,
          captureId: "capture-1",
          representationArtifactId: "artifact-1",
          representationDigest: contentDigest,
          selector: { kind: "json_pointer" as const, pointer: path },
        })),
        representations: [
          {
            captureId: "capture-1",
            artifactId: "artifact-1",
            digest: contentDigest,
            content,
          },
        ],
      },
      totals: [
        {
          resultPath: "/total",
          operandPaths: ["/partA", "/partB"],
          operation: "unrecognized" as never,
        },
      ],
    });
    expect(malformedOperation.checks.some((item) => item.code === "CROSS_FIELD_TOTAL_INPUT_INVALID")).toBe(true);
  });

  it("fails closed for ambiguous or unsupported evidence and invalid dates", async () => {
    const ambiguous = await verify(
      { title: "same" },
      [{ path: "/title", comparison: "exact" }],
      [
        {
          path: "/title",
          selector: {
            kind: "text_quote",
            quote: "same",
            normalization: "none",
          },
        },
      ],
      "same same",
    );
    expect(ambiguous.valid).toBe(false);
    const date = await verify(
      { date: "2026-02-30" },
      [{ path: "/date", comparison: "date" }],
      [{ path: "/date", selector: { kind: "json_pointer", pointer: "/date" } }],
    );
    expect(date.valid).toBe(false);
  });

  it("applies strict currencies, units, date-times, identifiers, checksums, and numeric ranges", async () => {
    const candidate = {
      currency: "USD 12.50",
      unit: "kg",
      at: "2026-01-01T00:00:00Z",
      identifier: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      card: "79927398713",
      ratio: "0.5",
    };
    const source = { ...candidate, at: "2025-12-31T19:00:00-05:00" };
    const result = await verify(
      candidate,
      [
        { path: "/currency", comparison: "currency", allowedValues: ["USD"] },
        { path: "/unit", comparison: "unit", allowedValues: ["kg"] },
        { path: "/at", comparison: "datetime" },
        {
          path: "/identifier",
          comparison: "identifier",
          identifierKind: "sha256",
        },
        { path: "/card", comparison: "checksum", checksum: "luhn" },
        { path: "/ratio", comparison: "decimal", minimum: "0", maximum: "1" },
      ],
      [
        {
          path: "/currency",
          selector: { kind: "json_pointer", pointer: "/currency" },
        },
        { path: "/unit", selector: { kind: "json_pointer", pointer: "/unit" } },
        { path: "/at", selector: { kind: "json_pointer", pointer: "/at" } },
        {
          path: "/identifier",
          selector: { kind: "json_pointer", pointer: "/identifier" },
        },
        { path: "/card", selector: { kind: "json_pointer", pointer: "/card" } },
        {
          path: "/ratio",
          selector: { kind: "json_pointer", pointer: "/ratio" },
        },
      ],
      source,
    );
    expect(result.valid).toBe(true);
    const outsideRange = await verify(
      { ratio: "2" },
      [{ path: "/ratio", comparison: "decimal", minimum: "0", maximum: "1" }],
      [
        {
          path: "/ratio",
          selector: { kind: "json_pointer", pointer: "/ratio" },
        },
      ],
    );
    expect(outsideRange.valid).toBe(false);
    const ancient = await verify(
      { date: "0001-01-01" },
      [{ path: "/date", comparison: "date" }],
      [{ path: "/date", selector: { kind: "json_pointer", pointer: "/date" } }],
    );
    expect(ancient.valid).toBe(true);
  });

  it("replays the remaining declared normalized-text, percentage, and enum operations without locale inference", () => {
    const source = { title: "A  B", percentage: "12.50%", status: "reported" };
    const content = encoder.encode(JSON.stringify(source));
    const contentDigest = digest(content);
    const input = {
      schema: schema({
        title: string(),
        percentage: string(),
        status: string(),
      }),
      candidate: { title: " A B ", percentage: "12.5%", status: "reported" },
      fields: [
        {
          path: "/title",
          comparison: "normalized_text" as const,
          normalizationId: "collapsed",
        },
        { path: "/percentage", comparison: "percentage" as const },
        {
          path: "/status",
          comparison: "enum" as const,
          allowedValues: ["reported", "estimated"],
        },
      ],
      evidence: ["/title", "/percentage", "/status"].map((path) => ({
        path,
        captureId: "capture-1",
        representationArtifactId: "artifact-1",
        representationDigest: contentDigest,
        selector: { kind: "json_pointer" as const, pointer: path },
      })),
      representations: [
        {
          captureId: "capture-1",
          artifactId: "artifact-1",
          digest: contentDigest,
          content,
        },
      ],
      normalizations: [{ id: "collapsed", operation: "ascii_whitespace_collapsed" as const }],
    };
    expect(verifyExtractionFields(input).valid).toBe(true);
    expect(
      verifyExtractionFields({
        ...input,
        candidate: { ...input.candidate, percentage: "12.5" },
      }).valid,
    ).toBe(false);
    expect(
      verifyExtractionFields({
        ...input,
        candidate: { ...input.candidate, status: "invented" },
      }).valid,
    ).toBe(false);
    expect(
      verifyExtractionFields({
        ...input,
        candidate: { ...input.candidate, title: "different" },
      }).valid,
    ).toBe(false);
  });

  it("rejects malformed or disallowed values for every remaining scalar comparison kind", async () => {
    const checks = [
      {
        key: "currency",
        value: "EUR 12.50",
        rule: { comparison: "currency" as const, allowedValues: ["USD"] },
        code: "FIELD_CURRENCY_MATCH",
      },
      {
        key: "unit",
        value: "g",
        rule: { comparison: "unit" as const, allowedValues: ["kg"] },
        code: "FIELD_UNIT_MATCH",
      },
      {
        key: "datetime",
        value: "2026-01-01T00:00:00",
        rule: { comparison: "datetime" as const },
        code: "FIELD_DATETIME_MATCH",
      },
      {
        key: "identifier",
        value: "sha256:not-a-digest",
        rule: {
          comparison: "identifier" as const,
          identifierKind: "sha256" as const,
        },
        code: "FIELD_IDENTIFIER_MATCH",
      },
      {
        key: "checksum",
        value: "79927398714",
        rule: { comparison: "checksum" as const, checksum: "luhn" as const },
        code: "FIELD_CHECKSUM_MATCH",
      },
    ];
    for (const item of checks) {
      const candidate = { [item.key]: item.value };
      const result = await verify(
        candidate,
        [{ path: `/${item.key}`, ...item.rule }],
        [
          {
            path: `/${item.key}`,
            selector: { kind: "json_pointer", pointer: `/${item.key}` },
          },
        ],
        candidate,
      );
      expect(result.valid, item.key).toBe(false);
      expect(
        result.checks.some((check) => check.code === item.code && check.status === "failed"),
        item.key,
      ).toBe(true);
    }
  });

  it("replays every declared decimal calculation operation and rejects a changed result", () => {
    const cases = [
      { operation: "identity" as const, operands: ["/left"], expected: "6" },
      {
        operation: "sum" as const,
        operands: ["/left", "/right"],
        expected: "10",
      },
      {
        operation: "difference" as const,
        operands: ["/left", "/right"],
        expected: "2",
      },
      {
        operation: "product" as const,
        operands: ["/left", "/right"],
        expected: "24",
      },
      {
        operation: "ratio" as const,
        operands: ["/left", "/right"],
        expected: "1.5",
      },
      {
        operation: "percent_change" as const,
        operands: ["/right", "/left"],
        expected: "50",
      },
    ];
    for (const item of cases) {
      const candidate = { left: "6", right: "4", result: item.expected };
      const content = encoder.encode(JSON.stringify(candidate)),
        contentDigest = digest(content);
      const input = {
        schema: schema({ left: string(), right: string(), result: string() }),
        candidate,
        fields: ["/left", "/right", "/result"].map((path) => ({
          path,
          comparison: "decimal" as const,
        })),
        evidence: ["/left", "/right", "/result"].map((path) => ({
          path,
          captureId: "capture-1",
          representationArtifactId: "artifact-1",
          representationDigest: contentDigest,
          selector: { kind: "json_pointer" as const, pointer: path },
        })),
        representations: [
          {
            captureId: "capture-1",
            artifactId: "artifact-1",
            digest: contentDigest,
            content,
          },
        ],
        totals: [
          {
            resultPath: "/result",
            operandPaths: item.operands,
            operation: item.operation,
          },
        ],
      };
      expect(verifyExtractionFields(input).valid, item.operation).toBe(true);
      const changedCandidate = { ...candidate, result: "999" };
      const changedContent = encoder.encode(JSON.stringify(changedCandidate));
      const changedDigest = digest(changedContent);
      const changed = verifyExtractionFields({
        ...input,
        candidate: changedCandidate,
        evidence: ["/left", "/right", "/result"].map((path) => ({
          path,
          captureId: "capture-1",
          representationArtifactId: "artifact-1",
          representationDigest: changedDigest,
          selector: { kind: "json_pointer" as const, pointer: path },
        })),
        representations: [
          {
            captureId: "capture-1",
            artifactId: "artifact-1",
            digest: changedDigest,
            content: changedContent,
          },
        ],
      });
      expect(changed.valid, `${item.operation}:changed`).toBe(false);
      expect(
        changed.checks.some((check) => check.code === "CROSS_FIELD_TOTAL_REPLAY" && check.status === "failed"),
        `${item.operation}:arithmetic`,
      ).toBe(true);
    }
  });

  it("requires evidence for duplicate record leaves and rejects duplicate key tuples", async () => {
    const candidate = {
      records: [
        { id: "a", amount: "1" },
        { id: "a", amount: "2" },
      ],
    };
    const admitted = schema({
      records: {
        type: "array",
        description: "Records.",
        maxItems: 10,
        items: {
          type: "object",
          description: "Record.",
          properties: { id: string("Record ID."), amount: string("Amount.") },
          required: ["id", "amount"],
          additionalProperties: false,
        },
      },
    });
    const content = encoder.encode(JSON.stringify(candidate));
    const contentDigest = digest(content);
    const result = verifyExtractionFields({
      schema: admitted,
      candidate,
      fields: ["/records/0/id", "/records/0/amount", "/records/1/id", "/records/1/amount"].map((path) => ({
        path,
        comparison: path.endsWith("amount") ? "decimal" : "exact",
      })),
      evidence: ["/records/0/id", "/records/0/amount", "/records/1/id", "/records/1/amount"].map((path) => ({
        path,
        captureId: "capture-1",
        representationArtifactId: "artifact-1",
        representationDigest: contentDigest,
        selector: { kind: "json_pointer", pointer: path },
      })),
      representations: [
        {
          captureId: "capture-1",
          artifactId: "artifact-1",
          digest: contentDigest,
          content,
        },
      ],
      duplicates: [{ arrayPath: "/records", keyPaths: ["/id"] }],
    });
    expect(result.valid).toBe(false);
    expect(result.checks.some((item) => item.code === "RECORD_KEYS_UNIQUE" && item.status === "failed")).toBe(true);
  });

  it("bounds aggregate repeated evidence scans before hashing or selector resolution", () => {
    const content = new Uint8Array(1_048_576);
    const result = verifyExtractionFields({
      schema: schema({ value: string() }),
      candidate: { value: "x" },
      fields: [{ path: "/value", comparison: "exact" }],
      evidence: Array.from({ length: 65 }, () => ({
        path: "/value",
        captureId: "capture-1",
        representationArtifactId: "artifact-1",
        representationDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000" as const,
        selector: { kind: "json_pointer" as const, pointer: "/value" },
      })),
      representations: [
        {
          captureId: "capture-1",
          artifactId: "artifact-1",
          digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
          content,
        },
      ],
    });
    expect(result.checks.map((item) => item.code)).toContain("EVIDENCE_SCAN_BYTES_EXCEEDED");
  });

  it("rejects inapplicable field options and unbounded pointer, duplicate, and total work before replay", () => {
    const content = encoder.encode('{"value":"1"}');
    const contentDigest = digest(content);
    const base = {
      schema: schema({ value: string() }),
      candidate: { value: "1" },
      evidence: [
        {
          path: "/value",
          captureId: "capture-1",
          representationArtifactId: "artifact-1",
          representationDigest: contentDigest,
          selector: { kind: "json_pointer" as const, pointer: "/value" },
        },
      ],
      representations: [
        {
          captureId: "capture-1",
          artifactId: "artifact-1",
          digest: contentDigest,
          content,
        },
      ],
    };
    const invalidOption = verifyExtractionFields({
      ...base,
      fields: [{ path: "/value", comparison: "exact", checksum: "isbn13" }],
    });
    expect(invalidOption.checks.map((item) => item.code)).toContain("FIELD_RULE_INVALID");
    const deepPointer = `/${"x/".repeat(64)}x`;
    const invalidPointer = verifyExtractionFields({
      ...base,
      fields: [{ path: deepPointer, comparison: "exact" }],
    });
    expect(invalidPointer.checks.map((item) => item.code)).toContain("FIELD_RULE_INVALID");
    const duplicatePaths = verifyExtractionFields({
      ...base,
      fields: [{ path: "/value", comparison: "exact" }],
      duplicates: [
        {
          arrayPath: "/value",
          keyPaths: Array.from({ length: 17 }, () => "/x"),
        },
      ],
    });
    expect(duplicatePaths.checks.map((item) => item.code)).toContain("DUPLICATE_RULE_INVALID");
    const totalOperands = verifyExtractionFields({
      ...base,
      fields: [{ path: "/value", comparison: "decimal" }],
      totals: [
        {
          resultPath: "/value",
          operandPaths: Array.from({ length: 65 }, () => "/value"),
          operation: "sum",
        },
      ],
    });
    expect(totalOperands.checks.map((item) => item.code)).toContain("TOTAL_RULE_RESOURCE_INVALID");
  });

  it("uses declared scalar source components for tables, geometry, and transcripts without accepting locator metadata", () => {
    const table = {
      kind: "table",
      tables: [
        {
          tableId: "scores",
          cells: [{ row: 0, column: 0, value: "42", headerPath: ["Score"] }],
        },
      ],
    };
    const tablePositive = structured(
      "42",
      table,
      {
        kind: "table",
        tableId: "scores",
        row: 0,
        column: 0,
        headerPath: ["Score"],
      },
      "table_cell_value",
    );
    expect(tablePositive.valid).toBe(true);
    expect(
      structured(
        "42",
        table,
        {
          kind: "table",
          tableId: "scores",
          row: 0,
          column: 0,
          headerPath: ["Wrong header"],
        },
        "table_cell_value",
      ).valid,
    ).toBe(false);
    const geometry = {
      kind: "geometry",
      pages: [
        {
          tokens: [
            {
              text: "42",
              x: 0,
              y: 0,
              width: 1,
              height: 1,
              coordinateSpace: "normalized",
              order: 0,
            },
          ],
        },
      ],
    };
    expect(
      structured(
        "1",
        geometry,
        {
          kind: "bounding_box",
          coordinateSpace: "normalized",
          x: 0,
          y: 0,
          width: 1,
          height: 1,
        },
        "geometry_token_text",
        "none",
      ).valid,
    ).toBe(false);
    const transcript = {
      kind: "transcript",
      durationMs: 2_000,
      segments: [
        { segmentId: "a", startMs: 0, endMs: 1_000, text: "alpha" },
        { segmentId: "b", startMs: 1_000, endMs: 2_000, text: "beta" },
      ],
    };
    expect(
      structured(
        "alpha beta",
        transcript,
        { kind: "media_timecode", startMs: 0, endMs: 2_000 },
        "transcript_text",
        "space",
      ).valid,
    ).toBe(true);
    expect(
      structured("0", transcript, { kind: "media_timecode", startMs: 0, endMs: 2_000 }, "transcript_text", "space")
        .valid,
    ).toBe(false);
  });

  it("emits frozen all-or-none accepted leaves with raw scalar custody and declared total metadata", () => {
    const candidate = {
        nested: { name: " alpha ", nullable: null },
        partA: "0.1",
        partB: "0.2",
        total: "0.3",
      },
      source = {
        nested: { name: "alpha", nullable: null },
        partA: "0.1",
        partB: "0.2",
        total: "0.3",
      };
    const content = encoder.encode(JSON.stringify(source)),
      contentDigest = digest(content);
    const admitted = schema({
      nested: {
        type: "object",
        description: "Nested.",
        properties: {
          name: string(),
          nullable: {
            type: ["string", "null"],
            description: "Nullable.",
            maxLength: 128,
          },
        },
        required: ["name", "nullable"],
        additionalProperties: false,
      },
      partA: string(),
      partB: string(),
      total: string(),
    });
    const input = {
      schema: admitted,
      candidate,
      fields: [
        {
          path: "/nested/name",
          comparison: "normalized_text" as const,
          normalizationId: "trim",
        },
        { path: "/nested/nullable", comparison: "exact" as const },
        { path: "/partA", comparison: "decimal" as const },
        { path: "/partB", comparison: "decimal" as const },
        { path: "/total", comparison: "decimal" as const },
      ],
      evidence: ["/nested/name", "/nested/nullable", "/partA", "/partB", "/total"].map((path) => ({
        path,
        captureId: "capture-1",
        representationArtifactId: "artifact-1",
        representationDigest: contentDigest,
        selector: { kind: "json_pointer" as const, pointer: path },
      })),
      representations: [
        {
          captureId: "capture-1",
          artifactId: "artifact-1",
          digest: contentDigest,
          content,
        },
      ],
      normalizations: [{ id: "trim", operation: "trim_ascii" as const }],
      totals: [
        {
          resultPath: "/total",
          operandPaths: ["/partA", "/partB"],
          operation: "sum" as const,
          tolerance: "0",
        },
      ],
    };
    const legacy = verifyExtractionFields(input),
      evidence = verifyExtractionFieldsWithEvidence(input);
    expect(Object.keys(legacy).sort()).toEqual(["candidateValid", "checks", "valid"]);
    expect(evidence).toMatchObject({
      schemaVersion: "verification-extraction-field-evidence.v1",
      valid: true,
      candidateValid: true,
    });
    expect(evidence.acceptedLeaves.map((item) => item.path)).toEqual([
      "/nested/name",
      "/nested/nullable",
      "/partA",
      "/partB",
      "/total",
    ]);
    const name = evidence.acceptedLeaves[0]!,
      nullable = evidence.acceptedLeaves[1]!,
      total = evidence.acceptedLeaves[4]!;
    expect(name).toMatchObject({
      value: " alpha ",
      rawValue: "alpha",
      derivation: { kind: "normalized", operation: "trim_ascii" },
    });
    expect(nullable).toMatchObject({
      value: null,
      rawValue: null,
      derivation: { kind: "direct" },
    });
    expect(total.computation).toEqual({
      schemaVersion: "verification-cross-field-total.v1",
      operation: "sum",
      operandPaths: ["/partA", "/partB"],
      tolerance: "0",
    });
    expect(name.source.fragmentId).toMatch(/^fragment:[a-f0-9]{64}$/u);
    expect(Object.isFrozen(evidence.acceptedLeaves)).toBe(true);
    expect(Object.isFrozen(name.source.selector)).toBe(true);
    const duplicateTotal = verifyExtractionFieldsWithEvidence({
      ...input,
      totals: [
        ...input.totals,
        {
          resultPath: "/total",
          operandPaths: ["/partA", "/partB"],
          operation: "sum",
          tolerance: "0",
        },
      ],
    });
    expect(duplicateTotal.valid).toBe(false);
    expect(duplicateTotal.acceptedLeaves).toEqual([]);
    expect(duplicateTotal.checks.map((item) => item.code)).toContain("ACCEPTED_LEAF_TOTAL_DUPLICATE");
    source.nested.name = "tampered";
    candidate.nested.name = "changed";
    expect(name.value).toBe(" alpha ");
    expect(name.rawValue).toBe("alpha");
    const invalid = verifyExtractionFieldsWithEvidence({
      ...input,
      candidate: { ...input.candidate, total: "0.4" },
    });
    expect(invalid.valid).toBe(false);
    expect(invalid.acceptedLeaves).toEqual([]);
    const tampered = verifyExtractionFieldsWithEvidence({
      ...input,
      representations: [
        {
          ...input.representations[0]!,
          content: encoder.encode(JSON.stringify({ ...source, partA: "9" })),
        },
      ],
    });
    expect(tampered.valid).toBe(false);
    expect(tampered.acceptedLeaves).toEqual([]);
  });

  it("captures structured scalar selection once for evidence rather than resolving a mutable source twice", () => {
    const source = {
        kind: "table",
        tables: [
          {
            tableId: "scores",
            cells: [{ row: 0, column: 0, value: "42", headerPath: ["Score"] }],
          },
        ],
      },
      content = encoder.encode(canonicalizeJson(source)),
      contentDigest = digest(content),
      base = new ProjectionSelectorResolver();
    let calls = 0;
    const resolver = {
      resolverVersion: base.resolverVersion,
      supportedKinds: base.supportedKinds,
      resolve(request: Parameters<ProjectionSelectorResolver["resolve"]>[0]) {
        calls += 1;
        return base.resolve(request);
      },
    };
    const result = verifyExtractionFieldsWithEvidence({
      schema: schema({ value: string() }),
      candidate: { value: "42" },
      fields: [
        {
          path: "/value",
          comparison: "exact",
          sourceComponent: "table_cell_value",
        },
      ],
      evidence: [
        {
          path: "/value",
          captureId: "capture-1",
          representationArtifactId: "artifact-1",
          representationDigest: contentDigest,
          selector: {
            kind: "table",
            tableId: "scores",
            row: 0,
            column: 0,
            headerPath: ["Score"],
          },
        },
      ],
      representations: [
        {
          captureId: "capture-1",
          artifactId: "artifact-1",
          digest: contentDigest,
          content,
        },
      ],
      selectorResolvers: [resolver],
    });
    expect(result.valid).toBe(true);
    expect(result.acceptedLeaves).toMatchObject([
      {
        path: "/value",
        value: "42",
        rawValue: "42",
        source: { selectedContentDigest: expect.stringMatching(/^sha256:/u) },
      },
    ]);
    expect(calls).toBe(1);
  });
});

function openSchema(): AdmittedExtractionSchema {
  return admitExtractionSchema({
    schemaId: "open",
    schemaVersion: "1",
    schema: {
      type: "object",
      description: "Open.",
      properties: {},
      required: [],
      additionalProperties: true,
    },
  }).schema!;
}

function structured(
  value: string,
  projection: unknown,
  selector: ExtractionEvidence["selector"],
  sourceComponent: NonNullable<ExtractionFieldRule["sourceComponent"]>,
  sourceJoiner?: "space" | "none",
) {
  const content = encoder.encode(canonicalizeJson(projection));
  const contentDigest = digest(content);
  return verifyExtractionFields({
    schema: schema({ value: string() }),
    candidate: { value },
    fields: [
      {
        path: "/value",
        comparison: "exact",
        sourceComponent,
        ...(sourceJoiner === undefined ? {} : { sourceJoiner }),
      },
    ],
    evidence: [
      {
        path: "/value",
        captureId: "capture-1",
        representationArtifactId: "artifact-1",
        representationDigest: contentDigest,
        selector,
      },
    ],
    representations: [
      {
        captureId: "capture-1",
        artifactId: "artifact-1",
        digest: contentDigest,
        content,
      },
    ],
    selectorResolvers: [new ProjectionSelectorResolver()],
  });
}
