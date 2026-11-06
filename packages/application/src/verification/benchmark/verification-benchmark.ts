import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  DiagnosticsBenchmarkExtractionExperimentManifest,
  DiagnosticsBenchmarkExtractionOutput,
  DiagnosticsBenchmarkProviderObservation,
  SemanticJudgeOutput,
  VerificationArtifactHandle,
  VerificationBenchmarkArm,
  VerificationBenchmarkCase,
  VerificationBenchmarkCaseResult,
  VerificationBenchmarkDataset,
} from "@aiengineer/knowledge-contracts";
import {
  DiagnosticsBenchmarkExtractionExperimentManifestSchema,
  DiagnosticsBenchmarkExtractionOutputSchema,
  DiagnosticsBenchmarkProviderObservationSchema,
  DiagnosticsBenchmarkSupportOutputSchema,
  SemanticJudgeOutputSchema,
  VerificationBenchmarkDatasetSchema,
} from "@aiengineer/knowledge-contracts";
import { deepFreeze } from "@aiengineer/knowledge-core";
import {
  assertFrozenVerificationBenchmarkDataset,
  verificationBenchmarkDigest,
  type VerificationBenchmarkCheckpointStore,
} from "@aiengineer/knowledge-evaluation";
import {
  admitExtractionSchema,
  gatewaySemanticPromptDigest,
  gatewaySemanticOutputSchemaDigest,
  providerDigest,
  sha256Digest,
  verifyExtractionFields,
} from "@aiengineer/knowledge-verification";
import {
  type Digest,
  bytesDigest,
  encode,
  extractionSystemPrompt,
  plainObject,
  exactKeys,
  withoutKey,
  numbers,
} from "./verification-benchmark-shared.js";

