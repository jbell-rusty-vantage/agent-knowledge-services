import {
  type Digest,
  type EvaluatorIdentity,
  type Origin,
  type Ref,
  digestBytes,
} from "@aiengineer/knowledge-operation-protocol";
import {
  ASSERTION_SCHEMA_VERSION,
  type AssertionVersion,
  ENGINEERING_RUBRIC_VERSION,
  type EngineeringQualifiers,
  SCIENTIFIC_RUBRIC_VERSION,
  type ScientificQualifiers,
  type EvidenceFragment,
  FRAGMENT_SCHEMA_VERSION,
  OBSERVATION_SCHEMA_VERSION,
  SUPPORT_SET_SCHEMA_VERSION,
  type StructuredBody,
  type SupportSet,
  type SupportVerdict,
  TASK_SCHEMA_VERSION,
  type VerificationObservation,
  type VerificationTaskContract,
  type AuthScope,
  type SealSigner,
  qualifiersDigest,
  recordRef,
} from "@aiengineer/knowledge-research-core";

import { ReportAssessmentService } from "./assessment.js";
import { type DiscoveryScript, ScriptedAuditorDiscovery } from "./auditor.js";
import { type Clock, ResearchCoordinator } from "./coordinator.js";
import type { OperationStore, ResearchBinding } from "./ports.js";
import type { ReportKindCatalog } from "./report-kinds.js";
import { testSealKeys } from "./signing.js";
import type { SourceAuthorityCatalog } from "./source-authority.js";

/** The deterministic disposable seal key every fixture seals with (never a deployment key). */
export const FIXTURE_SEAL_KEYS = testSealKeys("ks-fixture-seal-1");

/** Deterministic Sprint V fixtures (disposable engineering data; never research corpus). Shared by T0 and T1 tests. */
export const AT = "2026-10-24T22:00:00Z";

export function fixtureOrigin(tenant: string, mission = true): Origin {
  return {
    kind: mission ? "mission_invocation" : "standalone",
    installationId: "0192a4f0-0000-7000-8000-0000000a1e00",
    applicationId: "ai-engineer",
    tenantId: tenant,
    issuer: "mission-control",
    subject: "mission-control-runtime",
    mission: mission
      ? {
          missionId: "mission-sv05",
          runId: "run-sv05",
          activationId: null,
          operationId: "op-verify-1",
          operationAttempt: 1,
          executionGeneration: 1,
          lane: "deep_agents",
        }
      : null,
    recoveryAuthorityRef: null,
    invocationId: "inv-sv05-1",
    authenticatedAt: AT,
  };
}

export function fixtureRef<K extends Ref["kind"]>(
  kind: K,
  id: string,
  tenant: string,
  binding: string,
  version = "fixture.record.v1",
): Ref<K> {
  return { kind, id, version, digest: digestBytes(`${kind}:${id}`), tenant, binding } as Ref<K>;
}

export function fixtureTask(tenant: string, binding: string): VerificationTaskContract {
  return {
    schemaVersion: TASK_SCHEMA_VERSION,
    id: "task-sv05",
    tenant,
    binding,
    domain: "engineering",
    originalTask: fixtureRef("artifact", "task-artifact", tenant, binding, "artifact.v1"),
    use: "knowledge_ingestion.fact_assert_state",
    audience: "official",
    obligations: [
      {
        id: "finding.size",
        description: "State the model's parameter count with its source.",
        weight: 6000,
        required: true,
      },
      { id: "limitation.license", description: "State the model's license.", weight: 4000, required: false },
    ],
    asOf: AT,
    permittedMedia: ["text_markdown"],
    rubric: fixtureRef("rubric", "rubric-engineering", tenant, binding, ENGINEERING_RUBRIC_VERSION),
    policy: fixtureRef("policy", "policy-ai-engineer", tenant, binding, "research-policy.ai-engineer.v2"),
    minimumRisk: "medium",
    limits: { calls: 10, tokens: 100000, costUsd: "1", deadline: "2026-10-24T23:00:00Z" },
  };
}

export function fixtureQualifiers(): EngineeringQualifiers {
  return {
    profile: "engineering.v2",
    entity: "model-x",
    population: null,
    time: null,
    unit: "parameters",
    jurisdiction: null,
    baseline: null,
    negation: false,
    modality: "asserted",
    comparison: null,
    runtime: null,
    softwareVersion: null,
    configuration: null,
    benchmarkEnvironment: null,
    denominator: null,
    repositoryCommit: null,
  } as EngineeringQualifiers;
}

