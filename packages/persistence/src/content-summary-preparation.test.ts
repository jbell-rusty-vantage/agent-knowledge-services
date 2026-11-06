import { describe, expect, it } from "vitest";
import { sha256Digest } from "@aiengineer/knowledge-core";
import { persistPreparedContentSummary, type PreparedContentSummaryInput } from "./content-summary-preparation.js";
import type { TenantSqlClient } from "./postgres.js";

const digest = sha256Digest("retained");
const input: PreparedContentSummaryInput = {
  tenantId: "tenant",
  missionId: "mission",
  attemptId: "attempt",
  transformationRunId: "transform",
  representationId: "output",
  documentVersionId: "version",
  inputRepresentationId: "source",
  inputArtifact: { id: "input-bytes", digest },
  outputArtifact: { id: "output-bytes", digest },
  receiptArtifact: { id: "receipt-bytes", digest },
  requestDigest: digest,
};

function fixture(reject = "") {
  const writes: string[] = [],
    runs = new Map<string, Record<string, unknown>>(),
    representations = new Map<string, Record<string, unknown>>();
  const client = {
    async query(sql: string, values: readonly unknown[] = []) {
      if (/^(insert|update)/.test(sql)) writes.push(sql);
      if (sql.includes("from content.representation_decision")) {
        const tenantId = input.tenantId,
          representationId = input.inputRepresentationId,
          guarded = input.inputArtifact.digest.slice(7);
        return {
          rows:
            reject === "admission"
              ? []
              : [
                  {
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
                    representation_kind: "structural_document",
                    transformation_kind: "convert",
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
                  },
                ],
        };
      }
      if (sql.includes("from orchestration.attempt")) return { rows: reject === "attempt" ? [] : [{ id: "attempt" }] };
      if (sql.includes("from orchestration.artifact where"))
        return { rows: reject === "artifact" ? [] : [{ id: values[1] }] };
      if (sql.includes("from content.document_representation") && sql.includes("representation_class in"))
        return { rows: reject === "input" ? [] : [{ id: "source" }] };
      if (sql.startsWith("insert into content.transformation_run"))
        runs.set(String(values[6]), {
          id: values[0],
          transformation_kind: "summarize",
          code_ref: values[2],
          parameters_sha256: values[4],
          attempt_id: values[5],
          status: "succeeded",
          input_manifest_sha256: values[7],
          output_manifest_sha256: values[8],
          receipt: JSON.parse(String(values[9])),
        });
      if (sql.includes("from content.transformation_run")) return { rows: [runs.get(String(values[1]))] };
      if (sql.startsWith("insert into content.document_representation"))
        representations.set(String(values[0]), {
          document_version_id: values[2],
          artifact_id: values[3],
          representation_kind: "summary",
          representation_class: "semantic_projection",
          media_type: "text/plain; charset=utf-8",
          language: values[4],
          content_sha256: values[5],
          transformation_run_id: values[6],
          source_native_byte_identical: false,
          acceptance_state: "pending",
        });
      if (sql.includes("from content.document_representation"))
        return { rows: [representations.get(String(values[1]))] };
      if (sql.includes("from content.transformation_input"))
        return {
          rows: [
            {
              ordinal: 0,
              role: "faithful_source",
              artifact_id: null,
              representation_id: reject === "lineage" ? "foreign" : "source",
              source_capture_id: null,
            },
          ],
        };
      if (sql.includes("from content.transformation_output"))
        return {
          rows: [
            { ordinal: 0, role: "summary_representation", artifact_id: null, representation_id: "output" },
            { ordinal: 1, role: "preparation_receipt", artifact_id: "receipt-bytes", representation_id: null },
          ],
        };
      if (sql.includes("from orchestration.artifact_lineage"))
        return { rows: [{ transformation_run_id: reject === "artifact-lineage" ? "prior-transform" : "transform" }] };
      return { rows: [] };
    },
  } as unknown as TenantSqlClient;
  return { client, writes, representations };
}

describe("canonical summary preparation persistence", () => {
  it("writes the actual transformation and exact lineage with pending acceptance", async () => {
    const value = fixture();
    await persistPreparedContentSummary(value.client, input);
    expect(value.representations.get("output")?.acceptance_state).toBe("pending");
    expect(value.writes.some((sql) => sql.includes("'summarize'") && sql.includes("attempt_id"))).toBe(true);
    expect(value.writes.some((sql) => sql.startsWith("insert into content.transformation_input"))).toBe(true);
    expect(value.writes.some((sql) => sql.startsWith("insert into content.transformation_output"))).toBe(true);
    expect(
      value.writes.some((sql) => sql.includes("knowledge_service.operation") || sql.includes("document_summary(")),
    ).toBe(false);
  });
  it.each([
    ["attempt", "CONTENT_SUMMARY_ATTEMPT_REQUIRED"],
    ["input", "CONTENT_SUMMARY_FAITHFUL_INPUT_REQUIRED"],
    ["admission", "CONTENT_SUMMARY_FAITHFUL_INPUT_REQUIRED"],
    ["artifact", "CONTENT_SUMMARY_RETAINED_OUTPUT_REQUIRED"],
  ])("rejects missing %s authority before writes", async (fault, code) => {
    const value = fixture(fault);
    await expect(persistPreparedContentSummary(value.client, input)).rejects.toThrow(code);
    expect(value.writes).toHaveLength(0);
  });
  it("rejects retained lineage substitutions instead of treating conflicting rows as replay", async () => {
    await expect(persistPreparedContentSummary(fixture("lineage").client, input)).rejects.toThrow(
      "CONTENT_SUMMARY_PREPARATION_CONFLICT",
    );
  });
  it("rejects a conflicting artifact edge without overwriting the prior transformation", async () => {
    const value = fixture("artifact-lineage");
    await expect(persistPreparedContentSummary(value.client, input)).rejects.toThrow(
      "CONTENT_SUMMARY_ARTIFACT_LINEAGE_CONFLICT",
    );
    expect(value.writes.some((sql) => sql.startsWith("update orchestration.artifact_lineage"))).toBe(false);
  });
});
