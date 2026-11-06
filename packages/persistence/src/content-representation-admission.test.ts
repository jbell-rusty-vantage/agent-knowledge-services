import { describe, expect, it } from "vitest";
import { readContentRepresentationAdmission } from "./content-representation-admission.js";
import type { TenantSqlClient } from "./postgres.js";
const tenantId = "tenant",
  representationId = "representation",
  guarded = "a".repeat(64);
function fixture(overrides: Record<string, unknown> = {}) {
  const decision = {
    id: "decision",
    tenant_id: tenantId,
    representation_id: representationId,
    decision: "accept",
    legacy_provenance: false,
    guarded_sha256: guarded,
    knowledge_review_decision_id: "review",
    decision_operation_id: "decision-operation",
    reviewer_identity: "reviewer",
    review_id: "review",
    review_legacy: false,
    review_digest: guarded,
    review_decision: "approve",
    review_identity: "reviewer",
    reviewer_role: "human_reviewer",
    review_operation_id: "decision-operation",
    subject_kind: "representation",
    subject_ref: { representationId, artifactDigest: `sha256:${guarded}` },
    subject_digest: guarded,
    eligible_roles: ["human_reviewer"],
    quorum_required: 1,
    representation_digest: guarded,
    producing_operation_id: null,
    subject_operation_id: "producer-operation",
    decision_current: true,
    subject_current: true,
    representation_kind: "summary",
    transformation_kind: "summarize",
    transformation_attempt_id: "producer-attempt",
    producer_attempt_id: "producer-attempt",
    producer_deployment_id: "producer-deployment",
    reviewer_attempt_id: null,
    reviewer_resolved_attempt_id: null,
    reviewer_deployment_id: null,
    operation_id: "decision-operation",
    operation_actor: "reviewer",
    operation_kind: "representation_decision",
    operation_status: "succeeded",
    producer_actor: "producer",
  };
  const row = { ...decision, ...overrides };
  const queries: string[] = [];
  const client = {
    async query(sql: string, values: unknown[]) {
      queries.push(sql);
      expect(values).toEqual([tenantId, representationId]);
      return { rows: [row] };
    },
  } as unknown as TenantSqlClient;
  return {
    queries,
    read: () =>
      readContentRepresentationAdmission(client, { tenantId, representationId, guardedDigest: `sha256:${guarded}` }),
  };
}
describe("canonical representation admission", () => {
  it("admits exact independent current acceptance without consulting the raw representation label", async () => {
    const value = fixture();
    expect(await value.read()).toEqual({ accepted: true, decisionId: "decision", decision: "accept" });
    const selection = value.queries[0]!.split(") select")[0]!;
    expect(selection).toContain("order by created_at desc,id desc limit 1");
    expect(selection).not.toContain("decision='accept'");
    expect(selection).not.toContain("expires_at");
  });
  it("admits the actual conversion subject only for its producing operation", async () => {
    expect(
      (
        await fixture({
          subject_kind: "conversion",
          representation_kind: "structural_document",
          transformation_kind: "convert",
          producing_operation_id: "producer-operation",
        }).read()
      ).accepted,
    ).toBe(true);
    expect(
      (
        await fixture({
          subject_kind: "conversion",
          representation_kind: "structural_document",
          transformation_kind: "convert",
          producing_operation_id: "other-operation",
        }).read()
      ).accepted,
    ).toBe(false);
  });
  it.each([
    ["tenant_id", "other"],
    ["representation_id", "other"],
    ["guarded_sha256", "b".repeat(64)],
    ["legacy_provenance", true],
    ["review_legacy", true],
    ["review_id", null],
    ["review_digest", "b".repeat(64)],
    ["review_decision", "reject"],
    ["review_operation_id", "other"],
    ["operation_id", null],
    ["operation_kind", "other"],
    ["operation_status", "queued"],
    ["review_identity", "other"],
    ["operation_actor", "other"],
    ["producer_actor", null],
    ["transformation_kind", null],
    ["transformation_attempt_id", null],
    ["producer_attempt_id", null],
    ["producer_deployment_id", ""],
    ["subject_kind", "publication"],
    ["subject_ref", { representationId: "other", artifactDigest: `sha256:${guarded}` }],
    ["subject_ref", { representationId, artifactDigest: `sha256:${"b".repeat(64)}` }],
    ["subject_digest", "b".repeat(64)],
    ["representation_digest", "b".repeat(64)],
    ["producing_operation_id", "other-operation"],
    ["quorum_required", 2],
    ["eligible_roles", []],
    ["decision_current", false],
    ["subject_current", false],
  ])("rejects canonical %s drift", async (field, changed) => {
    expect((await fixture({ [String(field)]: changed }).read()).accepted).toBe(false);
  });
  it.each(["reject", "quarantine", "defer", "request_changes"])(
    "retains latest %s without falling back to older acceptance",
    async (decision) => {
      expect(await fixture({ decision }).read()).toEqual({ accepted: false, decisionId: "decision", decision });
    },
  );
  it("returns pending when no decision exists", async () => {
    const client = { query: async () => ({ rows: [] }) } as unknown as TenantSqlClient;
    expect(
      await readContentRepresentationAdmission(client, {
        tenantId,
        representationId,
        guardedDigest: `sha256:${guarded}`,
      }),
    ).toEqual({ accepted: false, decisionId: null, decision: null });
  });
});

it("uses the actual summary producer even when a review subject names another operation actor", async () => {
  expect((await fixture({ producer_actor: "reviewer" }).read()).accepted).toBe(true);
});
it.each(["producer-attempt", "producer-deployment"])("rejects summary reviewer actor equal to %s", async (identity) => {
  expect(
    (await fixture({ reviewer_identity: identity, review_identity: identity, operation_actor: identity }).read())
      .accepted,
  ).toBe(false);
});
it.each([
  {
    reviewer_attempt_id: "producer-attempt",
    reviewer_resolved_attempt_id: "producer-attempt",
    reviewer_deployment_id: "producer-deployment",
  },
  {
    reviewer_attempt_id: "reviewer-attempt",
    reviewer_resolved_attempt_id: "reviewer-attempt",
    reviewer_deployment_id: "producer-deployment",
  },
  { reviewer_attempt_id: "reviewer-attempt", reviewer_resolved_attempt_id: null, reviewer_deployment_id: null },
  {
    reviewer_attempt_id: "reviewer-attempt",
    reviewer_resolved_attempt_id: "reviewer-attempt",
    reviewer_deployment_id: "",
  },
])("rejects aliased or unresolved reviewer runtime identity %#", async (row) => {
  expect((await fixture(row).read()).accepted).toBe(false);
});
it("accepts a distinct tenant-resolved reviewer attempt and deployment", async () => {
  expect(
    (
      await fixture({
        reviewer_attempt_id: "reviewer-attempt",
        reviewer_resolved_attempt_id: "reviewer-attempt",
        reviewer_deployment_id: "reviewer-deployment",
      }).read()
    ).accepted,
  ).toBe(true);
});
