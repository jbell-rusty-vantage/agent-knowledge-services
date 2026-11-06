import {
  VerificationBenchmarkCaseSchema,
  VerificationBenchmarkDatasetSchema,
  VerificationExtractionFieldEvidenceResultSchema,
  VerificationSourceCaptureSchema,
  VerificationSourceSchema,
  type VerificationBenchmarkCase,
  type VerificationBenchmarkDataset,
  type VerificationExtractionFieldEvidenceResult,
  type VerificationSource,
  type VerificationSourceCapture,
} from "@aiengineer/knowledge-contracts";
import {
  admitExtractionSchema,
  digestCanonicalJson,
  projectionSelectorResolver,
  resolveEvidenceSelector,
  sha256Digest,
} from "@aiengineer/knowledge-verification";
import type { VerificationAdmissionService } from "../verification/admission/verification-admission.js";

type Digest = `sha256:${string}`;
export type DiagnosticsCompanyFieldSlot =
  | "legal_identity"
  | "brand_identity"
  | "product_name"
  | "sample_type"
  | "collection_method"
  | "laboratory_claim"
  | "processing_turnaround"
  | "processing_start_event"
  | "intended_user"
  | "methylation_site_count"
  | "cpg_count"
  | "biomarker_count"
  | "organ_system_count"
  | "report_component"
  | "price"
  | "algorithm_name"
  | "institutional_collaborator"
  | "algorithm_class"
  | "algorithm_input"
  | "algorithm_output"
  | "training_population"
  | "validation_population"
  | "algorithm_interpretation"
  | "biomarker_name"
  | "system_biomarker_mapping"
  | "repeatability"
  | "reproducibility"
  | "accuracy"
  | "cohort"
  | "sample_size"
  | "performance_number"
  | "diagnostic_scope"
  | "informational_use"
  | "clinician_guidance"
  | "privacy"
  | "consent"
  | "limitation"
  | "medical_claim"
  | "preventative_claim"
  | "comparative_claim"
  | "superlative_claim"
  | "causal_claim"
  | "intervention_claim"
  | "publication_link"
  | "author_affiliation"
  | "conflict_or_funding"
  | "publication_applicability";