export const DIAGNOSTICS_EXTRACTION_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  description: "Evidence-only support decision with candidate-produced structured leaf values.",
  additionalProperties: false,
  required: ["support", "qualifiers_preserved", "fields", "unsupported_facets", "public_rationale"],
  properties: {
    support: {
      type: "string",
      description: "Relation of the assertion to the supplied fragment.",
      enum: ["full", "partial", "none", "contradicted"],
      maxLength: 32,
    },
    qualifiers_preserved: {
      type: "boolean",
      description: "Whether all material qualifiers in the fragment were preserved.",
    },
    fields: {
      type: "array",
      description: "Requested structured fields extracted from the supplied fragment.",
      minItems: 1,
      maxItems: 4,
      items: {
        type: "object",
        description: "One requested candidate field and its exact source quote.",
        additionalProperties: false,
        required: ["fieldKey", "status", "value", "evidenceQuote", "publicRationale"],
        properties: {
          fieldKey: { type: "string", description: "Requested field key exactly as supplied.", maxLength: 128 },
          status: {
            type: "string",
            description: "Whether one unambiguous value was found.",
            enum: ["extracted", "missing", "ambiguous"],
            maxLength: 32,
          },
          value: {
            type: "string",
            description: "Candidate-produced leaf value; empty unless extracted.",
            maxLength: 300,
          },
          evidenceQuote: {
            type: "string",
            description: "Small exact fragment substring supporting the value; empty unless extracted.",
            maxLength: 600,
          },
          publicRationale: {
            type: "string",
            description: "Short public explanation for this field without hidden reasoning.",
            minLength: 1,
            maxLength: 300,
          },
        },
      },
    },
    unsupported_facets: {
      type: "array",
      description: "Assertion facets absent from or inconsistent with the supplied fragment.",
      maxItems: 12,
      items: { type: "string", description: "One bounded unsupported facet.", maxLength: 160 },
    },
    public_rationale: {
      type: "string",
      description: "Short evidence-only rationale without hidden reasoning.",
      minLength: 1,
      maxLength: 600,
    },
  },
});
export const DIAGNOSTICS_EXTRACTION_OUTPUT_SCHEMA_DIGEST = providerDigest(DIAGNOSTICS_EXTRACTION_OUTPUT_SCHEMA);
export class FileVerificationBenchmarkCheckpointStore implements VerificationBenchmarkCheckpointStore {
  constructor(private readonly directory: string) {}
  #path(key: string) {
    return resolve(this.directory, `${key.slice(7)}.json`);
  }
  async load(key: string): Promise<VerificationBenchmarkCaseResult | undefined> {
    try {
      return JSON.parse(await readFile(this.#path(key), "utf8")) as VerificationBenchmarkCaseResult;
    } catch (error: any) {
      if (error?.code === "ENOENT") return undefined;
      throw error;
    }
  }
  async save(key: string, result: VerificationBenchmarkCaseResult): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    await writeFile(this.#path(key), encode(result), { flag: "wx" });
  }
}

export const diagnosticsBenchmarkArms = (): readonly VerificationBenchmarkArm[] => {
  const definition = (
    armId: string,
    name: string,
    control: boolean,
    strategy: VerificationBenchmarkArm["strategy"],
    extractorProfile: string,
    judgeProfile: string,
  ): VerificationBenchmarkArm => ({
    armId,
    name,
    control,
    strategy,
    extractorProfile,
    parserProfile: "frozen-native-v2",
    retrieverProfile: "capture-bound-single-fragment",
    judgeProfile,
    policyVersion: "diagnostics-policy.v1",
    configurationDigest: verificationBenchmarkDigest({ armId, strategy, extractorProfile, judgeProfile }),
    cachePolicy: strategy === "baseline" ? "disabled" : "exact_request_only",
    replicas: 1,
  });
  return [
    definition(
      "baseline",
      "Luna extraction plus deterministic mechanics",
      true,
      "baseline",
      "openai/gpt-5.6-luna",
      "bounded-rules.v1",
    ),
    definition(
      "interfaze",
      "Interfaze extraction plus deterministic mechanics",
      false,
      "interfaze",
      "interfaze-beta",
      "bounded-rules.v1",
    ),
    definition(
      "cascade",
      "Interfaze extraction plus Haiku judge",
      false,
      "cascade",
      "interfaze-beta",
      "anthropic/claude-haiku-4.5-evidence-only",
    ),
    definition(
      "consensus-abstention",
      "Luna and Interfaze consensus with Haiku adjudication and abstention",
      false,
      "consensus_abstention",
      "openai/gpt-5.6-luna+interfaze-beta",
      "anthropic/claude-haiku-4.5-evidence-only",
    ),
  ];
};

export const DIAGNOSTICS_PILOT_V4_SEAL = Object.freeze({
  datasetManifestDigest: "sha256:a6bc1cf3ecbb335e4f5ef49165798d29ce937a9324f2a1ba7d9768f23ad7feee" as Digest,
  grantDigest: "sha256:a9e48e1d29049312a0895ffb1c5b30149e40404143918b7e5572ae8bfb7665e5" as Digest,
  catalogManifestDigest: "sha256:f86c5a28f352d9714945cd2fc14f536a0ca25491e0ca5264267d135b71cd5a92" as Digest,
  experimentManifestDigest: "sha256:c7d1588f870bbae4f1b5dd1ae590ad547ea85bfc6ca48f798c6f6b40700707c4" as Digest,
});
export interface DiagnosticsExtractionAuthority {
  readonly datasetManifestDigest: Digest;
  readonly grantDigest: Digest;
  readonly catalogManifestDigest: Digest;
  readonly experimentManifestDigest: Digest;
  readonly authorizedCaseCount: number;
}
interface DiagnosticsExtractionAuthorityRecord {
  readonly cases: ReadonlyMap<string, Digest>;
  readonly plans: ReadonlyMap<string, DiagnosticsBenchmarkExtractionExperimentManifest["casePlan"][number]>;
}
const extractionAuthorities = new WeakMap<object, DiagnosticsExtractionAuthorityRecord>();

export async function loadDiagnosticsExtractionExperiment(catalogDirectory: string): Promise<{
  readonly dataset: VerificationBenchmarkDataset;
  readonly experiment: DiagnosticsBenchmarkExtractionExperimentManifest;
  readonly authority: DiagnosticsExtractionAuthority;
}> {
  const catalogBytes = await readFile(resolve(catalogDirectory, "manifest.json"));
  const catalog = plainObject(JSON.parse(catalogBytes.toString("utf8")), "BENCHMARK_EXTRACTION_CATALOG_INVALID");
  if (
    catalog.manifestDigest !== DIAGNOSTICS_PILOT_V4_SEAL.catalogManifestDigest ||
    catalog.manifestDigest !== verificationBenchmarkDigest(withoutKey(catalog, "manifestDigest"))
  )
    throw new Error("BENCHMARK_EXTRACTION_CATALOG_SEAL_MISMATCH");
  if (!Array.isArray(catalog.files)) throw new Error("BENCHMARK_EXTRACTION_CATALOG_INVALID");
  const names = new Set([
    "dataset.json",
    "derived-input-grant.json",
    "case-artifact-registry.json",
    "experiments/extraction-v1/manifest.json",
    "experiments/extraction-v1/output-schema.json",
    ...catalog.files.map((raw) => String(plainObject(raw, "BENCHMARK_EXTRACTION_CATALOG_FILE_INVALID").name)),
  ]);
  const files = new Map<string, Uint8Array>([["manifest.json", catalogBytes]]);
  for (const name of names) files.set(name, await readFile(resolve(catalogDirectory, name)));
  return admitDiagnosticsExtractionExperimentFiles(files);
}

/** Validates the existing sealed V4 profile from bytes; this grants no network access. */
export function admitDiagnosticsExtractionExperimentFiles(files: ReadonlyMap<string, Uint8Array>): {
  readonly dataset: VerificationBenchmarkDataset;
  readonly experiment: DiagnosticsBenchmarkExtractionExperimentManifest;
  readonly authority: DiagnosticsExtractionAuthority;
} {
  const read = (name: string): Buffer => {
    const bytes = files.get(name);
    if (!bytes || bytes.byteLength > 8 * 1024 * 1024) throw new Error("BENCHMARK_EXTRACTION_PROFILE_FILE_REQUIRED");
    return Buffer.from(bytes);
  };
  const [datasetBytes, grantBytes, catalogBytes, registryBytes, experimentBytes, schemaBytes] = [
    "dataset.json",
    "derived-input-grant.json",
    "manifest.json",
    "case-artifact-registry.json",
    "experiments/extraction-v1/manifest.json",
    "experiments/extraction-v1/output-schema.json",
  ].map(read) as [Buffer, Buffer, Buffer, Buffer, Buffer, Buffer];
  const dataset = VerificationBenchmarkDatasetSchema.parse(
    JSON.parse(datasetBytes.toString("utf8")),
  ) as VerificationBenchmarkDataset;
  assertFrozenVerificationBenchmarkDataset(dataset);
  const grant = plainObject(JSON.parse(grantBytes.toString("utf8")), "BENCHMARK_EXTRACTION_GRANT_INVALID"),
    catalog = plainObject(JSON.parse(catalogBytes.toString("utf8")), "BENCHMARK_EXTRACTION_CATALOG_INVALID"),
    registry = plainObject(JSON.parse(registryBytes.toString("utf8")), "BENCHMARK_EXTRACTION_REGISTRY_INVALID");
  if (
    dataset.manifestDigest !== DIAGNOSTICS_PILOT_V4_SEAL.datasetManifestDigest ||
    grant.grantDigest !== DIAGNOSTICS_PILOT_V4_SEAL.grantDigest ||
    catalog.manifestDigest !== DIAGNOSTICS_PILOT_V4_SEAL.catalogManifestDigest
  )
    throw new Error("BENCHMARK_EXTRACTION_CATALOG_SEAL_MISMATCH");
  if (
    catalog.manifestDigest !== verificationBenchmarkDigest(withoutKey(catalog, "manifestDigest")) ||
    catalog.datasetManifestDigest !== dataset.manifestDigest ||
    catalog.caseArtifactRegistryDigest !== verificationBenchmarkDigest(registry) ||
    registry.datasetManifestDigest !== dataset.manifestDigest ||
    !Array.isArray(registry.artifacts) ||
    registry.artifacts.length !== 86 ||
    !Array.isArray(catalog.files)
  )
    throw new Error("BENCHMARK_EXTRACTION_CATALOG_INVALID");
  for (const raw of catalog.files) {
    const item = plainObject(raw, "BENCHMARK_EXTRACTION_CATALOG_FILE_INVALID");
    exactKeys(item, ["name", "digest", "bytes"], "BENCHMARK_EXTRACTION_CATALOG_FILE_UNKNOWN_FIELD");
    const bytes = read(String(item.name));
    if (bytesDigest(bytes) !== item.digest || bytes.byteLength !== item.bytes)
      throw new Error(`BENCHMARK_EXTRACTION_CATALOG_FILE_MISMATCH:${item.name}`);
  }
  if (
    grant.schemaVersion !== "verification-benchmark-derived-input-grant.v2" ||
    grant.datasetManifestDigest !== dataset.manifestDigest ||
    grant.grantDigest !== verificationBenchmarkDigest(withoutKey(grant, "grantDigest")) ||
    !Array.isArray(grant.authorizedDerivedInputs) ||
    grant.authorizedDerivedInputs.length !== 40
  )
    throw new Error("BENCHMARK_EXTRACTION_GRANT_BINDING_INVALID");
  const constraints = plainObject(grant.constraints, "BENCHMARK_EXTRACTION_GRANT_CONSTRAINTS_INVALID");
  if (
    constraints.textOnly !== true ||
    constraints.oneAssertionPerCase !== true ||
    constraints.oneExactFragmentPerCase !== true ||
    constraints.maximumCombinedCaseUtf16Characters !== 2_000 ||
    constraints.maximumSerializedRequestUtf8Bytes !== 10_000 ||
    constraints.maximumOutputTokens !== 900 ||
    constraints.fullPageOrPdfUpload !== false ||
    constraints.tools !== false ||
    constraints.search !== false ||
    constraints.redirects !== false ||
    constraints.concurrency !== 1 ||
    constraints.automaticQualityRetries !== 0
  )
    throw new Error("BENCHMARK_EXTRACTION_GRANT_CONSTRAINTS_MISMATCH");
  const authorized = new Map<string, Digest>();
  for (const raw of grant.authorizedDerivedInputs) {
    const item = plainObject(raw, "BENCHMARK_EXTRACTION_GRANT_CASE_INVALID"),
      testCase = dataset.cases.find((candidate) => candidate.caseId === item.caseId),
      registeredInput = registry.artifacts.find(
        (candidate: any) => candidate.caseId === item.caseId && candidate.role === "case_input",
      )?.handle;
    if (
      !testCase ||
      item.caseDigest !== testCase.caseDigest ||
      item.inputManifestArtifactId !== testCase.inputManifestArtifactId ||
      item.inputManifestArtifactId !== registeredInput?.artifactId ||
      item.inputManifestDigest !== registeredInput?.digest ||
      item.assertionDigest !== bytesDigest(testCase.assertion) ||
      item.selectedContentDigest !== testCase.evidence[0]?.selectedContentDigest ||
      item.providerVisibleContentDigest !==
        verificationBenchmarkDigest({
          assertion: testCase.assertion,
          fragment: testCase.evidence[0]?.excerpt,
          sourceClass: testCase.evidence[0]?.sourceClass,
          qualifierMetadata: item.qualifierMetadata,
        }) ||
      item.authorized !== true
    )
      throw new Error(`BENCHMARK_EXTRACTION_GRANT_CASE_BINDING_INVALID:${item.caseId}`);
    authorized.set(String(item.caseId), testCase.caseDigest as Digest);
  }
  const experiment = DiagnosticsBenchmarkExtractionExperimentManifestSchema.parse(
    JSON.parse(experimentBytes.toString("utf8")),
  );
  if (
    experiment.manifestDigest !== DIAGNOSTICS_PILOT_V4_SEAL.experimentManifestDigest ||
    experiment.manifestDigest !==
      verificationBenchmarkDigest(withoutKey(experiment as unknown as Record<string, unknown>, "manifestDigest")) ||
    experiment.datasetManifestDigest !== dataset.manifestDigest ||
    experiment.grantDigest !== grant.grantDigest ||
    experiment.outputSchemaDigest !== DIAGNOSTICS_EXTRACTION_OUTPUT_SCHEMA_DIGEST ||
    providerDigest(JSON.parse(schemaBytes.toString("utf8"))) !== DIAGNOSTICS_EXTRACTION_OUTPUT_SCHEMA_DIGEST
  )
    throw new Error("BENCHMARK_EXTRACTION_EXPERIMENT_SEAL_MISMATCH");
  // The parsed experiment is returned to callers for inspection, so its case plans
  // cannot also be the private authorization material. Keep an independent frozen
  // snapshot behind the WeakMap capability boundary.
  const plans = new Map(experiment.casePlan.map((item) => [item.caseId, deepFreeze(structuredClone(item))]));
  if (
    plans.size !== dataset.cases.length ||
    experiment.casePlan.some(
      (item) =>
        item.caseDigest !== dataset.cases.find((candidate) => candidate.caseId === item.caseId)?.caseDigest ||
        (item.execution === "fresh_dispatch") !==
          (authorized.has(item.caseId) && item.caseId !== "tru-turnaround-product-mutated"),
    )
  )
    throw new Error("BENCHMARK_EXTRACTION_CASE_PLAN_BINDING_INVALID");
  const authority = Object.freeze({
    datasetManifestDigest: dataset.manifestDigest as Digest,
    grantDigest: grant.grantDigest as Digest,
    catalogManifestDigest: catalog.manifestDigest as Digest,
    experimentManifestDigest: experiment.manifestDigest as Digest,
    authorizedCaseCount: experiment.casePlan.filter((item) => item.execution === "fresh_dispatch").length,
  });
  extractionAuthorities.set(authority, { cases: authorized, plans });
  return { dataset, experiment, authority };
}

export function createDiagnosticsExtractionProviderInput(
  testCase: VerificationBenchmarkCase,
  authority: DiagnosticsExtractionAuthority,
) {
  const trusted = authority && typeof authority === "object" ? extractionAuthorities.get(authority) : undefined,
    recomputed = verificationBenchmarkDigest(withoutKey(testCase as unknown as Record<string, unknown>, "caseDigest")),
    plan = trusted?.plans.get(testCase.caseId);
  if (
    !trusted ||
    authority.datasetManifestDigest !== DIAGNOSTICS_PILOT_V4_SEAL.datasetManifestDigest ||
    trusted.cases.get(testCase.caseId) !== testCase.caseDigest ||
    recomputed !== testCase.caseDigest ||
    plan?.execution !== "fresh_dispatch" ||
    testCase.evidence.length !== 1
  )
    throw new Error("BENCHMARK_EXTRACTION_CASE_NOT_AUTHORIZED");
  const evidence = testCase.evidence[0]!,
    input = {
      assertion: testCase.assertion,
      fragment: evidence.excerpt,
      sourceClass: evidence.sourceClass,
      qualifierMetadata: [] as readonly string[],
      requestedFields: plan.fields.map((item) => ({ fieldKey: item.fieldKey, description: item.description })),
    };
  if (input.assertion.length + input.fragment.length > 2_000) throw new Error("BENCHMARK_EXTRACTION_CASE_UTF16_LIMIT");
  return input;
}
export const createDiagnosticsExtractionPrompt = (
  testCase: VerificationBenchmarkCase,
  authority: DiagnosticsExtractionAuthority,
) =>
  `Extract each requested field from the fragment and separately evaluate assertion support. For every extracted field, value must be the smallest factual leaf and evidenceQuote must be a small exact substring of the fragment containing that value. Use empty value and evidenceQuote for missing or ambiguous fields. Preserve numbers, plus/bound markers, start events, populations, negations, and scope.\n${JSON.stringify(createDiagnosticsExtractionProviderInput(testCase, authority))}`;
export function createDiagnosticsExtractionJudgeInput(
  testCase: VerificationBenchmarkCase,
  authority: DiagnosticsExtractionAuthority,
) {
  const content = createDiagnosticsExtractionProviderInput(testCase, authority);
  return {
    rubricVersion: "evidence-only.v1" as const,
    assertionId: verificationBenchmarkDigest({
      purpose: "provider-visible-v4-assertion",
      datasetManifestDigest: authority.datasetManifestDigest,
      caseDigest: testCase.caseDigest,
    }),
    proposition: content.assertion,
    qualifiers: [],
    entityBindings: [],
    fragments: [
      {
        fragmentId: verificationBenchmarkDigest({
          purpose: "provider-visible-v4-fragment",
          datasetManifestDigest: authority.datasetManifestDigest,
          selectedContentDigest: testCase.evidence[0]!.selectedContentDigest,
        }),
        exactText: content.fragment,
      },
    ],
  };
}
export function assertDiagnosticsExtractionWireRequest(
  testCase: VerificationBenchmarkCase,
  authority: DiagnosticsExtractionAuthority,
  requestBytes: Uint8Array,
  policy: {
    readonly provider: "gateway" | "interfaze";
    readonly model: "openai/gpt-5.6-luna" | "anthropic/claude-haiku-4.5" | "interfaze-beta";
  },
): void {
  createDiagnosticsExtractionProviderInput(testCase, authority);
  if (!requestBytes.byteLength || requestBytes.byteLength > 10_000)
    throw new Error("BENCHMARK_EXTRACTION_WIRE_UTF8_LIMIT");
  let body: Record<string, unknown>;
  try {
    body = plainObject(
      JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(requestBytes)),
      "BENCHMARK_EXTRACTION_WIRE_INVALID",
    );
  } catch {
    throw new Error("BENCHMARK_EXTRACTION_WIRE_INVALID");
  }
  const tokenKey = policy.provider === "interfaze" ? "max_tokens" : "max_completion_tokens",
    expectedKeys = ["model", "temperature", tokenKey, "messages", "response_format"];
  exactKeys(body, expectedKeys, "BENCHMARK_EXTRACTION_WIRE_UNKNOWN_FIELD");
  if (body.model !== policy.model || body.temperature !== 0 || body[tokenKey] !== 900 || !Array.isArray(body.messages))
    throw new Error("BENCHMARK_EXTRACTION_WIRE_POLICY_MISMATCH");
  const messages = body.messages.map((item) => plainObject(item, "BENCHMARK_EXTRACTION_WIRE_MESSAGES_INVALID")),
    semantic = policy.model === "anthropic/claude-haiku-4.5",
    expectedContent = semantic
      ? JSON.stringify(createDiagnosticsExtractionJudgeInput(testCase, authority))
      : createDiagnosticsExtractionPrompt(testCase, authority);
  if (
    messages.filter((item) => item.role === "user").length !== 1 ||
    messages.find((item) => item.role === "user")?.content !== expectedContent
  )
    throw new Error("BENCHMARK_EXTRACTION_WIRE_CONTENT_MISMATCH");
  for (const message of messages) {
    exactKeys(message, ["role", "content"], "BENCHMARK_EXTRACTION_WIRE_MESSAGE_UNKNOWN_FIELD");
    if (!(["system", "user"] as unknown[]).includes(message.role) || typeof message.content !== "string")
      throw new Error("BENCHMARK_EXTRACTION_WIRE_MESSAGES_INVALID");
  }
  if (
    policy.provider === "interfaze"
      ? messages.length !== 1
      : messages.length !== 2 ||
        messages[0]!.role !== "system" ||
        (policy.provider === "gateway" &&
          (semantic
            ? providerDigest(messages[0]!.content) !== gatewaySemanticPromptDigest
            : messages[0]!.content !== extractionSystemPrompt))
  )
    throw new Error("BENCHMARK_EXTRACTION_WIRE_SYSTEM_PROFILE_MISMATCH");
  const format = plainObject(body.response_format, "BENCHMARK_EXTRACTION_WIRE_FORMAT_INVALID");
  exactKeys(format, ["type", "json_schema"], "BENCHMARK_EXTRACTION_WIRE_FORMAT_UNKNOWN_FIELD");
  const descriptor = plainObject(format.json_schema, "BENCHMARK_EXTRACTION_WIRE_SCHEMA_INVALID");
  exactKeys(descriptor, ["name", "strict", "schema"], "BENCHMARK_EXTRACTION_WIRE_SCHEMA_UNKNOWN_FIELD");
  if (
    format.type !== "json_schema" ||
    descriptor.strict !== true ||
    descriptor.name !== (semantic ? "verification_semantic_judge" : "benchmark_extraction") ||
    providerDigest(descriptor.schema) !==
      (semantic ? gatewaySemanticOutputSchemaDigest : DIAGNOSTICS_EXTRACTION_OUTPUT_SCHEMA_DIGEST)
  )
    throw new Error("BENCHMARK_EXTRACTION_WIRE_SCHEMA_MISMATCH");
}

