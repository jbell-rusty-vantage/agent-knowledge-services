import type {
  VerificationBenchmarkArm,
  VerificationBenchmarkCase,
  VerificationBenchmarkCaseResult,
  VerificationBenchmarkDataset,
} from "@aiengineer/knowledge-contracts";
import {
  assertFrozenVerificationBenchmarkDataset,
  assertVerificationBenchmarkRun,
  type VerificationBenchmarkRun,
} from "@aiengineer/knowledge-evaluation";
import { digestCanonicalJson } from "@aiengineer/knowledge-verification";
import type { DiagnosticsAdversarialObservation } from "./verification-diagnostics-adversarial.js";

type Digest = `sha256:${string}`;
export type DiagnosticsMutationFamily =
  | "names"
  | "algorithms"
  | "biomarkers"
  | "counts"
  | "institutions"
  | "qualifiers"
  | "citations";
export type DiagnosticsMutationComparison =
  | "strict_degradation"
  | "nonincrease"
  | "monotonicity_violation"
  | "not_measurable";

const requiredFamilies: readonly DiagnosticsMutationFamily[] = [
  "names",
  "algorithms",
  "biomarkers",
  "counts",
  "institutions",
  "qualifiers",
  "citations",
];
const familyForTransform: Readonly<Record<string, readonly DiagnosticsMutationFamily[]>> = Object.freeze({
  algorithm_count_swap: ["algorithms", "counts"],
  algorithm_definition_swap: ["algorithms"],
  count_or_timeline_swap: ["counts"],
  count_swap: ["counts"],
  cross_page_count_laundering: ["counts"],
  conflict_erasure: ["counts"],
  missing_start_event_qualifier: ["qualifiers"],
  safety_qualifier_reversal: ["qualifiers"],
  negation_removal: ["qualifiers"],
});
const supportRank: Readonly<Record<VerificationBenchmarkCaseResult["support"], number>> = Object.freeze({
  full: 4,
  partial: 3,
  none: 2,
  contradicted: 1,
  not_applicable: 0,
});
const policyRank: Readonly<Record<VerificationBenchmarkCaseResult["policy"], number>> = Object.freeze({
  pass: 5,
  pass_with_warnings: 4,
  review: 3,
  abstain: 2,
  fail: 1,
});

export interface DiagnosticsMutationReportInput {
  readonly dataset: VerificationBenchmarkDataset;
  readonly run: VerificationBenchmarkRun;
  readonly observations: readonly DiagnosticsAdversarialObservation[];
}

interface CaseBinding {
  readonly caseId: string;
  readonly caseDigest: Digest;
  readonly inputManifestArtifactId: string;
  readonly evidence: readonly {
    readonly captureId: string;
    readonly fragmentId: string;
    readonly projectionArtifactId: string;
    readonly projectionDigest: Digest;
    readonly transformationArtifactId: string;
    readonly selectedContentDigest: Digest;
  }[];
}

interface ComparisonFields {
  readonly support: DiagnosticsMutationComparison;
  readonly policy: DiagnosticsMutationComparison;
  readonly fieldMechanics: DiagnosticsMutationComparison;
  readonly reason?:
    | "original_or_mutated_failure"
    | "support_not_applicable"
    | "support_or_policy_improved"
    | "field_mechanics_improved";
}

export interface DiagnosticsAdversarialMutationReport {
  readonly schemaVersion: "diagnostics-adversarial-mutation-report.v1";
  readonly datasetManifestDigest: Digest;
  readonly runManifestDigest: Digest;
  readonly experimentDefinitionDigest: Digest;
  readonly counts: { readonly cases: number; readonly pairs: number; readonly arms: 4; readonly observations: number };
  readonly pairs: readonly {
    readonly pairCluster: string;
    readonly original: CaseBinding;
    readonly mutated: CaseBinding & { readonly rawTransforms: readonly string[] };
    readonly arms: readonly {
      readonly armId: string;
      readonly original: Pick<
        VerificationBenchmarkCaseResult,
        | "checkpointContextDigest"
        | "checkpointDigest"
        | "support"
        | "policy"
        | "fieldMechanics"
        | "failureClass"
        | "locatorValid"
      >;
      readonly mutated: Pick<
        VerificationBenchmarkCaseResult,
        | "checkpointContextDigest"
        | "checkpointDigest"
        | "support"
        | "policy"
        | "fieldMechanics"
        | "failureClass"
        | "locatorValid"
      >;
      readonly comparison: ComparisonFields;
    }[];
  }[];
  readonly unpairedClusters: readonly {
    readonly pairCluster: string;
    readonly caseIds: readonly string[];
    readonly reason: "missing_literal_original" | "missing_mutated_case" | "ambiguous_pair";
  }[];
  readonly missingObservationCaseIds: readonly string[];
  readonly rawTransformCoverage: readonly {
    readonly rawTransform: string;
    readonly families: readonly DiagnosticsMutationFamily[];
  }[];
  readonly familyCoverage: readonly {
    readonly family: DiagnosticsMutationFamily;
    readonly rawTransforms: readonly string[];
    readonly covered: boolean;
  }[];
  readonly missingFamilies: readonly DiagnosticsMutationFamily[];
  readonly citationMechanics: readonly {
    readonly caseId: string;
    readonly corruptedLocator: "rejected" | "accepted" | "unavailable";
    readonly selectedDigestTamper: "rejected" | "accepted";
    readonly exactSource: "accepted" | "rejected";
    readonly assertionTextReplay: "accepted" | "rejected";
  }[];
  readonly limitations: readonly string[];
  readonly reportDigest: Digest;
}