export interface DiagnosticsCompanyFieldDefinition {
  readonly slot: DiagnosticsCompanyFieldSlot;
  readonly section: string;
  readonly cardinality: "one" | "many";
  readonly retainedProfileKeys: readonly string[];
}
const definitions: readonly DiagnosticsCompanyFieldDefinition[] = [
  ["legal_identity", "identity", "one", []],
  ["brand_identity", "identity", "many", []],
  ["product_name", "identity", "many", []],
  ["sample_type", "product", "many", ["collection_sample_type"]],
  ["collection_method", "product", "many", []],
  ["laboratory_claim", "product", "many", []],
  ["processing_turnaround", "product", "many", ["turnaround_range"]],
  ["processing_start_event", "product", "many", ["turnaround_start_event"]],
  ["intended_user", "product", "many", []],
  ["methylation_site_count", "reported_measurement", "many", ["methylation_site_count_bound"]],
  ["cpg_count", "reported_measurement", "many", []],
  ["biomarker_count", "reported_measurement", "many", ["biomarker_count_bound", "biomarker_count"]],
  ["organ_system_count", "reported_measurement", "many", ["organ_system_count", "body_system_count"]],
  ["report_component", "reported_measurement", "many", []],
  ["price", "reported_measurement", "many", []],
  ["algorithm_name", "algorithm", "many", ["algorithm_name", "method_name"]],
  ["institutional_collaborator", "algorithm", "many", []],
  ["algorithm_class", "algorithm", "many", ["method_type"]],
  ["algorithm_input", "algorithm", "many", ["measurement_type"]],
  ["algorithm_output", "algorithm", "many", ["measurement_target"]],
  ["training_population", "algorithm", "many", []],
  ["validation_population", "algorithm", "many", ["replicate_sample_scope", "repeat_sample_scope"]],
  ["algorithm_interpretation", "algorithm", "many", ["stated_function"]],
  ["biomarker_name", "biomarker", "many", []],
  ["system_biomarker_mapping", "biomarker", "many", []],
  ["repeatability", "performance", "many", ["reported_consistency"]],
  ["reproducibility", "performance", "many", []],
  ["accuracy", "performance", "many", []],
  ["cohort", "performance", "many", ["cohort_design"]],
  ["sample_size", "performance", "many", []],
  ["performance_number", "performance", "many", ["indicator_count", "timepoint_count", "study_span"]],
  ["diagnostic_scope", "scope", "many", ["diagnosis_qualification"]],
  ["informational_use", "scope", "many", ["use_qualification"]],
  ["clinician_guidance", "scope", "many", ["clinician_prerequisite"]],
  ["privacy", "scope", "many", []],
  ["consent", "scope", "many", []],
  ["limitation", "scope", "many", ["warranty_scope"]],
  ["medical_claim", "claim", "many", []],
  ["preventative_claim", "claim", "many", []],
  ["comparative_claim", "claim", "many", ["comparison_claim"]],
  ["superlative_claim", "claim", "many", []],
  ["causal_claim", "claim", "many", []],
  ["intervention_claim", "claim", "many", []],
  ["publication_link", "publication", "many", []],
  ["author_affiliation", "publication", "many", []],
  ["conflict_or_funding", "publication", "many", []],
  ["publication_applicability", "publication", "many", []],
].map(([slot, section, cardinality, retainedProfileKeys]) =>
  Object.freeze({
    slot: slot as DiagnosticsCompanyFieldSlot,
    section: String(section),
    cardinality: cardinality as "one" | "many",
    retainedProfileKeys: Object.freeze([...(retainedProfileKeys as string[])]),
  }),
);
export const DIAGNOSTICS_COMPANY_FIELD_DEFINITIONS = Object.freeze(definitions);
const byProfileKey = new Map(
  definitions.flatMap((definition) => definition.retainedProfileKeys.map((key) => [key, definition] as const)),
);

export interface DiagnosticsCompanyVerifiedLeafInput {
  readonly caseId: string;
  /** Field key from the sealed pilot extraction field plan. */
  readonly retainedProfileKey: string;
  readonly leafPath: string;
  readonly evidenceResult: VerificationExtractionFieldEvidenceResult;
  readonly source: VerificationSource;
  readonly capture: VerificationSourceCapture;
  readonly derivedSelection: {
    readonly asStated: string;
    readonly startUtf16: number;
    readonly endUtf16: number;
    readonly selectedContentDigest: Digest;
    readonly expressionId: string;
  };
}
export interface DiagnosticsCompanyFieldLeaf {
  readonly caseId: string;
  readonly retainedProfileKey: string;
  readonly path: string;
  readonly asStated: string | number | boolean;
  readonly normalized: {
    readonly value: string | number | boolean | Readonly<{ minimum: number; maximum: number }>;
    readonly unit: string | null;
    readonly qualifier: "at_least" | null;
    readonly method: "identity" | "bounded_literal_parser.v1";
    readonly derivation: VerificationExtractionFieldEvidenceResult["acceptedLeaves"][number]["derivation"];
    readonly normalizationDerivation:
      | { readonly kind: "identity" }
      | { readonly kind: "bounded_literal_parser.v1"; readonly expressionId: string; readonly inputDigest: Digest };
  };
  readonly context: {
    readonly page: string | null;
    readonly product: string | null;
    readonly version: string | null;
    readonly capturedAt: string;
  };
  readonly conflictSetId: Digest | null;
  readonly source: VerificationExtractionFieldEvidenceResult["acceptedLeaves"][number]["source"];
  readonly lineage: VerificationExtractionFieldEvidenceResult["acceptedLeaves"][number]["lineage"];
  readonly locator: {
    readonly selector: VerificationExtractionFieldEvidenceResult["acceptedLeaves"][number]["source"]["selector"];
    readonly selectedContentDigest: Digest;
  };
}
export interface DiagnosticsCompanyFieldPlan {
  readonly schemaVersion: "diagnostics-company-field-plan.v1";
  readonly companyId: string;
  readonly planDigest: Digest;
  readonly slots: readonly {
    readonly slot: DiagnosticsCompanyFieldSlot;
    readonly section: string;
    readonly cardinality: "one" | "many";
    readonly status: "available" | "unavailable";
    readonly leaves: readonly DiagnosticsCompanyFieldLeaf[];
    readonly unavailableReason: string | null;
  }[];
}

