// Pilot-v3 provider-input grant (D-013) over the frozen diagnostics catalogs. Quarantined diagnostics:
// the loaders and the provider-input builders share one module-private provenance map.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { VerificationBenchmarkCase, VerificationBenchmarkDataset } from "@aiengineer/knowledge-contracts";
import { VerificationBenchmarkDatasetSchema } from "@aiengineer/knowledge-contracts";
import {
  assertFrozenVerificationBenchmarkDataset,
  verificationBenchmarkDigest,
} from "@aiengineer/knowledge-evaluation";
import {
  gatewaySemanticPromptDigest,
  gatewaySemanticOutputSchemaDigest,
  providerDigest,
} from "@aiengineer/knowledge-verification";
import {
  type Digest,
  bytesDigest,
  extractionSystemPrompt,
  plainObject,
  exactKeys,
  withoutKey,
  numbers,
} from "../verification/benchmark/verification-benchmark-shared.js";
import { loadDiagnosticsOfflineCatalog } from "./verification-diagnostics-offline-catalog.js";

const providerGrantProvenance = new WeakMap<object, ReadonlyMap<string, Digest>>();
export const DIAGNOSTICS_PILOT_V3_SEAL = Object.freeze({
  datasetManifestDigest: "sha256:b625b311493f8c366ef43bf4047bf61f38d510fe7f3c340f50bca42de737dfe6" as Digest,
  grantDigest: "sha256:8c1530d5f856796ce71c21a71d592716fd2972fa53d4843235d7208798236639" as Digest,
  catalogManifestDigest: "sha256:b90e96a2dc341f7d7c71f18d04f99fe4e9566b79c3b294effccf7dac585fa6ed" as Digest,
});
export const DIAGNOSTICS_SUPPORT_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  description: "Evidence-only support classification.",
  additionalProperties: false,
  required: ["support", "qualifiers_preserved", "unsupported_facets", "public_rationale"],
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
    unsupported_facets: {
      type: "array",
      description: "Facets absent from or inconsistent with the supplied fragment.",
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
export const DIAGNOSTICS_SUPPORT_OUTPUT_SCHEMA_DIGEST = providerDigest(DIAGNOSTICS_SUPPORT_OUTPUT_SCHEMA);
export interface DiagnosticsProviderGrantAuthority {
  readonly datasetManifestDigest: Digest;
  readonly grantDigest: Digest;
  readonly catalogManifestDigest: Digest;
  readonly authorizedCaseCount: number;
}

/** Admits the sealed original catalog's exact public inputs under the same tighter D-013 bounds. */
export async function loadDiagnosticsV1ProviderGrant(
  catalogDirectory: string,
): Promise<{ readonly dataset: VerificationBenchmarkDataset; readonly authority: DiagnosticsProviderGrantAuthority }> {
  const catalog = await loadDiagnosticsOfflineCatalog("diagnostics-companies-v1", catalogDirectory);
  const grant = plainObject(
    JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(catalog.files.get("derived-input-grant.json")!)),
    "BENCHMARK_GRANT_INVALID",
  );
  exactKeys(
    grant,
    [
      "schemaVersion",
      "datasetManifestDigest",
      "approvedBy",
      "approvedAt",
      "constraints",
      "providers",
      "pricingSnapshot",
      "authorizedDerivedInputs",
      "grantDigest",
    ],
    "BENCHMARK_GRANT_UNKNOWN_FIELD",
  );
  if (
    grant.schemaVersion !== "verification-benchmark-derived-input-grant.v1" ||
    grant.datasetManifestDigest !== catalog.datasetManifestDigest ||
    grant.grantDigest !== "sha256:9ba42415f84a0c18d82b664bf4f4982b182e48c5e79602705e3dbf524f786c67" ||
    grant.grantDigest !== verificationBenchmarkDigest(withoutKey(grant, "grantDigest")) ||
    grant.approvedBy !== "verification-module-coordinator"
  )
    throw new Error("BENCHMARK_GRANT_DIGEST_MISMATCH");
  const constraints = plainObject(grant.constraints, "BENCHMARK_GRANT_CONSTRAINTS_INVALID");
  if (
    constraints.textOnly !== true ||
    constraints.oneAssertionPerCase !== true ||
    constraints.oneExactFragmentPerCase !== true ||
    constraints.maximumFragmentUtf16Characters !== 2_000 ||
    constraints.maximumSerializedRequestUtf8Bytes !== 10_000 ||
    constraints.maximumOutputTokens !== 900 ||
    constraints.fullPageOrPdfUpload !== false ||
    constraints.tools !== false ||
    constraints.search !== false ||
    constraints.redirects !== false ||
    constraints.concurrency !== 1 ||
    constraints.automaticQualityRetries !== 0
  )
    throw new Error("BENCHMARK_GRANT_CONSTRAINTS_MISMATCH");
  if (
    !Array.isArray(grant.authorizedDerivedInputs) ||
    grant.authorizedDerivedInputs.length !== 40 ||
    catalog.dataset.cases.length !== 40
  )
    throw new Error("BENCHMARK_GRANT_CASE_LIMIT");
  const authorized = new Map<string, Digest>();
  for (const raw of grant.authorizedDerivedInputs) {
    const item = plainObject(raw, "BENCHMARK_GRANT_CASE_INVALID");
    exactKeys(
      item,
      [
        "inputManifestArtifactId",
        "caseId",
        "captureId",
        "sourceKey",
        "selectedContentDigest",
        "assertionDigest",
        "excerptUtf16Characters",
        "authorized",
      ],
      "BENCHMARK_GRANT_CASE_UNKNOWN_FIELD",
    );
    const testCase = catalog.dataset.cases.find((candidate) => candidate.caseId === item.caseId);
    if (!testCase || authorized.has(testCase.caseId) || item.authorized !== true || testCase.evidence.length !== 1)
      throw new Error("BENCHMARK_GRANT_CASE_INVALID");
    const evidence = testCase.evidence[0]!;
    if (
      item.inputManifestArtifactId !== testCase.inputManifestArtifactId ||
      item.captureId !== evidence.captureId ||
      item.sourceKey !== evidence.sourceKey ||
      item.selectedContentDigest !== evidence.selectedContentDigest ||
      item.assertionDigest !== bytesDigest(testCase.assertion) ||
      item.excerptUtf16Characters !== evidence.excerpt.length ||
      testCase.assertion.length + evidence.excerpt.length > 2_000
    )
      throw new Error(`BENCHMARK_GRANT_CASE_BINDING_MISMATCH:${testCase.caseId}`);
    authorized.set(testCase.caseId, testCase.caseDigest as Digest);
  }
  const authority: DiagnosticsProviderGrantAuthority = Object.freeze({
    datasetManifestDigest: catalog.datasetManifestDigest,
    grantDigest: grant.grantDigest as Digest,
    catalogManifestDigest: catalog.catalogManifestDigest,
    authorizedCaseCount: authorized.size,
  });
  providerGrantProvenance.set(authority, authorized);
  return { dataset: catalog.dataset, authority };
}

