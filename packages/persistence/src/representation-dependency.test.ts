import { describe, expect, it, vi } from "vitest";
import type { TenantSqlClient } from "./postgres.js";
import { readRepresentationDependencies, readRepresentationImpact } from "./representation-dependency.js";

vi.mock("./content-representation-admission.js", () => ({
  readContentRepresentationAdmission: vi.fn(async (_client, input) => ({
    accepted: input.guardedDigest === `sha256:${"a".repeat(64)}`,
    decisionId: "test-decision",
    decision: "accept",
  })),
}));

function fixture(rows: Record<string, unknown>[]) {
  const query = vi.fn(async (_sql: string, _values: readonly unknown[]) => ({ rows, rowCount: rows.length }));
  return { query, client: { query } as unknown as TenantSqlClient };
}
const node = (representationId: string, authorized = true) => ({
  artifact_id: `artifact-${representationId}`,
  storage_state: "available",
  representation_id: representationId,
  content_sha256: (authorized ? "a" : "b").repeat(64),
  withdrawn: false,
  representation_class: "structural",
  has_decision: true,
  capture_root: false,
  report_version_id: null,
});

describe("current representation dependency closure", () => {
  it("does not declare report or unknown artifact descendants revalidated", async () => {
    const value = fixture([
      { artifact_id: "report-artifact", representation_id: null, projection_id: null, report_version_id: "report" },
      { artifact_id: "unknown", representation_id: null, projection_id: null, report_version_id: null },
    ]);
    const result = await readRepresentationImpact(value.client, "tenant", "source");
    expect(result.complete).toBe(false);
    expect(result.blocked).toEqual([
      "REPORT_DEPENDENCY_REVALIDATION_REQUIRED:report",
      "DEPENDENCY_AUTHORITY_REQUIRED:unknown",
    ]);
    expect(value.query.mock.calls[0]![0]).toContain("research.report_assertion_claim");
    expect(value.query.mock.calls[0]![0]).toContain("research.report_section_dependency");
  });
  it("gates a still-admitted derived representation when a transitive input is revoked", async () => {
    const value = fixture([node("derived"), node("middle"), node("source", false)]);
    expect(await readRepresentationDependencies(value.client, "tenant", "derived")).toEqual({
      eligible: false,
      representationIds: ["derived", "middle", "source"],
      blocked: ["SOURCE_REPRESENTATION_NOT_ADMITTED:source"],
      unsupportedReportVersionIds: [],
    });
    const sql = value.query.mock.calls[0]![0];
    expect(sql).toContain("e.relation_kind='derived_from'");
    expect(sql).toContain("i.transformation_run_id=r.transformation_run_id");
    expect(sql).toContain("a.id=e.child and a.kind=e.child_kind");
    expect(sql).toContain("b.kind='representation' and r.id=b.id");
  });
  it("accepts a captured byte root without inventing a representation review", async () => {
    const value = fixture([
      node("derived"),
      {
        artifact_id: "capture",
        storage_state: "available",
        representation_id: null,
        authorized: false,
        capture_root: true,
        report_version_id: null,
      },
    ]);
    expect((await readRepresentationDependencies(value.client, "tenant", "derived")).eligible).toBe(true);
  });
  it.each(["unknown", "missing", "report"])("fails closed on %s artifact authority", async (mode) => {
    const value = fixture([
      node("derived"),
      {
        artifact_id: "input",
        storage_state: mode === "missing" ? "missing" : "available",
        representation_id: null,
        authorized: false,
        capture_root: mode !== "unknown",
        report_version_id: mode === "report" ? "report" : null,
      },
    ]);
    const result = await readRepresentationDependencies(value.client, "tenant", "derived");
    expect(result.eligible).toBe(false);
    if (mode === "report") expect(result.unsupportedReportVersionIds).toEqual(["report"]);
  });
  it("keeps missing artifact metadata visible and denies it", async () => {
    const value = fixture([
      node("derived"),
      {
        artifact_id: "missing-parent",
        storage_state: null,
        representation_id: null,
        capture_root: false,
        native_reviews: [],
        report_version_id: null,
      },
    ]);
    const result = await readRepresentationDependencies(value.client, "tenant", "derived");
    expect(result.blocked).toContain("DEPENDENCY_ARTIFACT_UNAVAILABLE:missing-parent");
    expect(value.query.mock.calls[0]![0]).toContain("left join orchestration.artifact a");
  });
  it("denies a captured artifact whose canonical native representation was rejected", async () => {
    const value = fixture([
      node("derived"),
      {
        artifact_id: "capture",
        storage_state: "available",
        representation_id: null,
        capture_root: true,
        native_reviews: [{ id: "native", digest: "b".repeat(64), has_decision: true, withdrawn: false }],
        report_version_id: null,
      },
    ]);
    expect((await readRepresentationDependencies(value.client, "tenant", "derived")).blocked).toContain(
      "SOURCE_REPRESENTATION_NOT_ADMITTED:native",
    );
  });
  it("requires an independent decision for the root even when its captured bytes are available", async () => {
    const value = fixture([
      { ...node("root", false), representation_class: "source_native", has_decision: false, capture_root: true },
    ]);
    expect((await readRepresentationDependencies(value.client, "tenant", "root")).eligible).toBe(false);
  });
  it.each([0, 1025])("rejects incomplete or oversized closure with %i nodes", async (count) => {
    const value = fixture(Array.from({ length: count }, (_, index) => node(index === 0 ? "derived" : `node-${index}`)));
    expect((await readRepresentationDependencies(value.client, "tenant", "derived")).blocked).toContain(
      "REPRESENTATION_DEPENDENCY_CLOSURE_INCOMPLETE",
    );
  });
});