function bounded(value: unknown, maximum: number) {
  return (
    typeof value === "string" && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(value)
  );
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function sourceContext(
  source: VerificationSource,
  capture: VerificationSourceCapture,
  selector: VerificationExtractionFieldEvidenceResult["acceptedLeaves"][number]["source"]["selector"],
) {
  return {
    page:
      (selector.kind === "pdf_text" || selector.kind === "bounding_box") && selector.page !== undefined
        ? String(selector.page)
        : source.canonicalUri,
    product: null,
    version: null,
    capturedAt: capture.capturedAt,
  };
}
function normalized(caseId: string, retainedProfileKey: string, value: string | number | boolean) {
  if (typeof value !== "string") return { value, unit: null, qualifier: null, method: "identity" as const };
  const range = /^(\d+)–(\d+) weeks$/u.exec(value);
  if (retainedProfileKey === "turnaround_range" && range)
    return {
      value: { minimum: Number(range[1]), maximum: Number(range[2]) },
      unit: "week",
      qualifier: null,
      method: "bounded_literal_parser.v1" as const,
    };
  const count = /^([\d,]+)(\+)?$/u.exec(value),
    unit =
      retainedProfileKey === "methylation_site_count_bound"
        ? "methylation_site"
        : retainedProfileKey.startsWith("biomarker_count")
          ? "biomarker"
          : retainedProfileKey === "organ_system_count"
            ? "organ_system"
            : retainedProfileKey === "body_system_count"
              ? caseId === "gl-same-page-footer-source"
                ? "organs_and_systems"
                : caseId === "gl-historical-wording-source"
                  ? "system"
                  : "body_system"
              : undefined;
  if (count && unit)
    return {
      value: Number(count[1]!.replace(/,/gu, "")),
      unit,
      qualifier: count[2] ? ("at_least" as const) : null,
      method: "bounded_literal_parser.v1" as const,
    };
  return { value, unit: null, qualifier: null, method: "identity" as const };
}
function knownConflictGroup(slot: DiagnosticsCompanyFieldSlot, caseId: string): string | undefined {
  if (
    slot === "processing_turnaround" &&
    ["tru-turnaround-about-source", "tru-turnaround-product-source"].includes(caseId)
  )
    return "tru-turnaround-page-wording";
  if (
    slot === "organ_system_count" &&
    ["gl-systems-source", "gl-historical-wording-source", "gl-same-page-footer-source"].includes(caseId)
  )
    return "gl-system-count-wording";
  return undefined;
}

/**
 * Projects already verified canonical extraction leaves into the mandatory company field matrix.
 * It never extracts a new fact: absent canonical leaves stay explicit unavailable slots.
 */
export function buildDiagnosticsCompanyFieldPlan(input: {
  readonly companyId: string;
  readonly verifiedLeaves: readonly DiagnosticsCompanyVerifiedLeafInput[];
}): DiagnosticsCompanyFieldPlan {
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(input.companyId) || input.verifiedLeaves.length > 1_000)
    throw new Error("DIAGNOSTICS_COMPANY_FIELD_SCOPE_INVALID");
  const grouped = new Map<DiagnosticsCompanyFieldSlot, DiagnosticsCompanyFieldLeaf[]>(),
    seen = new Set<string>();
  for (const candidate of input.verifiedLeaves) {
    if (
      !bounded(candidate.caseId, 255) ||
      !bounded(candidate.retainedProfileKey, 128) ||
      !bounded(candidate.leafPath, 4_096)
    )
      throw new Error("DIAGNOSTICS_COMPANY_FIELD_INPUT_INVALID");
    const definition = byProfileKey.get(candidate.retainedProfileKey);
    if (!definition) throw new Error("DIAGNOSTICS_COMPANY_FIELD_PROFILE_KEY_UNSUPPORTED");
    const result = VerificationExtractionFieldEvidenceResultSchema.parse(candidate.evidenceResult);
    if (!result.valid || !result.candidateValid) throw new Error("DIAGNOSTICS_COMPANY_FIELD_EVIDENCE_NOT_ACCEPTED");
    const leaf = result.acceptedLeaves.find((item) => item.path === candidate.leafPath);
    if (!leaf || typeof leaf.rawValue !== "string" || typeof leaf.value !== "string")
      throw new Error("DIAGNOSTICS_COMPANY_FIELD_LEAF_NOT_ACCEPTED");
    const source = VerificationSourceSchema.parse(candidate.source),
      capture = VerificationSourceCaptureSchema.parse(candidate.capture);
    if (
      capture.captureId !== leaf.source.captureId ||
      capture.sourceId !== source.sourceId ||
      capture.contentArtifact.artifactId !== leaf.lineage.sourceArtifact.artifactId ||
      capture.contentArtifact.digest !== leaf.lineage.sourceArtifact.digest
    )
      throw new Error("DIAGNOSTICS_COMPANY_FIELD_CAPTURE_BINDING_INVALID");
    const derived = candidate.derivedSelection;
    if (
      !bounded(derived.asStated, 300) ||
      !bounded(derived.expressionId, 128) ||
      !Number.isSafeInteger(derived.startUtf16) ||
      !Number.isSafeInteger(derived.endUtf16) ||
      derived.startUtf16 < 0 ||
      derived.endUtf16 <= derived.startUtf16 ||
      leaf.rawValue !== derived.asStated ||
      leaf.value !== derived.asStated ||
      sha256Digest(derived.asStated) !== derived.selectedContentDigest ||
      leaf.source.selectedContentDigest !== derived.selectedContentDigest ||
      leaf.source.selector.kind !== "html" ||
      leaf.source.selector.textRange?.start !== derived.startUtf16 ||
      leaf.source.selector.textRange.end !== derived.endUtf16
    )
      throw new Error("DIAGNOSTICS_COMPANY_FIELD_DERIVED_SELECTION_INVALID");
    const identity = `${definition.slot}\u0000${candidate.caseId}\u0000${candidate.leafPath}\u0000${derived.expressionId}`;
    if (seen.has(identity)) throw new Error("DIAGNOSTICS_COMPANY_FIELD_LEAF_DUPLICATE");
    seen.add(identity);
    const parsed = normalized(candidate.caseId, candidate.retainedProfileKey, leaf.value),
      normalizationDerivation =
        parsed.method === "identity"
          ? { kind: "identity" as const }
          : {
              kind: "bounded_literal_parser.v1" as const,
              expressionId: derived.expressionId,
              inputDigest: leaf.source.selectedContentDigest as Digest,
            };
    const item: DiagnosticsCompanyFieldLeaf = {
      caseId: candidate.caseId,
      retainedProfileKey: candidate.retainedProfileKey,
      path: leaf.path,
      asStated: leaf.rawValue,
      normalized: { ...parsed, derivation: structuredClone(leaf.derivation), normalizationDerivation },
      context: sourceContext(source, capture, leaf.source.selector),
      conflictSetId: null,
      source: structuredClone(leaf.source),
      lineage: structuredClone(leaf.lineage),
      locator: {
        selector: structuredClone(leaf.source.selector),
        selectedContentDigest: leaf.source.selectedContentDigest as Digest,
      },
    };
    const values = grouped.get(definition.slot) ?? [];
    values.push(item);
    grouped.set(definition.slot, values);
  }
  const slots = definitions.map((definition) => {
    const source = (grouped.get(definition.slot) ?? []).sort(
      (left, right) => left.caseId.localeCompare(right.caseId) || left.path.localeCompare(right.path),
    );
    const groups = new Map<string, DiagnosticsCompanyFieldLeaf[]>();
    for (const item of source) {
      const key = knownConflictGroup(definition.slot, item.caseId);
      if (key) {
        const members = groups.get(key) ?? [];
        members.push(item);
        groups.set(key, members);
      }
    }
    const conflicts = new Map<string, Digest>();
    for (const [key, members] of groups) {
      const values = [
        ...new Set(
          members.map((item) => digestCanonicalJson({ value: item.normalized.value, unit: item.normalized.unit })),
        ),
      ].sort();
      if (values.length > 1)
        conflicts.set(
          key,
          digestCanonicalJson({
            schemaVersion: "diagnostics-company-field-conflict-set.v1",
            companyId: input.companyId,
            slot: definition.slot,
            group: key,
            values,
          }),
        );
    }
    const leaves = source.map((item) =>
      freeze({ ...item, conflictSetId: conflicts.get(knownConflictGroup(definition.slot, item.caseId) ?? "") ?? null }),
    );
    return freeze({
      slot: definition.slot,
      section: definition.section,
      cardinality: definition.cardinality,
      status: (leaves.length ? "available" : "unavailable") as "available" | "unavailable",
      leaves: Object.freeze(leaves),
      unavailableReason: leaves.length ? null : "no_verified_frozen_source_leaf",
    });
  });
  const material = { schemaVersion: "diagnostics-company-field-plan.v1" as const, companyId: input.companyId, slots };
  return freeze({ ...material, planDigest: digestCanonicalJson(material) });
}