/** Replays provider-produced leaf values against exact quotes in a registered granted-fragment artifact. */
export function verifyDiagnosticsExtractionOutput(input: {
  readonly testCase: VerificationBenchmarkCase;
  readonly authority: DiagnosticsExtractionAuthority;
  readonly output: DiagnosticsBenchmarkExtractionOutput;
  readonly fragmentArtifact: VerificationArtifactHandle;
  readonly fragmentBytes: Uint8Array;
}) {
  const trusted = extractionAuthorities.get(input.authority),
    plan = trusted?.plans.get(input.testCase.caseId);
  createDiagnosticsExtractionProviderInput(input.testCase, input.authority);
  const output = DiagnosticsBenchmarkExtractionOutputSchema.parse(input.output);
  if (
    !plan ||
    input.fragmentArtifact.digest !== sha256Digest(input.fragmentBytes) ||
    input.fragmentArtifact.byteLength !== input.fragmentBytes.byteLength ||
    new TextDecoder("utf8", { fatal: true }).decode(input.fragmentBytes) !== input.testCase.evidence[0]!.excerpt
  )
    throw new Error("BENCHMARK_EXTRACTION_FRAGMENT_ARTIFACT_INVALID");
  const expectedKeys = plan.fields.map((item) => item.fieldKey),
    actualKeys = output.fields.map((item) => item.fieldKey);
  if (
    new Set(actualKeys).size !== actualKeys.length ||
    actualKeys.length !== expectedKeys.length ||
    expectedKeys.some((key) => !actualKeys.includes(key))
  )
    throw new Error("BENCHMARK_EXTRACTION_FIELD_MATRIX_INVALID");
  const fieldResults = plan.fields.map((fieldPlan) => {
    const field = output.fields.find((item) => item.fieldKey === fieldPlan.fieldKey)!;
    if (field.status !== "extracted")
      return {
        fieldKey: field.fieldKey,
        status: field.status,
        mechanicsValid: false,
        comparison: fieldPlan.comparison,
        evidenceBinding: null,
        checks: [
          {
            code: "FIELD_VALUE_NOT_EXTRACTED",
            path: `/${field.fieldKey}`,
            status: "failed" as const,
            detail: "The provider did not produce one unambiguous leaf value.",
          },
        ],
      };
    const fragment = input.testCase.evidence[0]!.excerpt;
    const quoteStart = fragment.indexOf(field.evidenceQuote);
    const quoteOccurrences = field.evidenceQuote.length === 0 ? 0 : fragment.split(field.evidenceQuote).length - 1;
    const valueWithinQuote = field.evidenceQuote.indexOf(field.value);
    if (valueWithinQuote < 0 || quoteOccurrences !== 1)
      return {
        fieldKey: field.fieldKey,
        status: field.status,
        mechanicsValid: false,
        comparison: fieldPlan.comparison,
        evidenceBinding: null,
        checks: [
          {
            code: "FIELD_EVIDENCE_QUOTE_INVALID",
            path: `/${field.fieldKey}`,
            status: "failed" as const,
            detail: "The exact evidence quote must occur once and contain the candidate leaf value.",
          },
        ],
      };
    const valueStart = quoteStart + valueWithinQuote;
    const valueEnd = valueStart + field.value.length;
    const selector = {
      kind: "character_position" as const,
      start: valueStart,
      end: valueEnd,
      offsetBasis: "utf16_code_units" as const,
      normalization: "none" as const,
    };
    const expectedSelectedContentDigest = sha256Digest(field.value);
    const schemaAdmission = admitExtractionSchema({
      schemaId: `diagnostics-${field.fieldKey}`,
      schemaVersion: "1",
      schema: {
        type: "object",
        description: "One candidate-produced diagnostic leaf.",
        additionalProperties: false,
        required: [field.fieldKey],
        properties: {
          [field.fieldKey]: {
            type: "string",
            description: "Candidate-produced leaf value.",
            minLength: 1,
            maxLength: 300,
          },
        },
      },
    });
    if (!schemaAdmission.admitted || !schemaAdmission.schema)
      throw new Error("BENCHMARK_EXTRACTION_INTERNAL_SCHEMA_INVALID");
    const normalized = fieldPlan.comparison === "normalized_text";
    const result = verifyExtractionFields({
      schema: schemaAdmission.schema,
      candidate: { [field.fieldKey]: field.value },
      fields: [
        {
          path: `/${field.fieldKey}`,
          comparison: fieldPlan.comparison,
          ...(normalized ? { normalizationId: "diagnostics-ascii-whitespace-v1" } : {}),
        },
      ],
      evidence: [
        {
          path: `/${field.fieldKey}`,
          captureId: input.testCase.evidence[0]!.captureId,
          representationArtifactId: input.fragmentArtifact.artifactId,
          representationDigest: input.fragmentArtifact.digest as Digest,
          selector,
          expectedSelectedContentDigest,
        },
      ],
      representations: [
        {
          captureId: input.testCase.evidence[0]!.captureId,
          artifactId: input.fragmentArtifact.artifactId,
          digest: input.fragmentArtifact.digest as Digest,
          content: input.fragmentBytes,
        },
      ],
      ...(normalized
        ? {
            normalizations: [
              { id: "diagnostics-ascii-whitespace-v1", operation: "ascii_whitespace_collapsed" as const },
            ],
          }
        : {}),
    });
    return {
      fieldKey: field.fieldKey,
      status: field.status,
      mechanicsValid: result.valid,
      comparison: fieldPlan.comparison,
      evidenceBinding: {
        captureId: input.testCase.evidence[0]!.captureId,
        fragmentArtifact: input.fragmentArtifact,
        selector,
        expectedSelectedContentDigest,
        evidenceQuote: field.evidenceQuote,
        evidenceQuoteStart: quoteStart,
      },
      checks: result.checks,
    };
  });
  return {
    schemaValid: true,
    requestedFieldCount: expectedKeys.length,
    extractedFieldCount: output.fields.filter((item) => item.status === "extracted").length,
    fieldMechanics: fieldResults.every((item) => item.mechanicsValid),
    fieldResults,
  };
}