export function fixtureFragment(tenant: string, binding: string): EvidenceFragment {
  return {
    schemaVersion: FRAGMENT_SCHEMA_VERSION,
    id: "frag-model-card",
    tenant,
    binding,
    sourceVersion: "model-card-2026-10",
    capture: fixtureRef("artifact", "capture-1", tenant, binding, "artifact.v1"),
    representation: fixtureRef("artifact", "representation-1", tenant, binding, "artifact.v1"),
    selector: {
      kind: "text_quote",
      value: "7B parameters",
      resolverVersion: "text-quote.v3",
      normalizationVersion: "text-norm.v1",
    },
    selectedDigest: digestBytes("7B parameters"),
    selectedSize: 13,
    context: { header: "Model details", footnotes: [], surroundingDigest: null },
    parserLineage: ["markdown-parser.v2"],
    captureCompleteness: "complete",
    access: { rights: "public", limits: [] },
    originFamily: null,
  };
}

export function fixtureAssertion(tenant: string, binding: string, origin: Origin): AssertionVersion {
  return {
    schemaVersion: ASSERTION_SCHEMA_VERSION,
    id: "asr-model-size-v1",
    tenant,
    binding,
    logicalId: "model-size",
    proposition: "Model X has 7B parameters.",
    kind: "source_report",
    value: { type: "quantity", amount: "7000000000", unit: "parameters" },
    subject: "model-x",
    object: null,
    qualifiers: fixtureQualifiers(),
    riskReasons: [],
    producer: origin,
    premises: [],
  };
}

export function fixtureSupportSet(
  tenant: string,
  binding: string,
  assertion: AssertionVersion,
  fragment: EvidenceFragment,
): SupportSet {
  return {
    schemaVersion: SUPPORT_SET_SCHEMA_VERSION,
    id: "ss-model-size",
    tenant,
    binding,
    assertion: recordRef("assertion", assertion),
    qualifiersDigest: qualifiersDigest(assertion.qualifiers),
    provenance: "declared_citation",
    required: [{ premise: "size", evidence: [recordRef("fragment", fragment)], derivedFrom: [] }],
    contrary: [],
  };
}

export function fixtureBody(assertion: AssertionVersion, fragment: EvidenceFragment): StructuredBody {
  const cite = { type: "citation", label: "mc", fragment: recordRef("fragment", fragment) } as const;
  const heading = (text: string) => [{ type: "text" as const, text }];
  return {
    schemaVersion: "research-core.structured_body.v2",
    sections: [
      {
        id: "scope",
        heading: heading("Scope"),
        headingExcludedReason: "section title",
        blocks: [
          {
            type: "paragraph",
            id: "p1",
            inlines: [{ type: "text", text: "Parameter count of Model X for official ingestion, as of 2026-10-24." }],
            excludedReason: "scope statement",
          },
        ],
      },
      {
        id: "findings",
        heading: heading("Model X"),
        headingExcludedReason: "section title",
        blocks: [
          {
            type: "paragraph",
            id: "p1",
            inlines: [
              {
                type: "claim",
                occurrenceId: "occ-size-1",
                assertion: recordRef("assertion", assertion),
                text: "Model X has 7B parameters.",
                obligations: ["finding.size"],
                attribution: "model card",
              },
              { type: "text", text: " " },
              cite,
            ],
            excludedReason: null,
          },
        ],
      },
      {
        id: "evidence",
        heading: heading("Evidence"),
        headingExcludedReason: "section title",
        blocks: [
          {
            type: "paragraph",
            id: "p1",
            inlines: [{ type: "text", text: "The vendor model card states the parameter count. " }, cite],
            excludedReason: "citation summary",
          },
        ],
      },
      {
        id: "limitations",
        heading: heading("Limitations"),
        headingExcludedReason: "section title",
        blocks: [
          {
            type: "list",
            id: "l1",
            ordered: false,
            items: [[{ type: "text", text: "The license was not assessed." }]],
            excludedReason: "limitation statement",
          },
        ],
      },
    ],
  };
}

