import {
  UuidSchema,
  type VerificationArtifactHandle,
  type VerificationSource,
  type VerificationSourceCapture,
  type VerificationBenchmarkDataset,
} from "@aiengineer/knowledge-contracts";
import { deepFreeze } from "@aiengineer/knowledge-core";
import { assertFrozenVerificationBenchmarkDataset } from "@aiengineer/knowledge-evaluation";
import { projectionSelectorResolver, sha256Digest } from "@aiengineer/knowledge-verification";
import type { AdmittedOfflineBenchmarkInputs } from "./verification-benchmark-inputs.js";

type Digest = `sha256:${string}`;
const MAX_SELECTED_TEXT_BYTES = 8 * 1024;

export interface RegisteredBenchmarkProjectionCapturePort {
  getRegisteredCapture(input: { readonly tenantId: string; readonly captureId: string }): Promise<{
    readonly source: VerificationSource;
    readonly capture: VerificationSourceCapture;
  }>;
}

/** Structural subset of VerificationAdmissionService: parser custody remains in that service. */
export interface RegisteredBenchmarkProjectionAdmissionPort {
  hydrateAdmittedProjection(input: {
    readonly tenantId: string;
    readonly captureId: string;
    readonly expectedSourceArtifact: { readonly artifactId: string; readonly digest: Digest };
    readonly transformationArtifactId: string;
    readonly projectionArtifactId: string;
  }): Promise<{
    readonly receipt: {
      readonly captureId: string;
      readonly sourceArtifact: VerificationArtifactHandle;
      readonly projectionArtifact: VerificationArtifactHandle;
    };
    readonly content: Uint8Array;
  }>;
}

export interface RegisteredBenchmarkProjectionPorts {
  readonly captures: RegisteredBenchmarkProjectionCapturePort;
  readonly admission: RegisteredBenchmarkProjectionAdmissionPort;
  readonly maximumSelectedTextBytes?: number;
}

export interface BenchmarkFragmentProjectionResolution {
  readonly fragmentId: string;
  readonly captureId: string;
  readonly projectionArtifactId: string;
  readonly projectionDigest: Digest;
  readonly locatorValid: boolean;
  readonly selectorStatus: "resolved" | "not_found" | "ambiguous" | "invalid" | "parse_error";
  /** Present only for a resolved selector whose selected bytes match the retained digest and fit the bound. */
  readonly selectedText?: string;
}

export interface PreparedBenchmarkCaseProjections {
  readonly caseId: string;
  readonly byFragmentId: Readonly<Record<string, BenchmarkFragmentProjectionResolution>>;
}

export interface PreparedRegisteredBenchmarkProjections {
  readonly byCaseId: Readonly<Record<string, PreparedBenchmarkCaseProjections>>;
}

/**
 * Revalidates custody for every retained benchmark evidence edge. Selector
 * mismatches are benchmark mechanics (`locatorValid: false`), whereas capture
 * and admitted-projection failures remain terminal custody failures.
 */
export async function prepareRegisteredBenchmarkProjections(
  admitted: AdmittedOfflineBenchmarkInputs,
  context: { readonly tenantId: unknown; readonly signal?: AbortSignal },
  ports: RegisteredBenchmarkProjectionPorts,
): Promise<PreparedRegisteredBenchmarkProjections> {
  const tenantId = tenant(context.tenantId);
  assertActive(context.signal);
  assertAdmittedBinding(admitted, tenantId);
  return prepareBenchmarkProjectionDataset(admitted.dataset, context, ports);
}

