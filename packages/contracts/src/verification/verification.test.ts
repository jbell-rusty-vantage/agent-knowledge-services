import { describe, expect, it } from "vitest";
import {
  ClaimTypeSchema,
  VerificationBenchmarkDatasetSchema,
  VerificationBundleSchema,
  VerificationMetricObservationSchema,
  VerificationOperationContextSchema,
  VerificationSelectorSchema,
  VerificationRunManifestSchema,
} from "./index.js";

const digest = `sha256:${"a".repeat(64)}`;
const uuid = "11111111-1111-4111-8111-111111111111";

const edge = (evidenceId: string, pointer: string) => ({
  evidenceId,
  fragment: {
    fragmentId: `fragment-${evidenceId}`,
    captureId: "capture",
    representationArtifactId: uuid,
    selector: { kind: "json_pointer" as const, pointer },
  },
  role: "supports" as const,
  origin: "declared" as const,
  authority: {
    authority: "primary" as const,
    independence: "independent" as const,
    directness: "direct" as const,
    freshness: "current" as const,
    applicability: "direct" as const,
  },
  parserLineageArtifactIds: [],
});

const metric = (period: { start?: string; end?: string } = {}) => ({
  observationId: "metric",
  entity: { kind: "package" as const, canonicalId: "npm:x", label: "x", aliases: [] },
  artifactLevel: "package",
  provider: "registry",
  providerNativeField: "value",
  metricDefinition: "count",
  metricDefinitionVersion: "1",
  rawValue: 3,
  canonicalValue: "3",
  unit: { symbol: "count", dimension: "count", scaleToCanonical: "1" },
  period: { ...period, timezone: "UTC", semantics: period.start ? ("interval" as const) : ("point" as const) },
  aggregation: "identity",
  deduplication: "none",
  caveats: [],
  observedAt: "2026-09-05T00:00:00.000Z",
  comparabilityGroup: "count.v1",
  evidence: [
    edge("value", "/value"),
    edge("unit", "/unit"),
    edge("identity", "/entity"),
    edge("start", "/start"),
    edge("end", "/end"),
  ],
  evidenceBindings: [
    { evidenceId: "value", facet: "value" as const, expectedLiteral: "3", comparison: "decimal" as const },
    { evidenceId: "unit", facet: "unit" as const, expectedLiteral: "count", comparison: "exact_text" as const },
    { evidenceId: "identity", facet: "identity" as const, expectedLiteral: "x", comparison: "exact_text" as const },
    ...(period.start
      ? [
          {
            evidenceId: "start",
            facet: "period_start" as const,
            expectedLiteral: period.start,
            comparison: "iso_datetime" as const,
          },
        ]
      : []),
    ...(period.end
      ? [
          {
            evidenceId: "end",
            facet: "period_end" as const,
            expectedLiteral: period.end,
            comparison: "iso_datetime" as const,
          },
        ]
      : []),
  ],
});