/** Authenticates the complete frozen catalog and creates the only accepted provider-input authority. */
export async function loadDiagnosticsProviderGrant(
  catalogDirectory: string,
): Promise<{ readonly dataset: VerificationBenchmarkDataset; readonly authority: DiagnosticsProviderGrantAuthority }> {
  const [datasetBytes, grantBytes, manifestBytes] = await Promise.all([
    readFile(resolve(catalogDirectory, "dataset.json")),
    readFile(resolve(catalogDirectory, "derived-input-grant.json")),
    readFile(resolve(catalogDirectory, "manifest.json")),
  ]);
  const dataset = VerificationBenchmarkDatasetSchema.strict().parse(
    JSON.parse(datasetBytes.toString("utf8")),
  ) as VerificationBenchmarkDataset;
  assertFrozenVerificationBenchmarkDataset(dataset);
  const grant = plainObject(JSON.parse(grantBytes.toString("utf8")), "BENCHMARK_GRANT_INVALID");
  const manifest = plainObject(JSON.parse(manifestBytes.toString("utf8")), "BENCHMARK_CATALOG_MANIFEST_INVALID");
  exactKeys(
    manifest,
    [
      "schemaVersion",
      "datasetManifestDigest",
      "sourcePreparationDigest",
      "proposalDigest",
      "fragmentCandidateDigest",
      "files",
      "manifestDigest",
    ],
    "BENCHMARK_CATALOG_MANIFEST_UNKNOWN_FIELD",
  );
  if (
    manifest.schemaVersion !== "verification-benchmark-catalog-manifest.v1" ||
    manifest.datasetManifestDigest !== dataset.manifestDigest ||
    manifest.sourcePreparationDigest !== dataset.sourcePreparationDigest ||
    manifest.manifestDigest !== verificationBenchmarkDigest(withoutKey(manifest, "manifestDigest"))
  )
    throw new Error("BENCHMARK_CATALOG_MANIFEST_DIGEST_MISMATCH");
  if (
    dataset.manifestDigest !== DIAGNOSTICS_PILOT_V3_SEAL.datasetManifestDigest ||
    grant.grantDigest !== DIAGNOSTICS_PILOT_V3_SEAL.grantDigest ||
    manifest.manifestDigest !== DIAGNOSTICS_PILOT_V3_SEAL.catalogManifestDigest
  )
    throw new Error("BENCHMARK_CATALOG_SEAL_MISMATCH");
  const fileEntries = Array.isArray(manifest.files)
    ? manifest.files.map((item) => plainObject(item, "BENCHMARK_CATALOG_FILE_INVALID"))
    : (() => {
        throw new Error("BENCHMARK_CATALOG_FILES_INVALID");
      })();
  for (const [index, entry] of fileEntries.entries()) {
    exactKeys(entry, ["name", "digest", "bytes"], "BENCHMARK_CATALOG_FILE_UNKNOWN_FIELD");
    if (typeof entry.name !== "string" || typeof entry.digest !== "string" || typeof entry.bytes !== "number")
      throw new Error("BENCHMARK_CATALOG_FILE_INVALID");
    if (fileEntries.findIndex((candidate) => candidate.name === entry.name) !== index)
      throw new Error("BENCHMARK_CATALOG_FILE_DUPLICATE");
    const bytes =
      entry.name === "dataset.json"
        ? datasetBytes
        : entry.name === "derived-input-grant.json"
          ? grantBytes
          : await readFile(resolve(catalogDirectory, entry.name));
    if (bytesDigest(bytes) !== entry.digest || bytes.byteLength !== entry.bytes)
      throw new Error(`BENCHMARK_CATALOG_FILE_DIGEST_MISMATCH:${entry.name}`);
  }
  if (
    !fileEntries.some((entry) => entry.name === "dataset.json") ||
    !fileEntries.some((entry) => entry.name === "derived-input-grant.json")
  )
    throw new Error("BENCHMARK_CATALOG_REQUIRED_FILE_MISSING");
  exactKeys(
    grant,
    [
      "schemaVersion",
      "datasetManifestDigest",
      "approvalReference",
      "approvedAt",
      "constraints",
      "providers",
      "pricingSnapshot",
      "authorizedDerivedInputs",
      "grantDigest",
    ],
    "BENCHMARK_GRANT_UNKNOWN_FIELD",
  );
  if (
    grant.schemaVersion !== "verification-benchmark-derived-input-grant.v1" ||
    grant.datasetManifestDigest !== dataset.manifestDigest ||
    grant.grantDigest !== verificationBenchmarkDigest(withoutKey(grant, "grantDigest"))
  )
    throw new Error("BENCHMARK_GRANT_DIGEST_MISMATCH");
  const approval = plainObject(grant.approvalReference, "BENCHMARK_GRANT_APPROVAL_INVALID");
  if (approval.decisionId !== "D-013" || approval.status !== "accepted")
    throw new Error("BENCHMARK_GRANT_NOT_APPROVED");
  const constraints = plainObject(grant.constraints, "BENCHMARK_GRANT_CONSTRAINTS_INVALID");
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
    throw new Error("BENCHMARK_GRANT_CONSTRAINTS_MISMATCH");
  const authorizations = Array.isArray(grant.authorizedDerivedInputs)
    ? grant.authorizedDerivedInputs.map((item) => plainObject(item, "BENCHMARK_GRANT_CASE_INVALID"))
    : (() => {
        throw new Error("BENCHMARK_GRANT_CASES_INVALID");
      })();
  if (authorizations.length > 40) throw new Error("BENCHMARK_GRANT_CASE_LIMIT");
  const authorizedCaseDigests = new Map<string, Digest>();
  for (const authorization of authorizations) {
    exactKeys(
      authorization,
      [
        "inputManifestArtifactId",
        "caseId",
        "captureId",
        "sourceKey",
        "sourceClass",
        "selectedContentDigest",
        "assertionDigest",
        "combinedCaseUtf16Characters",
        "qualifierMetadata",
        "authorized",
      ],
      "BENCHMARK_GRANT_CASE_UNKNOWN_FIELD",
    );
    const caseId = authorization.caseId;
    if (
      typeof caseId !== "string" ||
      authorizedCaseDigests.has(caseId) ||
      authorization.authorized !== true ||
      !Array.isArray(authorization.qualifierMetadata) ||
      authorization.qualifierMetadata.some((item) => typeof item !== "string")
    )
      throw new Error("BENCHMARK_GRANT_CASE_INVALID");
    const testCase = dataset.cases.find((item) => item.caseId === caseId);
    if (!testCase || testCase.evidence.length !== 1) throw new Error(`BENCHMARK_GRANT_CASE_BINDING_MISSING:${caseId}`);
    const evidence = testCase.evidence[0]!;
    if (
      authorization.inputManifestArtifactId !== testCase.inputManifestArtifactId ||
      authorization.captureId !== evidence.captureId ||
      authorization.sourceKey !== evidence.sourceKey ||
      authorization.sourceClass !== evidence.sourceClass ||
      authorization.selectedContentDigest !== evidence.selectedContentDigest ||
      authorization.assertionDigest !== bytesDigest(testCase.assertion) ||
      authorization.combinedCaseUtf16Characters !== testCase.assertion.length + evidence.excerpt.length ||
      authorization.combinedCaseUtf16Characters > 2_000
    )
      throw new Error(`BENCHMARK_GRANT_CASE_BINDING_MISMATCH:${caseId}`);
    authorizedCaseDigests.set(caseId, testCase.caseDigest as Digest);
  }
  const authority: DiagnosticsProviderGrantAuthority = Object.freeze({
    datasetManifestDigest: dataset.manifestDigest as Digest,
    grantDigest: grant.grantDigest as Digest,
    catalogManifestDigest: manifest.manifestDigest as Digest,
    authorizedCaseCount: authorizedCaseDigests.size,
  });
  providerGrantProvenance.set(authority, new Map(authorizedCaseDigests));
  return { dataset, authority };
}