/**
 * Makes the persisted field-ledger bytes specific to one run, case, candidate
 * role, and provider observation. The nested field result remains independently
 * recomputable from the provider output and granted fragment.
 */
export function createDiagnosticsFieldLedgerArtifact(input: {
  readonly runIdentityDigest: Digest;
  readonly caseDigest: Digest;
  readonly role: "luna_extractor" | "interfaze_extractor";
  readonly observationArtifactId: string;
  readonly fieldResult: ReturnType<typeof verifyDiagnosticsExtractionOutput>;
}) {
  if (
    !/^sha256:[0-9a-f]{64}$/u.test(input.runIdentityDigest) ||
    !/^sha256:[0-9a-f]{64}$/u.test(input.caseDigest) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(input.observationArtifactId)
  )
    throw new Error("BENCHMARK_EXTRACTION_FIELD_LEDGER_BINDING_INVALID");
  return deepFreeze({
    schemaVersion: "diagnostics-benchmark-field-ledger-artifact.v1" as const,
    runIdentityDigest: input.runIdentityDigest,
    caseDigest: input.caseDigest,
    role: input.role,
    observationArtifactId: input.observationArtifactId,
    fieldResult: structuredClone(input.fieldResult),
  });
}

export interface DiagnosticsMechanicalObservation {
  readonly locatorValid: boolean;
  readonly fieldMechanics: boolean;
  /** Candidate-specific extraction mechanics. The scalar remains for protocol-only legacy observations. */
  readonly fieldMechanicsByRole?: Readonly<Partial<Record<"luna_extractor" | "interfaze_extractor", boolean>>>;
}
export interface DiagnosticsRecordedArmDecision {
  readonly execution: Omit<
    VerificationBenchmarkCaseResult,
    | "schemaVersion"
    | "runId"
    | "armId"
    | "caseId"
    | "repetition"
    | "checkpointContextDigest"
    | "checkpointDigest"
    | "completedAt"
  >;
  readonly providerSupports: Readonly<
    Partial<Record<DiagnosticsBenchmarkProviderObservation["role"], VerificationBenchmarkCaseResult["support"]>>
  >;
  readonly qualifiersPreserved: Readonly<Partial<Record<DiagnosticsBenchmarkProviderObservation["role"], boolean>>>;
  readonly disagreement: boolean;
  readonly reasonCodes: readonly string[];
}

