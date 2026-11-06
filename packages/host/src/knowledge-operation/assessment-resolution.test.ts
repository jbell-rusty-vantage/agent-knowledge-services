import { describe, expect, it } from "vitest";
import {
  DecisionResolutionSchema,
  EvaluationContextSchema,
  digestBytes,
  type CredentialClaims,
} from "@aiengineer/knowledge-operation-protocol";
import { recordRef, renderReport, STRUCTURED_BODY_SCHEMA_VERSION } from "@aiengineer/knowledge-research-core";
import { AT, SCOPE, origin, ref } from "@aiengineer/knowledge-research-core/testing";
import { evaluationContext, resolveDecision } from "./assessment.js";
import type { ResearchServices } from "./ports.js";

describe("authoritative native-write run identity", () => {
  it("resolves an opaque successor decision to its stored verification run", async () => {
    const report = ref("report", "report-1");
    const original = {
      schemaVersion: "use-decision.v1",
      id: "opaque-original",
      ...SCOPE,
      run: ref("verification_run", "authoritative-run"),
      report,
      subject: report,
      use: "knowledge_ingestion",
      audience: "internal",
      boundEffectDigest: report.digest,
      disposition: "admitted",
      conditions: [],
      reviewer: null,
      revocationEpoch: 4,
    };
    const successor = { ...original, id: "ud-not-the-run-0123456789abcdef" };
    const loadedRuns: string[] = [];
    const research = {
      binding: {
        loadDecision: async (_scope: unknown, id: string) =>
          id === original.id
            ? { decision: original, supersededBy: successor.id }
            : { decision: successor, supersededBy: null },
        checkUseEligibility: async () => ({ outcome: "admitted", reason: "OK" }),
        loadRunContext: async (_scope: unknown, id: string) => {
          loadedRuns.push(id);
          return { task: {} };
        },
      },
      coordinator: { useClassFor: () => ({ useClass: "official" }) },
    } as unknown as ResearchServices;
    const result = await resolveDecision(
      { ...SCOPE, application: "ai-engineer", origin: origin(), grants: [] },
      research,
      { schema: "decision-resolve.v1", decision: recordRef("use_decision", original) },
      AT,
      { dispatchId: "resolve-1", effectKey: null },
    );
    const resolution = DecisionResolutionSchema.parse(result.document);
    expect(resolution.current.id).toBe(successor.id);
    expect(resolution.chain.map((item) => item.id)).toEqual([original.id, successor.id]);
    expect(resolution.runId).toBe("authoritative-run");
    expect(result.runId).toBe(resolution.runId);
    expect(loadedRuns).toEqual(["authoritative-run"]);
    const { runId: _runId, ...legacy } = resolution;
    expect(DecisionResolutionSchema.safeParse(legacy).success).toBe(true);
    expect(DecisionResolutionSchema.safeParse({ ...legacy, runId: "" }).success).toBe(false);
  });
});

describe("evaluation context exact task audience", () => {
  it.each(["internal", "official"])("returns the stored %s audience", async (audience) => {
    const structured = {
      schemaVersion: STRUCTURED_BODY_SCHEMA_VERSION,
      sections: [
        {
          id: "summary",
          heading: [{ type: "text" as const, text: "Summary" }],
          headingExcludedReason: "title",
          blocks: [],
        },
      ],
    };
    const frozen = renderReport(structured);
    const bodyBytes = Buffer.from(frozen.text);
    const structuredBytes = Buffer.from(JSON.stringify(structured));
    const body = { ...ref("artifact", "body"), digest: digestBytes(bodyBytes) };
    const structuredBody = { ...ref("artifact", "structured"), digest: digestBytes(structuredBytes) };
    const revision = {
      schemaVersion: "research-report.v2",
      ...SCOPE,
      id: "r1",
      kind: ref("report_kind", "report-kind"),
      body,
      structuredBody,
      bodyDigest: body.digest,
      renderer: frozen.renderer,
      assertions: [],
    };
    const report = recordRef("report", revision);
    const task = {
      schemaVersion: "task.v1",
      ...SCOPE,
      id: "task1",
      audience,
      use: "report_consumption",
      policy: ref("policy", "p1"),
      rubric: ref("rubric", "r1"),
      minimumRisk: "low",
    };
    const research = {
      locator: { runOf: async () => "run1" },
      binding: {
        loadRunContext: async () => ({
          report: { revision },
          originatingOrigin: origin(),
          task,
          assertions: [],
          supportSets: [],
        }),
        custody: {
          get: async (_scope: unknown, handle: { id: string }) => (handle.id === body.id ? bodyBytes : structuredBytes),
        },
      },
    } as unknown as ResearchServices;
    const claims = {
      origin: { ...origin(), subject: "independent-auditor" },
      evaluation: { role: "auditor" },
    } as CredentialClaims;
    const result = await evaluationContext(
      claims,
      { ...SCOPE, application: "ai-engineer", origin: origin(), grants: [] },
      research,
      { schema: "evaluation-context-read.v1", report },
      { dispatchId: "context1", effectKey: null },
    );
    expect(EvaluationContextSchema.parse(result.document).task.audience).toBe(task.audience);
  });
});