export function fixtureEvaluator(role: EvaluatorIdentity["role"], family: string): EvaluatorIdentity {
  return {
    role,
    kind: "model",
    provider: family,
    family,
    model: `${family}-model`,
    deployment: null,
    reviewerId: null,
    methodVersion: "l1-support.v2",
    promptDigest: digestBytes(`prompt-${role}`),
    configDigest: digestBytes(`config-${role}`),
  };
}

export function fixtureSupportObservation(input: {
  tenant: string;
  binding: string;
  id: string;
  set: SupportSet;
  fragment: EvidenceFragment;
  role: EvaluatorIdentity["role"];
  verdict: SupportVerdict;
  qualifiersDigest: Digest;
}): VerificationObservation {
  const fragmentRef = recordRef("fragment", input.fragment);
  return {
    schemaVersion: OBSERVATION_SCHEMA_VERSION,
    id: input.id,
    tenant: input.tenant,
    binding: input.binding,
    target: recordRef("support_set", input.set),
    inputDigest: digestBytes(`input-${input.id}`),
    qualifiersDigest: input.qualifiersDigest,
    method: fixtureRef("method", "evidence-only-judge", input.tenant, input.binding, "l1-support.v2"),
    evaluator: fixtureEvaluator(input.role, input.role === "producer" ? "family-producer" : "family-judge"),
    rationale: "the quoted text states the parameter count exactly",
    limitations: [],
    evidence: [fragmentRef],
    rawResponse: null,
    usage: { providerCalls: 1, tokens: 420, costUsd: "0.0009" },
    recordedAt: AT,
    property: "support",
    outcome: {
      verdict: input.verdict,
      premise: "size",
      citedFragments: input.verdict === "full_support" || input.verdict === "qualified_support" ? [fragmentRef] : [],
      contradictingFragments: input.verdict === "contradiction" ? [fragmentRef] : [],
      unsupportedFacets: [],
      qualification: input.verdict === "qualified_support" ? "as reported by the vendor" : null,
    },
  } as VerificationObservation;
}

/** The scripted auditor script that independently rediscovers the evidence-report claim (T0/T1 only). */
export const EVIDENCE_REPORT_SCRIPT: DiscoveryScript = {
  entries: [{ quote: "Model X has 7B parameters.", assertionLogicalId: "model-size" }],
};

// ---------------------------------------------------------------------------------------------------------------
// Study appraisal (K08 `study_appraisal`): ONE study, appraisal domains as table rows, no body-of-evidence rating.
// ---------------------------------------------------------------------------------------------------------------
export const APPRAISAL_DOMAINS = ["selection", "performance", "detection", "attrition", "reporting"] as const;

export function fixtureScientificTask(tenant: string, binding: string): VerificationTaskContract {
  return {
    ...fixtureTask(tenant, binding),
    id: "task-sv06-appraisal",
    domain: "scientific",
    use: "knowledge_ingestion.study_appraisal",
    obligations: [
      { id: "design.trial", description: "State the trial's design and population.", weight: 3000, required: true },
      { id: "domain.selection", description: "Report allocation concealment.", weight: 5000, required: true },
      { id: "applicability.population", description: "Population applicability.", weight: 2000, required: false },
    ],
    rubric: fixtureRef("rubric", "rubric-scientific", tenant, binding, SCIENTIFIC_RUBRIC_VERSION),
  };
}

export function fixtureScientificQualifiers(): ScientificQualifiers {
  return {
    profile: "scientific.v2",
    entity: "trial-alpha",
    population: "adults with condition c",
    time: null,
    unit: null,
    jurisdiction: null,
    baseline: null,
    negation: false,
    modality: "asserted",
    comparison: null,
    claimClass: "source_report",
    studyDesign: "randomized_controlled_trial",
    species: "human",
    intervention: "drug a",
    comparator: "placebo",
    endpoint: null,
    sampleSize: 120,
    effectMeasure: null,
    followUp: null,
    causalClaim: "none",
    appraisalDomain: null,
    appraisalJudgment: null,
  };
}