const roleProfile = {
  luna_extractor: {
    provider: "gateway",
    model: "openai/gpt-5.6-luna",
    ownerArmId: "baseline",
    sharedWithArmIds: ["baseline", "consensus-abstention"],
  },
  interfaze_extractor: {
    provider: "interfaze",
    model: "interfaze-beta",
    ownerArmId: "interfaze",
    sharedWithArmIds: ["interfaze", "cascade", "consensus-abstention"],
  },
  haiku_judge: {
    provider: "gateway",
    model: "anthropic/claude-haiku-4.5",
    ownerArmId: "cascade",
    sharedWithArmIds: ["cascade", "consensus-abstention"],
  },
} as const;
const requiredRoles = (
  strategy: VerificationBenchmarkArm["strategy"],
): readonly DiagnosticsBenchmarkProviderObservation["role"][] =>
  strategy === "baseline"
    ? ["luna_extractor"]
    : strategy === "interfaze"
      ? ["interfaze_extractor"]
      : strategy === "cascade"
        ? ["interfaze_extractor", "haiku_judge"]
        : ["luna_extractor", "interfaze_extractor", "haiku_judge"];
const semanticSupport = (output: SemanticJudgeOutput): VerificationBenchmarkCaseResult["support"] =>
  output.verdict === "directly_supported"
    ? "full"
    : ["supported_with_qualification", "partially_supported"].includes(output.verdict)
      ? "partial"
      : output.verdict === "contradicted"
        ? "contradicted"
        : "none";
