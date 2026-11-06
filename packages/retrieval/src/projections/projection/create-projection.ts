import { DomainProjectionSchema, type DomainProjection } from "@aiengineer/knowledge-contracts";
import { deepFreeze, sha256Digest } from "@aiengineer/knowledge-core";
import { deterministicUuid } from "@aiengineer/knowledge-preparation";
import { validateEvidenceSupport } from "../validation/index.js";
import type { ProjectionInput } from "../types.js";

export function createProjection(input: ProjectionInput): Readonly<DomainProjection> {
  const validation = validateEvidenceSupport(input);
  if (!validation.valid) {
    throw new Error(`Projection evidence validation failed: ${validation.issues.join("; ")}`);
  }
  const supportLocatorIds = [...new Set(input.evidence.map(({ locatorId }) => locatorId))].sort();
  const text = projectionText(input);
  const base = {
    projectionId: deterministicUuid(
      sha256Digest({
        sourceRecordId: input.sourceRecordId,
        procedureVersionId: input.procedureVersionId,
        space: input.space,
        text,
        supportSetDigest: validation.supportSetDigest,
      }),
    ),
    procedureVersionId: input.procedureVersionId,
    sourceRecordId: input.sourceRecordId,
    text,
    supportLocatorIds,
  };
  let projection: unknown;
  switch (input.space) {
    case "engineering_claims":
      projection = {
        ...base,
        space: input.space,
        claimClass: input.claimClass,
        attribution: input.attribution,
        limitations: [...input.limitations],
      };
      break;
    case "tool_capabilities":
      projection = {
        ...base,
        space: input.space,
        toolName: input.toolName,
        capabilities: [...input.capabilities],
        constraints: [...input.constraints],
      };
      break;
    case "implementation_examples":
      projection = {
        ...base,
        space: input.space,
        language: input.language,
        commit: input.commit,
        path: input.path,
        ...(input.framework === undefined ? {} : { framework: input.framework }),
        ...(input.symbol === undefined ? {} : { symbol: input.symbol }),
      };
      break;
    case "paper_case_study_knowledge":
      projection = {
        ...base,
        space: input.space,
        title: input.title,
        findingClass: input.findingClass,
        derived: input.derived,
      };
      break;
    case "entity_profiles":
      projection = {
        ...base,
        space: input.space,
        entityType: input.entityType,
        canonicalName: input.canonicalName,
        aliases: [...input.aliases],
      };
      break;
    case "model_capabilities":
      projection = {
        ...base,
        space: input.space,
        modelVersion: input.modelVersion,
        capabilities: [...input.capabilities],
        constraints: [...input.constraints],
        observedAt: input.observedAt,
      };
      break;
    case "benchmark_intelligence":
      projection = {
        ...base,
        space: input.space,
        benchmarkVersion: input.benchmarkVersion,
        metric: input.metric,
        protocol: input.protocol,
        comparabilityWarnings: [...input.comparabilityWarnings],
      };
      break;
    case "source_native_sections":
      projection = {
        ...base,
        space: input.space,
        sectionPath: [...input.sectionPath],
        faithful: true,
        exploratory: true,
      };
      break;
  }
  return deepFreeze(DomainProjectionSchema.parse(projection));
}

function projectionText(input: ProjectionInput): string {
  const assertions = input.assertions.map(({ statement }) => statement.trim());
  switch (input.space) {
    case "engineering_claims":
      return lines([input.problem, ...assertions, input.mechanism, ...input.applicability, ...input.limitations]);
    case "tool_capabilities":
      return lines([
        input.toolName,
        ...input.capabilities,
        ...input.constraints,
        ...(input.languages ?? []),
        ...(input.frameworks ?? []),
        ...(input.deploymentModes ?? []),
      ]);
    case "implementation_examples":
      return lines([
        input.objective,
        input.language,
        input.framework,
        input.commit,
        input.path,
        input.symbol,
        ...(input.dependencies ?? []),
        ...(input.codeIdentifiers ?? []),
        ...assertions,
      ]);
    case "paper_case_study_knowledge":
      return lines([input.title, input.sectionRole, ...input.findings, ...input.caveats, ...assertions]);
    case "entity_profiles":
      return lines([
        input.canonicalName,
        input.entityType,
        input.profileKind,
        ...input.aliases,
        ...(input.identifiers ?? []),
        ...assertions,
      ]);
    case "model_capabilities":
      return lines([
        input.modelVersion,
        ...input.capabilities,
        ...input.constraints,
        ...(input.modalities ?? []),
        ...(input.tasks ?? []),
        input.observedAt,
        ...assertions,
      ]);
    case "benchmark_intelligence":
      return lines([
        input.benchmarkVersion,
        input.measuredTask,
        input.dataset,
        input.metric,
        input.protocol,
        ...(input.resultObservations ?? []),
        ...input.comparabilityWarnings,
        ...assertions,
      ]);
    case "source_native_sections":
      return lines([...input.sectionPath, input.sourceText]);
  }
}

function lines(values: readonly (string | undefined)[]): string {
  return values
    .filter((value): value is string => value !== undefined && value.trim().length > 0)
    .map((value) => value.trim())
    .join("\n");
}