export function fixtureStudyAppraisal(tenant: string, binding: string, origin: Origin) {
  const fragment: EvidenceFragment = {
    ...fixtureFragment(tenant, binding),
    id: "frag-trial-alpha",
    sourceVersion: "trial-alpha-paper-v1",
    selector: {
      kind: "text_quote",
      value: "120 adults were randomized centrally",
      resolverVersion: "text-quote.v3",
      normalizationVersion: "text-norm.v1",
    },
    selectedDigest: digestBytes("120 adults were randomized centrally"),
    selectedSize: 36,
  };
  const assertion = (id: string, logicalId: string, proposition: string): AssertionVersion => ({
    ...fixtureAssertion(tenant, binding, origin),
    id,
    logicalId,
    proposition,
    kind: "source_report",
    value: { type: "none" },
    subject: "trial-alpha",
    qualifiers: fixtureScientificQualifiers(),
  });
  const design = assertion("asr-trial-design-v1", "trial-design", "Trial Alpha randomized 120 adults.");
  // SV-07: the appraisal domain and its judgment are scientific qualifiers about this one study.
  const allocation: AssertionVersion = {
    ...assertion(
      "asr-trial-allocation-v1",
      "trial-allocation",
      "Trial Alpha concealed allocation by central randomization.",
    ),
    qualifiers: { ...fixtureScientificQualifiers(), appraisalDomain: "selection", appraisalJudgment: "low" },
  };
  const set = (id: string, target: AssertionVersion): SupportSet => ({
    ...fixtureSupportSet(tenant, binding, target, fragment),
    id,
    qualifiersDigest: qualifiersDigest(target.qualifiers),
  });
  const supportSets = [set("ss-trial-design", design), set("ss-trial-allocation", allocation)];
  const cite = { type: "citation", label: "alpha", fragment: recordRef("fragment", fragment) } as const;
  const text = (value: string) => ({ type: "text" as const, text: value });
  const body: StructuredBody = {
    schemaVersion: "research-core.structured_body.v2",
    sections: [
      {
        id: "study",
        heading: [text("Trial Alpha")],
        headingExcludedReason: "section title",
        blocks: [
          {
            type: "paragraph",
            id: "p1",
            inlines: [
              {
                type: "claim",
                occurrenceId: "occ-design-1",
                assertion: recordRef("assertion", design),
                text: "Trial Alpha randomized 120 adults.",
                obligations: ["design.trial"],
                attribution: "trial alpha report",
              },
              text(" "),
              cite,
            ],
            excludedReason: null,
          },
        ],
      },
      {
        id: "domains",
        heading: [text("Appraisal domains")],
        headingExcludedReason: "section title",
        blocks: [
          {
            type: "table",
            id: "t1",
            header: [[text("Domain")], [text("What the study reported")]],
            rows: APPRAISAL_DOMAINS.map((domain) =>
              domain === "selection"
                ? [
                    [text(domain)],
                    [
                      {
                        type: "claim" as const,
                        occurrenceId: "occ-allocation-1",
                        assertion: recordRef("assertion", allocation),
                        text: "Trial Alpha concealed allocation by central randomization.",
                        obligations: ["domain.selection"],
                        attribution: "trial alpha report",
                      },
                    ],
                  ]
                : [[text(domain)], [text("not reported")]],
            ),
            caption: null,
            excludedReason: null,
            headerExcludedReason: "column labels",
          },
        ],
      },
      {
        id: "limitations",
        heading: [text("Limitations")],
        headingExcludedReason: "section title",
        blocks: [
          {
            type: "paragraph",
            id: "p1",
            inlines: [text("Only the published report was available.")],
            excludedReason: "limitation statement",
          },
        ],
      },
    ],
  };
  // Domain labels and "not reported" cells are factual units without a claim: the auditor explains each one.
  const unitExplanations = APPRAISAL_DOMAINS.flatMap((domain, index) => [
    { path: `domains/t1/r${index}/c0`, reason: "appraisal domain label" },
    ...(domain === "selection" ? [] : [{ path: `domains/t1/r${index}/c1`, reason: "nothing asserted: not reported" }]),
  ]);
  const script: DiscoveryScript = {
    entries: [
      { quote: "Trial Alpha randomized 120 adults.", assertionLogicalId: "trial-design" },
      { quote: "Trial Alpha concealed allocation by central randomization.", assertionLogicalId: "trial-allocation" },
    ],
    unitExplanations,
  };
  return {
    task: fixtureScientificTask(tenant, binding),
    fragment,
    assertions: [design, allocation],
    supportSets,
    body,
    script,
  };
}

/** Everything one report-kind round trip needs, for either kind. */
export interface ReportKindCase {
  readonly kindId: "evidence_report" | "study_appraisal";
  readonly task: VerificationTaskContract;
  readonly fragments: readonly EvidenceFragment[];
  readonly assertions: readonly AssertionVersion[];
  readonly supportSets: readonly SupportSet[];
  readonly body: StructuredBody;
  readonly script: DiscoveryScript;
}