const extractorOutput = (observation: DiagnosticsBenchmarkProviderObservation) => {
  const extraction = DiagnosticsBenchmarkExtractionOutputSchema.safeParse(observation.output);
  return extraction.success ? extraction.data : DiagnosticsBenchmarkSupportOutputSchema.parse(observation.output);
};
const observationSupport = (observation: DiagnosticsBenchmarkProviderObservation) =>
  observation.role === "haiku_judge"
    ? semanticSupport(SemanticJudgeOutputSchema.parse(observation.output))
    : extractorOutput(observation).support;
const observationQualifier = (observation: DiagnosticsBenchmarkProviderObservation) =>
  observation.role === "haiku_judge"
    ? SemanticJudgeOutputSchema.parse(observation.output).qualifiersPreserved
    : extractorOutput(observation).qualifiers_preserved;
const armFieldMechanics = (
  strategy: VerificationBenchmarkArm["strategy"],
  mechanics: DiagnosticsMechanicalObservation,
): boolean => {
  if (!mechanics.fieldMechanicsByRole) return mechanics.fieldMechanics;
  const roles =
    strategy === "baseline"
      ? (["luna_extractor"] as const)
      : strategy === "consensus_abstention"
        ? (["luna_extractor", "interfaze_extractor"] as const)
        : (["interfaze_extractor"] as const);
  return roles.every((role) => mechanics.fieldMechanicsByRole?.[role] === true);
};
// Source class alone cannot establish proposition, population, or scope authority.
// The recorded-output composer therefore treats authority as unassessed and uses
// the conservative contract value until reviewed authority evidence is admitted.
const sourceAuthority = (_testCase: VerificationBenchmarkCase): VerificationBenchmarkCaseResult["authority"] =>
  "insufficient";