const caseBinding = (testCase: VerificationBenchmarkCase): CaseBinding =>
  Object.freeze({
    caseId: testCase.caseId,
    caseDigest: testCase.caseDigest as Digest,
    inputManifestArtifactId: testCase.inputManifestArtifactId,
    evidence: Object.freeze(
      testCase.evidence.map((item) =>
        Object.freeze({
          captureId: item.captureId,
          fragmentId: item.fragmentId,
          projectionArtifactId: item.projectionArtifactId,
          projectionDigest: item.projectionDigest as Digest,
          transformationArtifactId: item.transformationArtifactId,
          selectedContentDigest: item.selectedContentDigest as Digest,
        }),
      ),
    ),
  });
const compactResult = (result: VerificationBenchmarkCaseResult) =>
  Object.freeze({
    checkpointContextDigest: result.checkpointContextDigest,
    checkpointDigest: result.checkpointDigest,
    support: result.support,
    policy: result.policy,
    fieldMechanics: result.fieldMechanics,
    failureClass: result.failureClass,
    locatorValid: result.locatorValid,
  });

function comparison(
  original: VerificationBenchmarkCaseResult,
  mutated: VerificationBenchmarkCaseResult,
): ComparisonFields {
  if (original.failureClass !== "none" || mutated.failureClass !== "none")
    return {
      support: "not_measurable",
      policy: "not_measurable",
      fieldMechanics: "not_measurable",
      reason: "original_or_mutated_failure",
    };
  const ranked = (before: number, after: number): DiagnosticsMutationComparison =>
    after < before ? "strict_degradation" : after === before ? "nonincrease" : "monotonicity_violation";
  const support =
    original.support === "not_applicable" || mutated.support === "not_applicable"
      ? "not_measurable"
      : ranked(supportRank[original.support], supportRank[mutated.support]);
  const policy = ranked(policyRank[original.policy], policyRank[mutated.policy]);
  const fieldMechanics: DiagnosticsMutationComparison =
    original.fieldMechanics && !mutated.fieldMechanics
      ? "strict_degradation"
      : original.fieldMechanics === mutated.fieldMechanics
        ? "nonincrease"
        : "monotonicity_violation";
  const reason =
    support === "not_measurable"
      ? "support_not_applicable"
      : policy === "monotonicity_violation" || support === "monotonicity_violation"
        ? "support_or_policy_improved"
        : fieldMechanics === "monotonicity_violation"
          ? "field_mechanics_improved"
          : undefined;
  return reason === undefined ? { support, policy, fieldMechanics } : { support, policy, fieldMechanics, reason };
}
function assertRun(input: DiagnosticsMutationReportInput): Map<string, Map<string, VerificationBenchmarkCaseResult>> {
  const { dataset, run, observations } = input;
  assertFrozenVerificationBenchmarkDataset(dataset);
  assertVerificationBenchmarkRun(dataset, run);
  if (run.arms.length !== 4) throw new Error("DIAGNOSTICS_MUTATION_REPORT_ARM_INVALID");
  const cases = new Map(dataset.cases.map((item) => [item.caseId, item]));
  if (observations.length > cases.size || new Set(observations.map((item) => item.caseId)).size !== observations.length)
    throw new Error("DIAGNOSTICS_MUTATION_REPORT_OBSERVATION_CARDINALITY_INVALID");
  for (const observation of observations) {
    const testCase = cases.get(observation.caseId);
    if (
      !testCase ||
      JSON.stringify([...testCase.adversarialTransforms]) !== JSON.stringify([...observation.transforms])
    )
      throw new Error("DIAGNOSTICS_MUTATION_REPORT_OBSERVATION_BINDING_INVALID");
  }
  const byCase = new Map<string, Map<string, VerificationBenchmarkCaseResult>>();
  for (const result of run.results) {
    if (result.repetition !== 0) throw new Error("DIAGNOSTICS_MUTATION_REPORT_REPETITION_UNSUPPORTED");
    const byArm = byCase.get(result.caseId) ?? new Map<string, VerificationBenchmarkCaseResult>();
    byArm.set(result.armId, result);
    byCase.set(result.caseId, byArm);
  }
  return byCase;
}
/** Compares actual paired run results; it never uses engineering expectations as verdicts. */
export function buildDiagnosticsMutationReport(
  input: DiagnosticsMutationReportInput,
): DiagnosticsAdversarialMutationReport {
  const byCase = assertRun(input);
  const clusters = new Map<string, VerificationBenchmarkCase[]>();
  for (const testCase of input.dataset.cases) {
    const values = clusters.get(testCase.pairCluster) ?? [];
    values.push(testCase);
    clusters.set(testCase.pairCluster, values);
  }
  const rawTransforms = new Set<string>();
  const unpairedClusters: DiagnosticsAdversarialMutationReport["unpairedClusters"][number][] = [];
  const pairs = [...clusters.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([pairCluster, values]) => {
      const original = values.filter(
        (item) => item.adversarialTransforms.length === 0 && item.tags.includes("literal"),
      );
      const mutated = values.filter((item) => item.adversarialTransforms.length > 0);
      if (values.length !== 2 || original.length !== 1 || mutated.length !== 1) {
        unpairedClusters.push(
          Object.freeze({
            pairCluster,
            caseIds: Object.freeze(values.map((item) => item.caseId).sort()),
            reason:
              original.length === 0
                ? "missing_literal_original"
                : mutated.length === 0
                  ? "missing_mutated_case"
                  : "ambiguous_pair",
          }),
        );
        return [];
      }
      for (const transform of mutated[0]!.adversarialTransforms) rawTransforms.add(transform);
      return [
        Object.freeze({
          pairCluster,
          original: caseBinding(original[0]!),
          mutated: Object.freeze({
            ...caseBinding(mutated[0]!),
            rawTransforms: Object.freeze([...mutated[0]!.adversarialTransforms]),
          }),
          arms: Object.freeze(
            input.run.arms.map((arm) => {
              const source = byCase.get(original[0]!.caseId)!.get(arm.armId)!;
              const changed = byCase.get(mutated[0]!.caseId)!.get(arm.armId)!;
              return Object.freeze({
                armId: arm.armId,
                original: compactResult(source),
                mutated: compactResult(changed),
                comparison: comparison(source, changed),
              });
            }),
          ),
        }),
      ];
    });
  const rawTransformCoverage = Object.freeze(
    [...rawTransforms]
      .sort()
      .map((rawTransform) =>
        Object.freeze({ rawTransform, families: Object.freeze([...(familyForTransform[rawTransform] ?? [])]) }),
      ),
  );
  const familyCoverage = Object.freeze(
    requiredFamilies.map((family) =>
      Object.freeze({
        family,
        rawTransforms: Object.freeze(
          rawTransformCoverage.filter((item) => item.families.includes(family)).map((item) => item.rawTransform),
        ),
        covered: rawTransformCoverage.some((item) => item.families.includes(family)),
      }),
    ),
  );
  const missingFamilies = Object.freeze(familyCoverage.filter((item) => !item.covered).map((item) => item.family));
  const citationMechanics = Object.freeze(
    input.observations
      .map((item) =>
        Object.freeze({
          caseId: item.caseId,
          corruptedLocator: item.corruptedLocator.evaluated
            ? item.corruptedLocator.valid
              ? ("accepted" as const)
              : ("rejected" as const)
            : ("unavailable" as const),
          selectedDigestTamper: item.selectedDigestTamper.valid ? ("accepted" as const) : ("rejected" as const),
          exactSource: item.exactSource.valid ? ("accepted" as const) : ("rejected" as const),
          assertionTextReplay: item.assertionTextReplay.valid ? ("accepted" as const) : ("rejected" as const),
        }),
      )
      .sort((left, right) => left.caseId.localeCompare(right.caseId)),
  );
  const missingObservationCaseIds = Object.freeze(
    input.dataset.cases
      .map((item) => item.caseId)
      .filter((caseId) => !input.observations.some((observation) => observation.caseId === caseId)),
  );
  const withoutDigest = {
    schemaVersion: "diagnostics-adversarial-mutation-report.v1" as const,
    datasetManifestDigest: input.dataset.manifestDigest as Digest,
    runManifestDigest: input.run.manifestDigest as Digest,
    experimentDefinitionDigest: input.run.experimentDefinitionDigest as Digest,
    counts: {
      cases: input.dataset.cases.length,
      pairs: pairs.length,
      arms: 4 as const,
      observations: input.observations.length,
    },
    pairs: Object.freeze(pairs),
    unpairedClusters: Object.freeze(unpairedClusters),
    missingObservationCaseIds,
    rawTransformCoverage,
    familyCoverage,
    missingFamilies,
    citationMechanics,
    limitations: Object.freeze([
      "Pair comparisons use actual offline run values only; they do not establish semantic truth or human-label correctness.",
      "Provider/network/schema failures are retained as not_measurable rather than treated as degradation.",
      "Citation mechanics are separate from source-claim semantic comparisons.",
      "Unpaired clusters and missing deterministic observations are explicit unavailable gaps.",
      "Uncovered required families remain explicit and prevent a whole-family degradation claim.",
      "The recorded baseline is lexical mechanics only; no semantic judgment is inferred.",
    ]),
  };
  return Object.freeze({ ...withoutDigest, reportDigest: digestCanonicalJson(withoutDigest) });
}
