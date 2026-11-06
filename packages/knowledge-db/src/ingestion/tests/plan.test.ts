import { resolve } from "node:path";
import { canonicalJson } from "../../db-read/index.js";
import { loadWorkspace } from "../../schema-workspace/index.js";
import { describe, expect, it } from "vitest";
import { IngestionIntentSchema } from "../intent.js";
import { buildPlan, intentDigestOf, intentIdempotencyKey, proposalIdempotencyKey } from "../plan.js";
import { applyRules, loadRules, type RuleSet } from "../rules.js";
import { fixtureFacts, priceIntent } from "./test-fixtures.js";
import { classifyFailure } from "../executor.js";

const executor = { version: "knowledge-executor/test", migrationHead: "20260912020000" };
const parse = (input: unknown) => IngestionIntentSchema.parse(input);

it("rejects legacy report.publish before artifact or graph writes", () => {
  const intent = parse({
    schemaVersion: "knowledge-ingestion-intent.v1",
    intentId: "legacy-report",
    context: { tenantId: "00000000-0000-7000-8000-000000000001" },
    proposals: [
      { kind: "report.publish", proposalId: "report", title: "Legacy", asOf: "2026", markdown: "Legacy report text" },
    ],
  });
  const plan = buildPlan(intent, fixtureFacts(), executor);
  expect(plan.proposals[0]).toMatchObject({
    outcome: "rejected",
    reason: "LEGACY_REPORT_PUBLISH_UNSUPPORTED",
    actions: [],
  });
  expect(plan.errors.some((error) => error.code === "LEGACY_REPORT_PUBLISH_UNSUPPORTED")).toBe(true);
});

describe("temporal helper input preservation", () => {
  it("keeps an explicit qualified price scope despite another same-unit series", () => {
    const intent = parse(priceIntent());
    const price = intent.proposals.find(
      (p) => p.kind === "fact.assert_state" && p.streamKind === "model_offering_price",
    )!;
    const rules = { ...priceRules, rules: [priceRules.rules[0]!] };
    expect(
      applyRules(rules, { ...price, scopeKey: "eu-enterprise" } as typeof price, { existingSeriesKey: "input_tokens" })
        .proposal,
    ).toMatchObject({ scopeKey: "eu-enterprise" });
  });

  it("rejects temporal relationship semantics the SQL helper cannot preserve", () => {
    const intent = parse(priceIntent());
    const relation = intent.proposals[0]!;
    if (relation.kind !== "relationship.assert") throw new Error("fixture relationship missing");
    relation.extent = { sourceText: "August 2026", precision: "month" };
    expect(
      buildPlan(intent, fixtureFacts(), executor).errors.some((e) => e.message.includes("cannot preserve an extent")),
    ).toBe(true);
    relation.worldInterval = { from: "2026-08-01T00:00:00Z", to: null, bounds: "[)" };
    const facts = fixtureFacts();
    const relationshipKinds = new Map(facts.vocabulary.relationshipKinds);
    relationshipKinds.set("offered_as", { ...relationshipKinds.get("offered_as")!, temporal: true });
    const temporalFacts = { ...facts, vocabulary: { ...facts.vocabulary, relationshipKinds } };
    expect(
      buildPlan(intent, temporalFacts, executor).errors.some((e) => e.message.includes("only explicit accepted")),
    ).toBe(true);
    relation.temporalBasis = "explicit";
    expect(buildPlan(intent, temporalFacts, executor).errors).toEqual([]);
    relation.belief = "disputed";
    expect(
      buildPlan(intent, temporalFacts, executor).errors.some((e) => e.message.includes("only explicit accepted")),
    ).toBe(true);
  });
});

const priceRules: RuleSet = {
  rulesVersion: "ingestion-rules.v1@sha256:test",
  loaded: true,
  rules: [
    {
      id: "price.scope_key_is_unit",
      basis: "curated",
      action: "rewrite",
      when: { kind: ["fact.assert_state"], streamKind: ["model_offering_price"], missing: ["scopeKey"], equals: {} },
      set: { scopeKey: "$unit" },
      message: undefined,
      demoted: false,
    },
    {
      id: "headquarters.stage",
      basis: "curated",
      action: "stage",
      when: {
        kind: ["fact.assert_state"],
        streamKind: ["organization_headquarters"],
        missing: [],
        equals: { streamKind: "organization_headquarters" },
      },
      set: {},
      message: undefined,
      demoted: false,
    },
  ],
};