const policyFor = (
  testCase: VerificationBenchmarkCase,
  support: VerificationBenchmarkCaseResult["support"],
  disagreement: boolean,
  fieldMechanics: boolean,
  qualifiersPreserved: boolean,
): VerificationBenchmarkCaseResult["policy"] => {
  if (disagreement || support === "not_applicable") return "abstain";
  if (support === "contradicted") return "fail";
  if (!fieldMechanics || !qualifiersPreserved || support === "none" || support === "partial") return "review";
  return sourceAuthority(testCase) !== "sufficient" ||
    /\b(?:clinical|diagnos|disease|prevent|treat|accurate|superior|most|only)\w*/iu.test(testCase.assertion)
    ? "review"
    : "pass_with_warnings";
};

/**
 * Recomputes an arm result from schema-validated, digest-bound recorded outputs.
 * It never reads benchmark labels, expectations, tags, or mutation metadata.
 */
export function composeDiagnosticsRecordedArm(input: {
  readonly arm: VerificationBenchmarkArm;
  readonly testCase: VerificationBenchmarkCase;
  readonly mechanics: DiagnosticsMechanicalObservation;
  readonly observations: readonly DiagnosticsBenchmarkProviderObservation[];
  readonly executionMode?: "offline_replay";
}): DiagnosticsRecordedArmDecision {
  if (
    verificationBenchmarkDigest(withoutKey(input.testCase as unknown as Record<string, unknown>, "caseDigest")) !==
    input.testCase.caseDigest
  )
    throw new Error("BENCHMARK_CASE_DIGEST_MISMATCH");
  const roles = requiredRoles(input.arm.strategy),
    fieldMechanics = armFieldMechanics(input.arm.strategy, input.mechanics),
    byRole = new Map<DiagnosticsBenchmarkProviderObservation["role"], DiagnosticsBenchmarkProviderObservation>();
  for (const raw of input.observations) {
    const observation = DiagnosticsBenchmarkProviderObservationSchema.parse(raw);
    const material = withoutKey(observation as unknown as Record<string, unknown>, "observationDigest");
    const profile = roleProfile[observation.role];
    if (
      verificationBenchmarkDigest(material) !== observation.observationDigest ||
      observation.caseId !== input.testCase.caseId ||
      observation.caseDigest !== input.testCase.caseDigest ||
      observation.provider !== profile.provider ||
      observation.model !== profile.model ||
      byRole.has(observation.role)
    )
      throw new Error("BENCHMARK_PROVIDER_OBSERVATION_BINDING_INVALID");
    byRole.set(observation.role, observation);
  }
  if (!input.mechanics.locatorValid)
    return {
      execution: {
        schemaValid: true,
        locatorValid: false,
        fieldMechanics: false,
        support: "not_applicable",
        authority: "not_applicable",
        worldCorrectness: "not_applicable",
        policy: "abstain",
        confidence: null,
        confidenceCalibrated: false,
        failureClass: "none",
        callAttributions: [],
      },
      providerSupports: {},
      qualifiersPreserved: {},
      disagreement: false,
      reasonCodes: ["LOCATOR_GATE_CLOSED"],
    };
  const selected = roles.map((role) => byRole.get(role));
  if (selected.some((item) => !item))
    return {
      execution: {
        schemaValid: false,
        locatorValid: true,
        fieldMechanics,
        support: "not_applicable",
        authority: sourceAuthority(input.testCase),
        worldCorrectness: "unknown",
        policy: "abstain",
        confidence: null,
        confidenceCalibrated: false,
        failureClass: "provider",
        callAttributions: [],
      },
      providerSupports: {},
      qualifiersPreserved: {},
      disagreement: false,
      reasonCodes: roles.filter((role) => !byRole.has(role)).map((role) => `MISSING_RECORDED_${role.toUpperCase()}`),
    };
  const observations = selected as DiagnosticsBenchmarkProviderObservation[];
  const supports = Object.fromEntries(
    observations.map((item) => [item.role, observationSupport(item)]),
  ) as DiagnosticsRecordedArmDecision["providerSupports"];
  const qualifiers = Object.fromEntries(
    observations.map((item) => [item.role, observationQualifier(item)]),
  ) as DiagnosticsRecordedArmDecision["qualifiersPreserved"];
  const supportValues = Object.values(supports),
    qualifierValues = Object.values(qualifiers);
  let disagreement = new Set(supportValues).size > 1 || new Set(qualifierValues).size > 1;
  let support: VerificationBenchmarkCaseResult["support"];
  const reasonCodes: string[] = [];
  if (!fieldMechanics) reasonCodes.push("FIELD_MECHANICS_FAILED");
  if (qualifierValues.some((value) => !value)) reasonCodes.push("MATERIAL_QUALIFIER_NOT_PRESERVED");
  reasonCodes.push("SOURCE_AUTHORITY_UNASSESSED");
  if (input.arm.strategy === "consensus_abstention") {
    if (disagreement) {
      support = "not_applicable";
      reasonCodes.push("PROVIDER_DISAGREEMENT");
    } else support = supportValues[0]!;
  } else if (input.arm.strategy === "cascade") {
    if (new Set(supportValues).size === 1) support = supportValues[0]!;
    else if (supportValues.every((item) => item === "full" || item === "partial")) support = "partial";
    else {
      support = "not_applicable";
      disagreement = true;
      reasonCodes.push("CASCADE_JUDGE_DISAGREEMENT");
    }
    if (new Set(qualifierValues).size > 1) {
      disagreement = true;
      reasonCodes.push("QUALIFIER_FLAG_DISAGREEMENT");
    }
  } else support = supportValues[0]!;
  const callAttributions = observations.map((observation) => {
    const profile = roleProfile[observation.role],
      ownsFreshCall =
        input.executionMode !== "offline_replay" &&
        observation.runDisposition === "fresh_in_run" &&
        input.arm.armId === profile.ownerArmId;
    return {
      callId: observation.observationDigest,
      armId: input.arm.armId,
      caseId: input.testCase.caseId,
      provider: observation.provider,
      model: observation.model,
      requestDigest: observation.requestDigest,
      responseDigest: observation.rawResponseDigest,
      cacheDisposition: ownsFreshCall ? ("fresh" as const) : ("exact_cache_shared" as const),
      sharedWithArmIds: [...profile.sharedWithArmIds],
      costState: observation.costState,
      actualCostMicros: ownsFreshCall ? observation.actualCostMicros : observation.costState === "actual" ? 0 : null,
      reservationCostMicros: ownsFreshCall ? observation.reservationCostMicros : 0,
      latencyMs: ownsFreshCall ? observation.latencyMs : null,
      failureClass: "none" as const,
    };
  });
  const policy = policyFor(input.testCase, support, disagreement, fieldMechanics, qualifierValues.every(Boolean));
  return {
    execution: {
      schemaValid: true,
      locatorValid: true,
      fieldMechanics,
      support,
      authority: sourceAuthority(input.testCase),
      worldCorrectness: "unknown",
      policy,
      confidence: null,
      confidenceCalibrated: false,
      failureClass: "none",
      callAttributions,
    },
    providerSupports: supports,
    qualifiersPreserved: qualifiers,
    disagreement,
    reasonCodes,
  };
}