type ExtractionPattern = { readonly retainedProfileKey: string; readonly expression: RegExp; readonly group: number };
const frozenPatterns: Readonly<Record<string, readonly ExtractionPattern[]>> = Object.freeze({
  "tru-turnaround-about-source": [
    { retainedProfileKey: "turnaround_range", expression: /within (2–4 weeks) from/u, group: 1 },
    {
      retainedProfileKey: "turnaround_start_event",
      expression: /from (the date the lab receives the sample)/u,
      group: 1,
    },
  ],
  "tru-turnaround-product-source": [
    { retainedProfileKey: "turnaround_range", expression: /within (3–4 weeks) after/u, group: 1 },
    { retainedProfileKey: "turnaround_start_event", expression: /after (our lab receives your sample)/u, group: 1 },
  ],
  "tru-sample-source": [
    { retainedProfileKey: "collection_sample_type", expression: /(finger-stick blood)/u, group: 1 },
  ],
  "tru-sites-source": [
    {
      retainedProfileKey: "methylation_site_count_bound",
      expression: /analyzing (1,000,000\+) DNA methylation sites/u,
      group: 1,
    },
  ],
  "tru-biomarkers-source": [
    { retainedProfileKey: "biomarker_count_bound", expression: /(75\+) biomarkers/u, group: 1 },
  ],
  "tru-symphony-source": [
    { retainedProfileKey: "algorithm_name", expression: /The (SymphonyAge™) algorithm/u, group: 1 },
    { retainedProfileKey: "organ_system_count", expression: /age of (11) organ systems/u, group: 1 },
  ],
  "tru-omic-source": [
    { retainedProfileKey: "algorithm_name", expression: /The (OMICmAge™) algorithm/u, group: 1 },
    {
      retainedProfileKey: "method_type",
      expression: /algorithm is a (multi-omic–informed methylation clock)/u,
      group: 1,
    },
    {
      retainedProfileKey: "measurement_target",
      expression: /quantifies (biological age against chronological age)/u,
      group: 1,
    },
  ],
  "tru-pace-source": [
    { retainedProfileKey: "algorithm_name", expression: /The (DunedinPACE™) algorithm/u, group: 1 },
    {
      retainedProfileKey: "stated_function",
      expression: /can (track how fast the body is aging and the impact of lifestyle changes)/u,
      group: 1,
    },
  ],
  "gl-systems-source": [
    { retainedProfileKey: "biomarker_count", expression: /analyzes (460) epigenetic biomarkers/u, group: 1 },
    { retainedProfileKey: "body_system_count", expression: /across (21) body systems/u, group: 1 },
  ],
  "gl-historical-wording-source": [
    { retainedProfileKey: "body_system_count", expression: /these (19) critical systems/u, group: 1 },
  ],
  "gl-same-page-footer-source": [
    { retainedProfileKey: "biomarker_count", expression: /(460) biomarkers/u, group: 1 },
    { retainedProfileKey: "body_system_count", expression: /(21) organs and systems/u, group: 1 },
  ],
});