describe("plan determinism and identity", () => {
  it("produces a byte-identical plan for the same intent and facts", () => {
    const intent = parse(priceIntent());
    const first = buildPlan(intent, fixtureFacts(), executor);
    const second = buildPlan(intent, fixtureFacts(), executor);
    expect(canonicalJson(first)).toBe(canonicalJson(second));
    expect(first.planId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("excludes notes and idempotencyKey from the intent digest but changes the key when proposals change", () => {
    const base = parse(priceIntent());
    const withNotes = parse(priceIntent({ notes: "different notes", idempotencyKey: "sha256:whatever" }));
    expect(intentDigestOf(base)).toBe(intentDigestOf(withNotes));
    expect(intentIdempotencyKey(base, "r1")).toBe(intentIdempotencyKey(withNotes, "r1"));
    const changed = parse(priceIntent({ proposals: priceIntent().proposals.slice(0, 2) }));
    expect(intentIdempotencyKey(changed, "r1")).not.toBe(intentIdempotencyKey(base, "r1"));
    expect(intentIdempotencyKey(base, "r2")).not.toBe(intentIdempotencyKey(base, "r1"));
    expect(proposalIdempotencyKey(base, 0, base.proposals[0]!)).not.toBe(
      proposalIdempotencyKey(base, 1, base.proposals[0]!),
    );
  });
});

describe("planner outcomes", () => {
  it("admits proposals, synthesizes entity.create for new subjects, and orders by dependency group", () => {
    const plan = buildPlan(parse(priceIntent()), fixtureFacts(), executor);
    expect(plan.errors).toEqual([]);
    expect(plan.plannedOutcome).toBe("applied");
    expect(plan.order).toEqual(["create-gpt-5.6-terra-offering", "p-01", "p-02", "p-03"]);
    expect(plan.subjects.find((subject) => subject.ref === "gpt-5.6-terra-offering")).toMatchObject({
      resolution: "create",
      slug: "gpt-5-6-terra-api",
    });
    expect(plan.rules).toMatchObject({ loaded: false, count: 0, note: expect.stringContaining("zero rules") });
  });

  it("applies rewrite rules and records them", () => {
    const plan = buildPlan(parse(priceIntent()), fixtureFacts({ rules: priceRules }), executor);
    const price = plan.proposals.find((proposal) => proposal.proposalId === "p-03")!;
    expect(price.rewrites).toEqual([
      { rule: "price.scope_key_is_unit", field: "scopeKey", from: null, to: "per_1m_input_tokens" },
    ]);
    expect((price.effective as { scopeKey?: string }).scopeKey).toBe("per_1m_input_tokens");
    expect(
      plan.ruleChecks.some((check) => check.rule === "price.scope_key_is_unit" && check.result === "rewrite"),
    ).toBe(true);
  });

  it("rejects a disallowed unit with the allowed values", () => {
    const intent = priceIntent();
    (intent.proposals[2] as { unit: string }).unit = "per_1k_tokens";
    const plan = buildPlan(parse(intent), fixtureFacts(), executor);
    expect(plan.plannedOutcome).toBe("rejected");
    expect(plan.errors[0]).toMatchObject({
      code: "VOCABULARY_VIOLATION",
      proposalId: "p-03",
      details: { allowed: ["per_1m_input_tokens", "per_1m_output_tokens"], field: "unit" },
    });
  });

  it("marks identical current facts as no_op_duplicate", () => {
    const plan = buildPlan(
      parse(priceIntent()),
      fixtureFacts({
        existing: {
          segments: { "p-02": { segmentId: "seg-1", kFrom: 37 } },
          relationships: {},
          occurrences: {},
          seriesKeys: {},
        },
      }),
      executor,
    );
    expect(plan.proposals.find((proposal) => proposal.proposalId === "p-02")).toMatchObject({
      outcome: "no_op_duplicate",
      existing: { segmentId: "seg-1" },
    });
    expect(plan.plannedOutcome).toBe("applied");
  });

  it("routes a strong identity match to review and holds its dependents", () => {
    const subjects = {
      ...fixtureFacts().subjects,
      "gpt-5.6-terra-offering": {
        ref: "gpt-5.6-terra-offering",
        kind: "model_offering",
        matches: [
          {
            entityId: "e-existing",
            kind: "model_offering",
            displayName: "GPT-5.6 Terra",
            score: 0.99,
            basis: "alias" as const,
          },
        ],
      },
    };
    const plan = buildPlan(parse(priceIntent()), fixtureFacts({ subjects }), executor);
    expect(plan.proposals.find((proposal) => proposal.proposalId === "create-gpt-5.6-terra-offering")).toMatchObject({
      outcome: "review_required",
      reason: "identity_ambiguous",
    });
    expect(plan.proposals.find((proposal) => proposal.proposalId === "p-03")).toMatchObject({
      outcome: "held",
      reason: "subject_review_required:gpt-5.6-terra-offering",
    });
    expect(plan.plannedOutcome).toBe("partial");
    const useExisting = buildPlan(
      parse(
        priceIntent({
          subjects: (priceIntent().subjects ?? []).map((subject) =>
            subject.mode === "new" ? { ...subject, onMatch: "use_existing" as const } : subject,
          ),
        }),
      ),
      fixtureFacts({ subjects }),
      executor,
    );
    expect(useExisting.subjects.find((subject) => subject.ref === "gpt-5.6-terra-offering")).toMatchObject({
      resolution: "use_existing",
      entityId: "e-existing",
    });
    expect(
      useExisting.proposals.find((proposal) => proposal.proposalId === "create-gpt-5.6-terra-offering")?.outcome,
    ).toBe("no_op_duplicate");
  });

  it("fails EVIDENCE_NOT_ELIGIBLE and SUBJECT_MERGED before any transaction", () => {
    const plan = buildPlan(
      parse(priceIntent()),
      fixtureFacts({
        claims: [],
        subjects: {
          ...fixtureFacts().subjects,
          "gpt-5.6": { ref: "gpt-5.6", kind: "ai_model_version", lifecycle: "merged", mergedInto: "e-2" },
        },
      }),
      executor,
    );
    expect(plan.errors.map((error) => error.code)).toContain("SUBJECT_MERGED");
    expect(plan.errors.map((error) => error.code)).toContain("EVIDENCE_NOT_ELIGIBLE");
  });
});

describe("price.scope_key_is_unit reuses an existing same-unit series", () => {
  /** Renderer shape: no `set`, no `missing`; the built-in rewriter decides. */
  const renderedRule: RuleSet = {
    rulesVersion: "ingestion-rules.v1@sha256:rendered",
    loaded: true,
    rules: [
      {
        id: "price.scope_key_is_unit",
        basis: "curated",
        action: "rewrite",
        when: { kind: ["fact.assert_state"], streamKind: ["model_offering_price"], missing: [], equals: {} },
        set: {},
        message: undefined,
        demoted: false,
      },
    ],
  };
  const withSeries = (existingKey: string | undefined, rules: RuleSet = renderedRule) =>
    fixtureFacts({
      rules,
      existing: {
        segments: {},
        relationships: {},
        occurrences: {},
        seriesKeys: existingKey === undefined ? {} : { "p-03": existingKey },
      },
    });
  const priceWithScopeKey = (scopeKey: string) => {
    const intent = priceIntent();
    (intent.proposals[2] as { scopeKey?: string }).scopeKey = scopeKey;
    return parse(intent);
  };
  const priceProposal = (plan: ReturnType<typeof buildPlan>) =>
    plan.proposals.find((proposal) => proposal.proposalId === "p-03")!;

  it("fills a missing scopeKey with the existing series key instead of the unit", () => {
    const price = priceProposal(buildPlan(parse(priceIntent()), withSeries("input_tokens"), executor));
    expect(price.rewrites).toEqual([
      {
        rule: "price.scope_key_is_unit",
        field: "scopeKey",
        from: null,
        to: "input_tokens",
        reason: "existing_series_reused",
      },
    ]);
    expect((price.effective as { scopeKey?: string }).scopeKey).toBe("input_tokens");
  });

  it("rewrites a scopeKey that names a different key than the existing same-unit series", () => {
    const plan = buildPlan(priceWithScopeKey("per_1m_input_tokens"), withSeries("input_tokens"), executor);
    expect(priceProposal(plan).rewrites).toEqual([
      {
        rule: "price.scope_key_is_unit",
        field: "scopeKey",
        from: "per_1m_input_tokens",
        to: "input_tokens",
        reason: "existing_series_reused",
      },
    ]);
    expect(priceProposal(plan).actions.at(-1)?.args).toMatchObject({
      scope_key: "input_tokens",
      unit: "per_1m_input_tokens",
    });
    expect(plan.ruleChecks).toEqual([
      { rule: "price.scope_key_is_unit", basis: "curated", result: "rewrite", proposalId: "p-03" },
    ]);
  });

  it("leaves a scopeKey that already names the existing series untouched, and defaults a new series to the unit", () => {
    const kept = buildPlan(priceWithScopeKey("input_tokens"), withSeries("input_tokens"), executor);
    expect(priceProposal(kept).rewrites).toEqual([]);
    expect(kept.ruleChecks).toEqual([]);
    const fresh = priceProposal(buildPlan(parse(priceIntent()), withSeries(undefined), executor));
    expect(fresh.rewrites).toEqual([
      { rule: "price.scope_key_is_unit", field: "scopeKey", from: null, to: "per_1m_input_tokens" },
    ]);
  });

  it("applies the built-in rewriter to a loaded rule authored with `missing`/`set`", () => {
    const loaded = loadRules(
      loadWorkspace(resolve(import.meta.dirname, "../../../test/schema-workspace/fixtures/workspace")),
    );
    const plan = buildPlan(priceWithScopeKey("per_1m_input_tokens"), withSeries("input_tokens", loaded), executor);
    expect(priceProposal(plan).rewrites).toEqual([
      {
        rule: "price.scope_key_is_unit",
        field: "scopeKey",
        from: "per_1m_input_tokens",
        to: "input_tokens",
        reason: "existing_series_reused",
      },
    ]);
  });
});

describe("stale heads", () => {
  it("rebases when the head moved but no touched slot changed", () => {
    const plan = buildPlan(
      parse(priceIntent()),
      fixtureFacts({
        currentHead: 43,
        whatChanged: [
          {
            subjectRef: "gpt-5.6",
            entityId: "x",
            itemKind: "segment",
            itemId: "s",
            knowledgeSeq: 42,
            streamKind: "model_version_spec",
            scopeKey: "",
          },
        ],
      }),
      executor,
    );
    expect(plan.head).toMatchObject({
      snapshot: 41,
      current: 43,
      stale: true,
      rebased: true,
      effectiveExpectedHead: 43,
      touchedBy: [],
    });
    expect(plan.errors).toEqual([]);
  });

  it("returns REBASE_REQUIRED when a touched relationship changed, or whenever onStale=fail", () => {
    const touched = buildPlan(
      parse(priceIntent()),
      fixtureFacts({
        currentHead: 43,
        whatChanged: [
          {
            subjectRef: "gpt-5.6",
            entityId: "x",
            itemKind: "relationship",
            itemId: "r",
            knowledgeSeq: 42,
            relationshipKind: "offered_as",
          },
        ],
      }),
      executor,
    );
    expect(touched.errors[0]).toMatchObject({ code: "REBASE_REQUIRED", details: { touchedBy: ["p-01"] } });
    const strict = buildPlan(parse(priceIntent({ onStale: "fail" })), fixtureFacts({ currentHead: 42 }), executor);
    expect(strict.errors[0]?.code).toBe("REBASE_REQUIRED");
    expect(strict.head.touchedBy).toEqual(["p-01", "p-02", "p-03"]);
  });

  it("maps SQLSTATE 40001 from begin_batch to REBASE_REQUIRED and slot violations to VOCABULARY_VIOLATION", () => {
    expect(classifyFailure({ code: "40001", message: "rebase_required" }).code).toBe("REBASE_REQUIRED");
    expect(classifyFailure({ code: "23514", message: "stream slot/payload rules violated" }).code).toBe(
      "VOCABULARY_VIOLATION",
    );
    expect(classifyFailure({ code: "P0001", message: "knowledge batch already open" }).code).toBe("BATCH_OPEN");
  });
});

describe("applyRules", () => {
  it("stages, notes, and leaves unmatched proposals untouched", () => {
    const staged = applyRules(priceRules, {
      proposalId: "hq",
      kind: "fact.assert_state",
      streamKind: "organization_headquarters",
      subjectRef: "openai",
      worldInterval: { from: "2020-01-01T00:00:00Z", to: null, bounds: "[)" },
      temporalBasis: "observation_bounded",
      belief: "accepted",
      evidence: [],
      dependsOn: [],
      payload: {},
    });
    expect(staged.verdict).toBe("stage");
    const untouched = applyRules(priceRules, {
      proposalId: "a",
      kind: "entity.alias",
      subjectRef: "openai",
      alias: "OAI",
      aliasKind: "acronym",
      belief: "accepted",
      evidence: [],
      dependsOn: [],
    });
    expect(untouched).toMatchObject({ verdict: "admit", rewrites: [], checks: [] });
  });
});