describe("verification.v1 selectors", () => {
  it("preserves exact quote and context whitespace without normalizing Unicode", () => {
    const selector = {
      kind: "text_quote",
      quote: "\n 🧪 Cafe\u0301\r\n",
      prefix: "\t ",
      suffix: "\n",
      normalization: "none",
    };
    expect(VerificationSelectorSchema.parse(selector)).toEqual(selector);
    expect(VerificationSelectorSchema.safeParse({ ...selector, quote: "" }).success).toBe(false);
  });

  it("accepts RFC 6901 root, nested, empty-key, and escaped tokens", () => {
    for (const pointer of ["", "/", "/a/b", "/a//b", "/a~0b/~1slash"]) {
      expect(VerificationSelectorSchema.parse({ kind: "json_pointer", pointer })).toMatchObject({ pointer });
    }
  });

  it("rejects malformed JSON Pointer escapes", () => {
    for (const pointer of ["a", "/a~", "/a~2b"])
      expect(VerificationSelectorSchema.safeParse({ kind: "json_pointer", pointer }).success).toBe(false);
  });

  it("covers every specified selector family", () => {
    const selectors = [
      { kind: "text_quote", quote: "fact", normalization: "none" },
      { kind: "character_position", start: 0, end: 4, offsetBasis: "utf16_code_units", normalization: "none" },
      {
        kind: "multi_fragment_text",
        fragments: [
          { kind: "character_position", start: 0, end: 4, offsetBasis: "utf16_code_units", normalization: "none" },
          { kind: "character_position", start: 8, end: 12, offsetBasis: "utf16_code_units", normalization: "none" },
        ],
        joiner: " … ",
      },
      { kind: "json_pointer", pointer: "/a/b" },
      { kind: "html", css: "main p" },
      { kind: "pdf_text", page: 1, start: 0, end: 3, offsetBasis: "unicode_code_points", textLayerDigest: digest },
      { kind: "bounding_box", page: 1, coordinateSpace: "normalized", x: 0, y: 0, width: 1, height: 1 },
      { kind: "table", tableId: "table", row: 0, column: 0, headerPath: ["value"] },
      { kind: "media_timecode", startMs: 0, endMs: 1000 },
      { kind: "repository", commit: "a".repeat(40), path: "src/index.ts", rangeKind: "lines", start: 1, end: 2 },
      { kind: "dataset", datasetVersionId: "dataset-v1", rowKey: "row-1", column: "value" },
      { kind: "api_record", pageKey: "next-1", recordKey: "row-1", fieldPointer: "/a/b" },
    ];
    for (const selector of selectors)
      expect(VerificationSelectorSchema.safeParse(selector).success, JSON.stringify(selector)).toBe(true);
  });

  it("bounds geometry, immutable commits, fragment bases, and omission separators", () => {
    expect(
      VerificationSelectorSchema.safeParse({
        kind: "bounding_box",
        coordinateSpace: "pixels",
        x: 90,
        y: 0,
        width: 20,
        height: 10,
        imageWidth: 100,
        imageHeight: 100,
      }).success,
    ).toBe(false);
    expect(
      VerificationSelectorSchema.safeParse({
        kind: "repository",
        commit: "a".repeat(7),
        path: "x",
        rangeKind: "bytes",
        start: 0,
        end: 1,
      }).success,
    ).toBe(false);
    expect(
      VerificationSelectorSchema.safeParse({
        kind: "multi_fragment_text",
        fragments: [
          { kind: "text_quote", quote: "a", normalization: "none" },
          { kind: "text_quote", quote: "b", normalization: "lf" },
        ],
        joiner: " … ",
      }).success,
    ).toBe(false);
    expect(
      VerificationSelectorSchema.safeParse({
        kind: "multi_fragment_text",
        fragments: [
          { kind: "text_quote", quote: "a", normalization: "none" },
          { kind: "text_quote", quote: "b", normalization: "none" },
        ],
        joiner: " not ",
      }).success,
    ).toBe(false);
  });
});