export function createDiagnosticsProviderCaseInput(
  testCase: VerificationBenchmarkCase,
  authority: DiagnosticsProviderGrantAuthority,
) {
  const authorized = authority && typeof authority === "object" ? providerGrantProvenance.get(authority) : undefined;
  const recomputedCaseDigest = verificationBenchmarkDigest(
    withoutKey(testCase as unknown as Record<string, unknown>, "caseDigest"),
  );
  if (
    !authorized ||
    authorized.get(testCase.caseId) !== testCase.caseDigest ||
    recomputedCaseDigest !== testCase.caseDigest ||
    testCase.evidence.length !== 1
  )
    throw new Error("BENCHMARK_CASE_NOT_AUTHORIZED_FOR_PROVIDER");
  const evidence = testCase.evidence[0]!,
    input = {
      assertion: testCase.assertion,
      fragment: evidence.excerpt,
      sourceClass: evidence.sourceClass,
      qualifierMetadata: [] as readonly string[],
    };
  if (input.assertion.length + input.fragment.length > 2_000) throw new Error("BENCHMARK_PROVIDER_CASE_UTF16_LIMIT");
  return input;
}
export function createDiagnosticsProviderPrompt(
  testCase: VerificationBenchmarkCase,
  authority: DiagnosticsProviderGrantAuthority,
): string {
  return `Evaluate only whether the assertion is supported by the fragment. Preserve all numbers, timing start events, populations, negations, and scope. Return the strict schema.\n${JSON.stringify(createDiagnosticsProviderCaseInput(testCase, authority))}`;
}
export function createDiagnosticsProviderJudgeInput(
  testCase: VerificationBenchmarkCase,
  authority: DiagnosticsProviderGrantAuthority,
) {
  const content = createDiagnosticsProviderCaseInput(testCase, authority);
  return {
    rubricVersion: "evidence-only.v1" as const,
    assertionId: verificationBenchmarkDigest({
      purpose: "provider-visible-assertion",
      datasetManifestDigest: authority.datasetManifestDigest,
      caseDigest: testCase.caseDigest,
    }),
    proposition: content.assertion,
    qualifiers: [],
    entityBindings: [],
    fragments: [
      {
        fragmentId: verificationBenchmarkDigest({
          purpose: "provider-visible-fragment",
          datasetManifestDigest: authority.datasetManifestDigest,
          selectedContentDigest: testCase.evidence[0]!.selectedContentDigest,
        }),
        exactText: content.fragment,
      },
    ],
  };
}
export function assertDiagnosticsProviderWireRequest(
  testCase: VerificationBenchmarkCase,
  authority: DiagnosticsProviderGrantAuthority,
  requestBytes: Uint8Array,
  policy: {
    readonly provider: "gateway" | "interfaze";
    readonly model: "openai/gpt-5.6-luna" | "anthropic/claude-haiku-4.5" | "interfaze-beta";
  },
): void {
  const content = createDiagnosticsProviderCaseInput(testCase, authority);
  if (!requestBytes.byteLength || requestBytes.byteLength > 10_000)
    throw new Error("BENCHMARK_PROVIDER_WIRE_UTF8_LIMIT");
  let body: Record<string, unknown>;
  try {
    body = plainObject(
      JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(requestBytes)),
      "BENCHMARK_PROVIDER_WIRE_INVALID",
    );
  } catch {
    throw new Error("BENCHMARK_PROVIDER_WIRE_INVALID");
  }
  const tokenKey = policy.provider === "interfaze" ? "max_tokens" : "max_completion_tokens";
  const expectedKeys = ["model", "temperature", tokenKey, "messages", "response_format"];
  exactKeys(body, expectedKeys, "BENCHMARK_PROVIDER_WIRE_UNKNOWN_FIELD");
  if (body.model !== policy.model || body.temperature !== 0 || body[tokenKey] !== 900 || !Array.isArray(body.messages))
    throw new Error("BENCHMARK_PROVIDER_WIRE_POLICY_MISMATCH");
  const messages = body.messages.map((item) => plainObject(item, "BENCHMARK_PROVIDER_WIRE_MESSAGES_INVALID"));
  const userMessages = messages.filter((item) => item.role === "user");
  const expectedUserContent =
    policy.model === "anthropic/claude-haiku-4.5"
      ? JSON.stringify(createDiagnosticsProviderJudgeInput(testCase, authority))
      : createDiagnosticsProviderPrompt(testCase, authority);
  if (userMessages.length !== 1 || userMessages[0]!.content !== expectedUserContent)
    throw new Error("BENCHMARK_PROVIDER_WIRE_CONTENT_MISMATCH");
  for (const message of messages) {
    exactKeys(message, ["role", "content"], "BENCHMARK_PROVIDER_WIRE_MESSAGE_UNKNOWN_FIELD");
    if ((message.role !== "system" && message.role !== "user") || typeof message.content !== "string")
      throw new Error("BENCHMARK_PROVIDER_WIRE_MESSAGES_INVALID");
  }
  if (policy.provider === "interfaze" ? messages.length !== 1 : messages.length !== 2 || messages[0]!.role !== "system")
    throw new Error("BENCHMARK_PROVIDER_WIRE_MESSAGES_INVALID");
  if (
    policy.provider === "gateway" &&
    (policy.model === "anthropic/claude-haiku-4.5"
      ? providerDigest(messages[0]!.content) !== gatewaySemanticPromptDigest
      : messages[0]!.content !== extractionSystemPrompt)
  )
    throw new Error("BENCHMARK_PROVIDER_WIRE_SYSTEM_PROMPT_MISMATCH");
  const responseFormat = plainObject(body.response_format, "BENCHMARK_PROVIDER_WIRE_RESPONSE_FORMAT_INVALID");
  exactKeys(responseFormat, ["type", "json_schema"], "BENCHMARK_PROVIDER_WIRE_RESPONSE_FORMAT_UNKNOWN_FIELD");
  const jsonSchema = plainObject(responseFormat.json_schema, "BENCHMARK_PROVIDER_WIRE_RESPONSE_SCHEMA_INVALID");
  exactKeys(jsonSchema, ["name", "strict", "schema"], "BENCHMARK_PROVIDER_WIRE_RESPONSE_SCHEMA_UNKNOWN_FIELD");
  const semantic = policy.model === "anthropic/claude-haiku-4.5";
  if (
    responseFormat.type !== "json_schema" ||
    jsonSchema.strict !== true ||
    jsonSchema.name !== (semantic ? "verification_semantic_judge" : "benchmark_support") ||
    providerDigest(jsonSchema.schema) !==
      (semantic ? gatewaySemanticOutputSchemaDigest : DIAGNOSTICS_SUPPORT_OUTPUT_SCHEMA_DIGEST)
  )
    throw new Error("BENCHMARK_PROVIDER_WIRE_RESPONSE_SCHEMA_MISMATCH");
}