/**
 * Executes the bounded frozen-source field plan through the admitted projection and canonical
 * extraction-evidence service. Patterns only identify literal leaves already requested by the
 * retained pilot profile; every value and locator is then verified against registered bytes.
 */
export async function executeDiagnosticsCompanyFieldPlan(input: {
  readonly tenantId: string;
  readonly companyId: "tru-diagnostic" | "generation-lab";
  readonly dataset: VerificationBenchmarkDataset;
  readonly captures: readonly { readonly source: VerificationSource; readonly capture: VerificationSourceCapture }[];
  readonly admission: VerificationAdmissionService;
}) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(input.tenantId) ||
    input.captures.length > 40
  )
    throw new Error("DIAGNOSTICS_COMPANY_FIELD_EXECUTION_SCOPE_INVALID");
  const captureIds = new Set<string>(),
    dataset = VerificationBenchmarkDatasetSchema.parse(input.dataset),
    captureMap = new Map(
      input.captures.map((value) => {
        const source = VerificationSourceSchema.parse(value.source),
          capture = VerificationSourceCaptureSchema.parse(value.capture);
        if (capture.sourceId !== source.sourceId || captureIds.has(capture.captureId))
          throw new Error("DIAGNOSTICS_COMPANY_FIELD_CAPTURE_SET_INVALID");
        captureIds.add(capture.captureId);
        return [capture.captureId, { source, capture }] as const;
      }),
    ),
    prefix = input.companyId === "tru-diagnostic" ? "tru-" : "gl-";
  const seen = new Set<string>(),
    verifiedLeaves: DiagnosticsCompanyVerifiedLeafInput[] = [],
    boundArtifacts = new Map<string, unknown>();
  for (const rawCase of dataset.cases) {
    const testCase = VerificationBenchmarkCaseSchema.parse(rawCase),
      patterns = testCase.caseId.startsWith(prefix) ? frozenPatterns[testCase.caseId] : undefined;
    if (!patterns) continue;
    const binding = captureMap.get(testCase.evidence[0]?.captureId ?? "");
    if (!binding) throw new Error("DIAGNOSTICS_COMPANY_FIELD_CAPTURE_REQUIRED");
    const { source, capture } = binding;
    if (seen.has(testCase.caseId)) throw new Error("DIAGNOSTICS_COMPANY_FIELD_CASE_DUPLICATE");
    seen.add(testCase.caseId);
    if (!patterns) continue;
    if (
      testCase.adversarialTransforms.length !== 0 ||
      !testCase.caseId.endsWith("-source") ||
      testCase.evidence.length !== 1
    )
      throw new Error("DIAGNOSTICS_COMPANY_FIELD_SOURCE_CASE_INVALID");
    const edge = testCase.evidence[0]!;
    if (
      capture.captureId !== edge.captureId ||
      capture.sourceId !== source.sourceId ||
      capture.contentArtifact.tenantId !== input.tenantId
    )
      throw new Error("DIAGNOSTICS_COMPANY_FIELD_CASE_CAPTURE_MISMATCH");
    const hydrated = await input.admission.hydrateAdmittedProjection({
      tenantId: input.tenantId,
      captureId: capture.captureId,
      expectedSourceArtifact: {
        artifactId: capture.contentArtifact.artifactId,
        digest: capture.contentArtifact.digest as Digest,
      },
      transformationArtifactId: edge.transformationArtifactId,
      projectionArtifactId: edge.projectionArtifactId,
    });
    if (hydrated.receipt.projectionArtifact.digest !== edge.projectionDigest)
      throw new Error("DIAGNOSTICS_COMPANY_FIELD_PROJECTION_MISMATCH");
    const selected = resolveEvidenceSelector(
      {
        captureId: capture.captureId,
        representationArtifactId: hydrated.receipt.projectionArtifact.artifactId,
        representationDigest: hydrated.receipt.projectionArtifact.digest as Digest,
        selector: edge.selector,
        content: hydrated.content,
      },
      [projectionSelectorResolver],
    );
    if (
      !selected?.selectedText ||
      selected.resolution.status !== "resolved" ||
      selected.resolution.selectedContentDigest !== edge.selectedContentDigest ||
      sha256Digest(selected.selectedContent) !== edge.selectedContentDigest
    )
      throw new Error("DIAGNOSTICS_COMPANY_FIELD_SOURCE_SELECTION_MISMATCH");
    for (const pattern of patterns) {
      const match = pattern.expression.exec(selected.selectedText),
        asStated = match?.[pattern.group];
      if (!asStated)
        throw new Error(`DIAGNOSTICS_COMPANY_FIELD_PATTERN_DRIFT:${testCase.caseId}:${pattern.retainedProfileKey}`);
      const start = selected.selectedText.indexOf(asStated),
        expressionId = `${testCase.caseId}.${pattern.retainedProfileKey}.v1`;
      if (
        start < 0 ||
        selected.selectedText.indexOf(asStated, start + 1) >= 0 ||
        edge.selector.kind !== "html" ||
        edge.selector.textRange !== undefined
      )
        throw new Error("DIAGNOSTICS_COMPANY_FIELD_DERIVED_SELECTION_AMBIGUOUS");
      const selector = { ...edge.selector, textRange: { start, end: start + asStated.length } };
      const schema = admitExtractionSchema({
        schemaId: `diagnostics-company-field`,
        schemaVersion: "1",
        schema: {
          type: "object",
          description: "One exact company field selected from admitted frozen source evidence.",
          additionalProperties: false,
          required: ["value"],
          properties: {
            value: { type: "string", description: "Exact selector-bound field value.", minLength: 1, maxLength: 300 },
          },
        },
      });
      if (!schema.admitted || !schema.schema) throw new Error("DIAGNOSTICS_COMPANY_FIELD_SCHEMA_INVALID");
      const verified = await input.admission.verifyExtractionWithEvidence({
        tenantId: input.tenantId,
        expectedSourceArtifact: {
          artifactId: capture.contentArtifact.artifactId,
          digest: capture.contentArtifact.digest as Digest,
        },
        schema: schema.schema,
        candidate: { value: asStated },
        fields: [{ path: "/value", comparison: "exact" }],
        evidence: [
          {
            path: "/value",
            captureId: capture.captureId,
            projectionArtifactId: edge.projectionArtifactId,
            transformationArtifactId: edge.transformationArtifactId,
            selector,
            expectedSelectedContentDigest: sha256Digest(asStated),
          },
        ],
      });
      if (!verified.result.valid || verified.result.acceptedLeaves.length !== 1)
        throw new Error(
          `DIAGNOSTICS_COMPANY_FIELD_MECHANICS_FAILED:${testCase.caseId}:${pattern.retainedProfileKey}:${verified.result.checks
            .filter((check) => check.status === "failed")
            .map((check) => check.code)
            .join(",")}`,
        );
      for (const artifact of verified.boundArtifacts) boundArtifacts.set(artifact.artifactId, artifact);
      verifiedLeaves.push({
        caseId: testCase.caseId,
        retainedProfileKey: pattern.retainedProfileKey,
        leafPath: "/value",
        evidenceResult: verified.result,
        source,
        capture,
        derivedSelection: {
          asStated,
          startUtf16: start,
          endUtf16: start + asStated.length,
          selectedContentDigest: sha256Digest(asStated),
          expressionId,
        },
      });
    }
  }
  const plan = buildDiagnosticsCompanyFieldPlan({ companyId: input.companyId, verifiedLeaves });
  return freeze({
    plan,
    boundArtifacts: Object.freeze([...boundArtifacts.values()]),
    executedCaseIds: Object.freeze([...seen].filter((caseId) => frozenPatterns[caseId])),
  });
}