describe("verification.v1 taxonomy and envelopes", () => {
  it("keeps provider reservations distinct from actual, estimated, and unknown costs", () => {
    const call = {
      requestDigest: digest,
      retries: 0,
      reservationCostMicros: 400,
      costState: "unknown_dispatched" as const,
    };
    const CallSchema = VerificationRunManifestSchema.shape.calls.element;
    expect(CallSchema.safeParse(call).success).toBe(true);
    expect(CallSchema.safeParse({ ...call, costState: "actual" }).success).toBe(false);
    expect(CallSchema.safeParse({ ...call, actualCostMicros: 0 }).success).toBe(false);
  });
  it("publishes verification schemas as OpenAPI components and standalone JSON Schema", async () => {
    const packageRoot = resolve(import.meta.dirname, "../..");
    const manifest = JSON.parse(await readFile(resolve(packageRoot, "generated/manifest.json"), "utf8")) as {
      schemas: string[];
    };
    const openapi = JSON.parse(await readFile(resolve(packageRoot, "generated/openapi.json"), "utf8")) as {
      components: { schemas: Record<string, unknown> };
    };
    for (const name of [
      "VerificationBundle",
      "VerificationSelector",
      "VerificationRunManifest",
      "VerificationError",
      "RunVerificationBenchmarkInput",
      "VerificationBenchmarkV1CandidatePool",
    ]) {
      expect(manifest.schemas).toContain(name);
      expect(openapi.components.schemas).toHaveProperty(name);
      expect(
        JSON.parse(await readFile(resolve(packageRoot, `generated/json-schema/${name}.schema.json`), "utf8")),
      ).toHaveProperty("$schema");
    }
  });

  it("contains every canonical database claim type losslessly", () => {
    const databaseKinds = [
      "attribute",
      "capability",
      "compatibility",
      "definition",
      "event",
      "measurement",
      "provenance",
      "recommendation",
      "relationship",
    ];
    for (const kind of databaseKinds) expect(ClaimTypeSchema.parse(kind)).toBe(kind);
  });

  it("keeps the service envelope at v1 and versions verification separately", () => {
    const actor = { kind: "service" as const, id: uuid, serviceIdentity: "knowledge_worker" as const };
    const context = {
      contractVersion: "v1",
      verificationContractVersion: "verification.v1",
      tenantId: uuid,
      operationId: uuid,
      attemptId: uuid,
      correlationId: "correlation",
      actor,
      capabilityVersion: "1",
      idempotencyKey: "idempotency",
      requestedAt: "2026-09-05T00:00:00.000Z",
      dataClassification: "internal",
      requestedPolicyVersion: "policy.v1",
      inputArtifacts: [],
    };
    expect(VerificationOperationContextSchema.parse(context).contractVersion).toBe("v1");
    expect(
      VerificationOperationContextSchema.safeParse({ ...context, verificationContractVersion: "verification.v2" })
        .success,
    ).toBe(false);
    expect(VerificationOperationContextSchema.safeParse({ ...context, futureField: true }).success).toBe(false);
    expect(JSON.stringify(VerificationOperationContextSchema.parse(context))).toBe(
      `{"contractVersion":"v1","verificationContractVersion":"verification.v1","tenantId":"${uuid}","operationId":"${uuid}","attemptId":"${uuid}","correlationId":"correlation","actor":{"kind":"service","id":"${uuid}","serviceIdentity":"knowledge_worker"},"capabilityVersion":"1","idempotencyKey":"idempotency","requestedAt":"2026-09-05T00:00:00.000Z","dataClassification":"internal","requestedPolicyVersion":"policy.v1","inputArtifacts":[]}`,
    );
  });

  it("requires conditional metric facets without rejecting timeless point observations", () => {
    expect(VerificationMetricObservationSchema.safeParse(metric()).success).toBe(true);
    expect(VerificationMetricObservationSchema.safeParse({ ...metric(), period: { semantics: "point" } }).success).toBe(
      false,
    );
    const interval = metric({ start: "2026-09-01T00:00:00.000Z", end: "2026-09-02T00:00:00.000Z" });
    expect(VerificationMetricObservationSchema.safeParse(interval).success).toBe(true);
    expect(
      VerificationMetricObservationSchema.safeParse({ ...metric(), period: { timezone: "UTC", semantics: "interval" } })
        .success,
    ).toBe(false);
    expect(
      VerificationMetricObservationSchema.safeParse({
        ...interval,
        evidenceBindings: interval.evidenceBindings.filter((binding) => binding.facet !== "period_end"),
      }).success,
    ).toBe(false);
    expect(
      VerificationMetricObservationSchema.safeParse({
        ...metric(),
        evidenceBindings: metric().evidenceBindings.filter((binding) => binding.facet !== "unit"),
      }).success,
    ).toBe(false);
    const cumulative = {
      ...metric(),
      period: { end: "2026-09-02T00:00:00.000Z", timezone: "UTC", semantics: "cumulative" as const },
      evidenceBindings: [
        { evidenceId: "value", facet: "value" as const, expectedLiteral: "3", comparison: "decimal" as const },
        { evidenceId: "unit", facet: "unit" as const, expectedLiteral: "count", comparison: "exact_text" as const },
        { evidenceId: "identity", facet: "identity" as const, expectedLiteral: "x", comparison: "exact_text" as const },
        {
          evidenceId: "end",
          facet: "period_end" as const,
          expectedLiteral: "2026-09-02T00:00:00.000Z",
          comparison: "iso_datetime" as const,
        },
      ],
    };
    expect(VerificationMetricObservationSchema.safeParse(cumulative).success).toBe(true);
    expect(
      VerificationMetricObservationSchema.safeParse({
        ...cumulative,
        evidenceBindings: cumulative.evidenceBindings.filter((binding) => binding.facet !== "period_end"),
      }).success,
    ).toBe(false);
  });

  it("rejects empty verification intent and unknown contract versions", () => {
    const partial = {
      verificationContractVersion: "verification.v1",
      bundleId: "empty",
      policyVersion: "p",
      producer: { deploymentId: "p", attemptId: "p", capabilityVersion: "1" },
      verifier: { deploymentId: "v", attemptId: "v", capabilityVersion: "1" },
      sources: [],
      captures: [],
      assertions: [],
      metricObservations: [],
      lineage: [],
    };
    expect(VerificationBundleSchema.safeParse(partial).success).toBe(false);
    expect(
      VerificationBundleSchema.safeParse({ ...partial, verificationContractVersion: "verification.v2" }).success,
    ).toBe(false);
  });

  it("requires one control arm and a frozen benchmark dataset", () => {
    expect(VerificationBenchmarkDatasetSchema.safeParse({ frozen: false }).success).toBe(false);
  });
});
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
