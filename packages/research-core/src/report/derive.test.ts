import { describe, expect, it } from "vitest";
import { recordRef } from "../digest.js";
import { type DomainMapping, DomainMappingSchema, MAPPING_SCHEMA_VERSION } from "../records/mapping.js";
import {
  NORMALIZATION_VERSION,
  RENDERER_VERSION,
  REPORT_SCHEMA_VERSION,
  type ReportRevision,
} from "../records/report.js";
import { evaluateSupport } from "../support/algebra.js";
import { BINDING, SCOPE, TENANT, assertion, qualifiers, ref, supportObservation, supportSet } from "../test-support.js";
import { reportDerive } from "./derive.js";

const resolved = assertion("a-resolved");
const unresolved = assertion("a-unresolved", { qualifiers: qualifiers({ entity: "SGLang" }) });
const timeless = assertion("a-timeless", { qualifiers: qualifiers({ time: null }) });
const unsupported = assertion("a-unsupported");
const all = [resolved, unresolved, timeless, unsupported];
const sets = all.map((item) =>
  supportSet(`s-${item.id}`, item, [{ premise: "p", evidence: [ref("fragment", "f-1")] }]),
);
const observations = sets
  .slice(0, 3)
  .map((set, index) =>
    supportObservation({ id: `o-${index}`, set, target: all[index] ?? resolved, verdict: "full_support" }),
  );
const support = all.map((item) =>
  evaluateSupport({ scope: SCOPE, assertion: item, assertions: [], supportSets: sets, observations }),
);
const body = ref("artifact", "body-1");

const revision: ReportRevision = {
  schemaVersion: REPORT_SCHEMA_VERSION,
  id: "report-1",
  tenant: TENANT,
  binding: BINDING,
  kind: ref("report_kind", "engineering-research"),
  task: ref("task", "task-1"),
  structuredBody: ref("artifact", "structured-1"),
  body,
  bodyDigest: body.digest,
  renderer: RENDERER_VERSION,
  normalization: NORMALIZATION_VERSION,
  ledger: ref("artifact", "ledger-1"),
  assertions: [...all, assertion("a-missing")].map((item) => recordRef("assertion", item)),
  timeCoverage: { world: null, observed: null, knowledgeHead: null },
  derivationCandidates: [],
  supersedes: null,
};

const mapping: DomainMapping = {
  schemaVersion: MAPPING_SCHEMA_VERSION,
  id: "mapping-1",
  tenant: TENANT,
  binding: BINDING,
  targetSchema: "aiengineer.benchmark_fact.v1",
  rules: [
    {
      ruleId: "throughput",
      assertionKinds: ["world_fact"],
      target: "benchmark_fact",
      includeValue: true,
      qualifierFields: ["unit", "runtime"],
      requiresEntity: true,
      requiresTime: true,
    },
  ],
  entityResolutions: [{ surface: "vLLM", entityId: "engine/vllm", resolution: ref("artifact", "er-1") }],
};

describe("report_derive (design §3.2)", () => {
  const derived = reportDerive({ revision, assertions: all, support, mapping });

  it("compiles only supported assertions with resolved mappings", () => {
    expect(derived.proposals).toHaveLength(1);
    expect(derived.proposals[0]).toMatchObject({
      entityId: "engine/vllm",
      fields: { unit: "tokens/s", runtime: "cuda-12" },
      value: { type: "quantity", amount: "1200" },
    });
  });

  it("holds unresolved entity/time items individually and never resolves entities itself", () => {
    const reasons = Object.fromEntries(derived.held.map((item) => [item.assertion.id, item.reason]));
    expect(reasons).toEqual({
      "a-unresolved": "unresolved_entity",
      "a-timeless": "unresolved_time",
      "a-unsupported": "not_supported",
      "a-missing": "assertion_unavailable",
    });
  });

  it("is deterministic", () => {
    const again = reportDerive({ revision, assertions: all, support, mapping });
    expect(again.proposals[0]?.proposalDigest).toBe(derived.proposals[0]?.proposalDigest);
  });
});

describe("mapping qualifier field names (SV-09)", () => {
  it("accepts camelCase field names exactly as the profile spells them and projects them", () => {
    const camel = DomainMappingSchema.parse({
      ...mapping,
      id: "mapping-camel",
      rules: [{ ...mapping.rules[0], qualifierFields: ["unit", "softwareVersion", "benchmarkEnvironment"] }],
    });
    const out = reportDerive({ revision, assertions: all, support, mapping: camel });
    expect(out.proposals[0]?.fields).toEqual({
      unit: "tokens/s",
      softwareVersion: "0.6.0",
      benchmarkEnvironment: null,
    });
    expect(
      DomainMappingSchema.safeParse({ ...mapping, rules: [{ ...mapping.rules[0], qualifierFields: ["Bad-Name"] }] })
        .success,
    ).toBe(false);
  });
});