/** Mechanical dataset processing; request admission belongs to the calling boundary. */
export async function prepareBenchmarkProjectionDataset(
  dataset: VerificationBenchmarkDataset,
  context: { readonly tenantId: unknown; readonly signal?: AbortSignal },
  ports: RegisteredBenchmarkProjectionPorts,
): Promise<PreparedRegisteredBenchmarkProjections> {
  const tenantId = tenant(context.tenantId);
  assertActive(context.signal);
  assertFrozenVerificationBenchmarkDataset(dataset);
  const maximumSelectedTextBytes = selectedTextLimit(ports.maximumSelectedTextBytes);
  const byCaseId: Record<string, PreparedBenchmarkCaseProjections> = Object.create(null) as Record<
    string,
    PreparedBenchmarkCaseProjections
  >;

  for (const benchmarkCase of dataset.cases) {
    assertActive(context.signal);
    const byFragmentId: Record<string, BenchmarkFragmentProjectionResolution> = Object.create(null) as Record<
      string,
      BenchmarkFragmentProjectionResolution
    >;
    for (const evidence of benchmarkCase.evidence) {
      if (byFragmentId[evidence.fragmentId] !== undefined) throw new Error("BENCHMARK_PROJECTION_FRAGMENT_DUPLICATE");
      const binding = await ports.captures.getRegisteredCapture({ tenantId, captureId: evidence.captureId });
      assertActive(context.signal);
      if (
        binding.capture.captureId !== evidence.captureId ||
        binding.source.sourceId !== binding.capture.sourceId ||
        binding.capture.contentArtifact.tenantId !== tenantId
      ) {
        throw new Error("BENCHMARK_PROJECTION_CAPTURE_BINDING_MISMATCH");
      }
      const sourceArtifact = binding.capture.contentArtifact;
      const hydrated = await ports.admission.hydrateAdmittedProjection({
        tenantId,
        captureId: evidence.captureId,
        expectedSourceArtifact: { artifactId: sourceArtifact.artifactId, digest: sourceArtifact.digest as Digest },
        transformationArtifactId: evidence.transformationArtifactId,
        projectionArtifactId: evidence.projectionArtifactId,
      });
      assertActive(context.signal);
      if (
        hydrated.receipt.captureId !== evidence.captureId ||
        hydrated.receipt.sourceArtifact.tenantId !== tenantId ||
        hydrated.receipt.sourceArtifact.artifactId !== sourceArtifact.artifactId ||
        hydrated.receipt.sourceArtifact.digest !== sourceArtifact.digest ||
        hydrated.receipt.projectionArtifact.tenantId !== tenantId ||
        hydrated.receipt.projectionArtifact.artifactId !== evidence.projectionArtifactId ||
        hydrated.receipt.projectionArtifact.digest !== evidence.projectionDigest ||
        hydrated.receipt.projectionArtifact.byteLength !== hydrated.content.byteLength ||
        sha256Digest(hydrated.content) !== hydrated.receipt.projectionArtifact.digest
      ) {
        throw new Error("BENCHMARK_PROJECTION_CUSTODY_BINDING_MISMATCH");
      }
      byFragmentId[evidence.fragmentId] = resolveMechanically({
        evidence: {
          ...evidence,
          projectionDigest: evidence.projectionDigest as Digest,
          selectedContentDigest: evidence.selectedContentDigest as Digest,
        },
        content: hydrated.content,
        maximumSelectedTextBytes,
      });
    }
    byCaseId[benchmarkCase.caseId] = { caseId: benchmarkCase.caseId, byFragmentId };
  }
  assertActive(context.signal);
  return deepFreeze({ byCaseId }) as PreparedRegisteredBenchmarkProjections;
}

function assertAdmittedBinding(admitted: AdmittedOfflineBenchmarkInputs, tenantId: string): void {
  if (
    admitted.grant.tenantId !== tenantId ||
    admitted.datasetArtifact.tenantId !== tenantId ||
    admitted.experimentArtifact.tenantId !== tenantId ||
    admitted.request.dataset.artifactId !== admitted.datasetArtifact.artifactId ||
    admitted.request.dataset.digest !== admitted.datasetArtifact.digest ||
    admitted.request.experimentDefinition.artifactId !== admitted.experimentArtifact.artifactId ||
    admitted.request.experimentDefinition.digest !== admitted.experimentArtifact.digest
  ) {
    throw new Error("BENCHMARK_PROJECTION_ADMITTED_BINDING_MISMATCH");
  }
}

function resolveMechanically(input: {
  readonly evidence: {
    readonly fragmentId: string;
    readonly captureId: string;
    readonly projectionArtifactId: string;
    readonly projectionDigest: Digest;
    readonly selector: Parameters<typeof projectionSelectorResolver.resolve>[0]["selector"];
    readonly selectedContentDigest: Digest;
  };
  readonly content: Uint8Array;
  readonly maximumSelectedTextBytes: number;
}): BenchmarkFragmentProjectionResolution {
  let resolution: ReturnType<typeof projectionSelectorResolver.resolve>;
  try {
    resolution = projectionSelectorResolver.resolve({
      captureId: input.evidence.captureId,
      representationArtifactId: input.evidence.projectionArtifactId,
      representationDigest: input.evidence.projectionDigest,
      selector: input.evidence.selector,
      content: input.content,
    });
  } catch {
    return {
      fragmentId: input.evidence.fragmentId,
      captureId: input.evidence.captureId,
      projectionArtifactId: input.evidence.projectionArtifactId,
      projectionDigest: input.evidence.projectionDigest,
      locatorValid: false,
      selectorStatus: "parse_error",
    };
  }
  const locatorValid =
    resolution.resolution.status === "resolved" &&
    resolution.resolution.selectedContentDigest === input.evidence.selectedContentDigest;
  const selectedText = locatorValid
    ? boundedText(resolution.selectedContent, input.maximumSelectedTextBytes)
    : undefined;
  return {
    fragmentId: input.evidence.fragmentId,
    captureId: input.evidence.captureId,
    projectionArtifactId: input.evidence.projectionArtifactId,
    projectionDigest: input.evidence.projectionDigest,
    locatorValid,
    selectorStatus: resolution.resolution.status,
    ...(selectedText === undefined ? {} : { selectedText }),
  };
}

function boundedText(bytes: Uint8Array, maximumBytes: number): string | undefined {
  if (bytes.byteLength > maximumBytes) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function tenant(value: unknown): string {
  const parsed = UuidSchema.safeParse(value);
  if (!parsed.success) throw new Error("BENCHMARK_PROJECTION_CONTEXT_TENANT_INVALID");
  return parsed.data;
}

function selectedTextLimit(value: number | undefined): number {
  const limit = value ?? MAX_SELECTED_TEXT_BYTES;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64 * 1024)
    throw new Error("BENCHMARK_PROJECTION_TEXT_LIMIT_INVALID");
  return limit;
}

function assertActive(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw new Error("BENCHMARK_CANCELLED");
}
