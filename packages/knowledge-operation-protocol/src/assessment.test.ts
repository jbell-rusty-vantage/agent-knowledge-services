import { describe, expect, it } from "vitest";
import { EvaluationContextSchema, ReportObservationRequestSchema, ReportUseRequestSchema } from "./assessment.js";
import { CredentialClaimsSchema } from "./credential.js";
import { judgeClaims, reportUseRequest } from "./test-support.js";

describe("evaluator credentials (WI-03)", () => {
  it("accepts a judge credential granting report.observe", () => {
    expect(CredentialClaimsSchema.safeParse(judgeClaims()).success).toBe(true);
  });

  it("refuses report.observe without the host's evaluator grant", () => {
    const { evaluation: _evaluation, ...claims } = judgeClaims();
    const parsed = CredentialClaimsSchema.safeParse(claims);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.path.join("."))).toContain("evaluation");
  });

  it("an evaluator credential grants no effectful or producer operation", () => {
    const claims = {
      ...judgeClaims(),
      operations: ["report.observe", "report.register"],
      effect: { effectKey: "effect-1", boundEffectDigest: `sha256:${"a".repeat(64)}` },
    };
    expect(CredentialClaimsSchema.safeParse(claims).success).toBe(false);
  });

  it("report.review needs a human reviewer and report.observe an observer role", () => {
    const reviewAsJudge = { ...judgeClaims(), operations: ["report.review"] };
    expect(CredentialClaimsSchema.safeParse(reviewAsJudge).success).toBe(false);
    const observeAsReviewer = {
      ...judgeClaims(),
      evaluation: { role: "human_reviewer", credentialRef: "reviewer.grant", provider: null, family: null },
    };
    expect(CredentialClaimsSchema.safeParse(observeAsReviewer).success).toBe(false);
    const review = { ...observeAsReviewer, operations: ["report.review", "decision.resolve"] };
    expect(CredentialClaimsSchema.safeParse(review).success).toBe(true);
  });

  it("the producer role is not grantable", () => {
    const producer = { ...judgeClaims(), evaluation: { ...judgeClaims().evaluation, role: "producer" } };
    expect(CredentialClaimsSchema.safeParse(producer).success).toBe(false);
  });
});

describe("assessment request contracts (WI-03)", () => {
  it("a report decision's subject is its report", () => {
    const request = reportUseRequest();
    expect(ReportUseRequestSchema.safeParse(request).success).toBe(true);
    const other = { ...request, subject: { ...request.subject, digest: `sha256:${"b".repeat(64)}` } };
    expect(ReportUseRequestSchema.safeParse(other).success).toBe(false);
  });

  it("an observation request carries an observation or a census", () => {
    const report = reportUseRequest().report;
    expect(
      ReportObservationRequestSchema.safeParse({
        schema: "report-observation.v1",
        report,
        observations: [],
        census: null,
      }).success,
    ).toBe(false);
  });

  it("an unknown purpose refuses", () => {
    expect(ReportUseRequestSchema.safeParse({ ...reportUseRequest(), purpose: "publish" }).success).toBe(false);
  });
});

describe("exact evaluation task audience", () => {
  const request = reportUseRequest();
  const task = {
    handle: { ...request.report, kind: "task", version: "task.v1" },
    use: request.use,
    policy: request.policy,
    rubric: request.rubric,
    minimumRisk: "low",
  };
  it.each(["internal", "official"])("preserves %s", (audience) => {
    expect(EvaluationContextSchema.shape.task.parse({ ...task, audience }).audience).toBe(audience);
  });
  it("refuses missing and invalid audience", () => {
    expect(EvaluationContextSchema.shape.task.safeParse(task).success).toBe(false);
    for (const audience of [null, "", 42, "Official", "bad audience"]) {
      expect(EvaluationContextSchema.shape.task.safeParse({ ...task, audience }).success).toBe(false);
    }
  });
});