export function reportKindCases(tenant: string, binding: string, origin: Origin): ReportKindCase[] {
  const fragment = fixtureFragment(tenant, binding);
  const assertion = fixtureAssertion(tenant, binding, origin);
  const appraisal = fixtureStudyAppraisal(tenant, binding, origin);
  return [
    {
      kindId: "evidence_report",
      task: fixtureTask(tenant, binding),
      fragments: [fragment],
      assertions: [assertion],
      supportSets: [fixtureSupportSet(tenant, binding, assertion, fragment)],
      body: fixtureBody(assertion, fragment),
      script: EVIDENCE_REPORT_SCRIPT,
    },
    {
      kindId: "study_appraisal",
      task: appraisal.task,
      fragments: [appraisal.fragment],
      assertions: appraisal.assertions,
      supportSets: appraisal.supportSets,
      body: appraisal.body,
      script: appraisal.script,
    },
  ];
}

/**
 * One full round trip of a report kind: register evidence -> register (render, freeze, ledger, kind check) -> judge
 * observations -> async `report.assess` (independent census + aggregation) -> seal -> report use decision.
 */
export async function reportKindRoundTrip(input: {
  readonly scope: AuthScope;
  readonly binding: ResearchBinding;
  readonly operations: OperationStore;
  readonly kinds: ReportKindCatalog;
  readonly kase: ReportKindCase;
  readonly clock: Clock;
  /** K07 sealer (defaults to the deterministic fixture key; the binding must pin the same key). */
  readonly signer?: SealSigner;
  readonly authority?: SourceAuthorityCatalog | null;
}) {
  const { scope, kase } = input;
  const coordinator = new ResearchCoordinator(input.binding, input.clock, input.kinds, {
    signer: input.signer ?? FIXTURE_SEAL_KEYS.signer,
    authority: input.authority ?? null,
  });
  const { runId } = await coordinator.openRun(scope, { task: kase.task, originatingOrigin: scope.origin });
  await coordinator.registerEvidence(scope, {
    fragments: kase.fragments,
    assertions: kase.assertions,
    supportSets: kase.supportSets,
  });
  const registered = await coordinator.registerReport(scope, {
    runId,
    reportId: `report-${kase.kindId}`,
    revision: 1,
    kind: input.kinds.ref(scope, kase.kindId),
    structuredBody: kase.body,
    assertions: kase.assertions.map((assertion) => recordRef("assertion", assertion)),
    timeCoverage: { world: null, observed: { from: AT, to: AT }, knowledgeHead: null },
    supersedes: null,
  });
  for (const set of kase.supportSets) {
    const assertion = kase.assertions.find((candidate) => candidate.id === set.assertion.id) as AssertionVersion;
    await coordinator.observe(
      scope,
      runId,
      fixtureSupportObservation({
        tenant: scope.tenant,
        binding: scope.binding,
        id: `obs-judge-${set.id}`,
        set,
        fragment: kase.fragments[0] as EvidenceFragment,
        role: "judge",
        verdict: "full_support",
        qualifiersDigest: qualifiersDigest(assertion.qualifiers),
      }),
    );
  }
  const auditor = new ScriptedAuditorDiscovery(kase.script);
  const service = new ReportAssessmentService({
    binding: input.binding,
    coordinator,
    operations: input.operations,
    auditor,
    clock: input.clock,
  });
  const handle = await service.start(scope, { runId, reportRef: registered.report, requestId: `req-${kase.kindId}` });
  const queued = await service.status(scope, handle);
  const assessed = await service.run(scope, handle);
  const sealed = await coordinator.sealVerificationSnapshot(scope, {
    runId,
    build: { buildId: "build-sv06", runtime: "node24", dirty: true },
    signer: "ks-sealer",
  });
  const decided = await coordinator.decideReportUse(scope, {
    runId,
    use: kase.task.use,
    audience: "official",
    boundEffectDigest: digestBytes(`effect-${kase.kindId}`),
    targetSchema: "aiengineer-database-contract.v1",
    normalizedValues: {},
    policy: kase.task.policy,
    rubric: kase.task.rubric,
  });
  return { coordinator, service, auditor, runId, registered, handle, queued, assessed, sealed, decided };
}
