import { beginExecutorStateMutation } from "./checkpoint-state-fence.js";
import { canonicalizeJson, digestCanonicalJson } from "@aiengineer/knowledge-verification";
import {
  captureFile,
  captureSource,
  SUPPORTED_MEDIA_TYPES,
  type CaptureFileInput,
  type CaptureInput,
  type CaptureOutcome,
} from "./capture.js";
import { countOccurrences, loadCaptureContent, locateQuote, searchContent } from "./locate.js";
import { deterministicUuid, FilesystemStore } from "./store.js";
import {
  captureFragment,
  CaptureFragmentInputSchema,
  type CaptureFragmentInput,
} from "./knowledge-operation/capture-bridge.js";

/**
 * The executor's capture and artifact tools (knowledge-verify capture/locate/artifact). SV-17 retired its verification
 * chain (claims, extraction, semantic judge, policy, seal, report check, run status): the verification component and
 * ks.knowledge_operation.v2 are the only run, claims and seal authority. The file store is a non-authoritative
 * working cache of captured bytes and capture step receipts.
 */
export const EXECUTOR_VERSION = "knowledge-verification-executor.v1";
const ACTIVITY = "verification-executor";

export interface ExecutorConfig {
  readonly storeDir: string;
  readonly tenantId: string;
  /** Agent deployment identities the canonical producer/verifier attempts must carry (scoped custody host). */
  readonly producerDeploymentId: string;
  readonly verifierDeploymentId: string;
  readonly producerAttemptId?: string;
  readonly verifierAttemptId?: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** Retired SV-17 verification-chain settings; refused at startup so a stale deployment cannot silently degrade. */
const RETIRED_EXECUTOR_SETTINGS = [
  "VERIFY_JUDGE_MODEL",
  "VERIFY_CROSS_FAMILY_JUDGE_MODEL",
  "VERIFY_PRINCIPAL_SALT",
  "KNOWLEDGE_EVIDENCE_ORACLE",
  "KNOWLEDGE_RECOVERY_CONFIG_JSON",
  "KNOWLEDGE_REPORT_ASSESSMENT_PINS_JSON",
  "KNOWLEDGE_CONTENT_LINKS_ENABLED",
  "KNOWLEDGE_EVIDENCE_POLICY_VERSION",
  "KNOWLEDGE_EVIDENCE_POLICY_DIGEST",
] as const;

export function loadExecutorConfig(env: Readonly<Record<string, string | undefined>> = process.env): ExecutorConfig {
  for (const name of RETIRED_EXECUTOR_SETTINGS)
    if (env[name]?.trim() && env[name]?.trim() !== "0") throw new Error(`EXECUTOR_RETIRED_CONFIGURATION:${name}`);
  const producerAttemptId = env.VERIFY_PRODUCER_ATTEMPT_ID?.trim();
  const verifierAttemptId = env.VERIFY_VERIFIER_ATTEMPT_ID?.trim();
  if (
    (producerAttemptId || verifierAttemptId) &&
    (!isCanonicalUuid(producerAttemptId) ||
      !isCanonicalUuid(verifierAttemptId) ||
      producerAttemptId === verifierAttemptId)
  ) {
    throw new Error("VERIFICATION_DISTINCT_CANONICAL_ATTEMPTS_REQUIRED");
  }
  return {
    storeDir: env.VERIFY_STORE_DIR?.trim() || ".verification-store",
    tenantId: env.VERIFY_TENANT_ID?.trim() || deterministicUuid("tenant", "verification-executor-local"),
    producerDeploymentId: env.VERIFY_PRODUCER_DEPLOYMENT_ID?.trim() || "eve-research-producer",
    verifierDeploymentId: env.VERIFY_VERIFIER_DEPLOYMENT_ID?.trim() || "knowledge-verification-executor",
    ...(producerAttemptId ? { producerAttemptId } : {}),
    ...(verifierAttemptId ? { verifierAttemptId } : {}),
    env,
  };
}

const isCanonicalUuid = (value: string | undefined): value is string =>
  typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

export class VerificationExecutor {
  readonly store: FilesystemStore;
  readonly config: ExecutorConfig;

  private constructor(store: FilesystemStore, config: ExecutorConfig) {
    this.store = store;
    this.config = config;
  }

  static async create(config: ExecutorConfig = loadExecutorConfig()): Promise<VerificationExecutor> {
    if (
      (config.producerAttemptId || config.verifierAttemptId) &&
      (!isCanonicalUuid(config.producerAttemptId) ||
        !isCanonicalUuid(config.verifierAttemptId) ||
        config.producerAttemptId === config.verifierAttemptId)
    )
      throw new Error("VERIFICATION_DISTINCT_CANONICAL_ATTEMPTS_REQUIRED");
    const store = new FilesystemStore(config.storeDir, config.tenantId);
    await store.init();
    return new VerificationExecutor(store, config);
  }

  // ---- step receipts -----------------------------------------------------------

  private async step<T>(
    runId: string | undefined,
    operation: string,
    input: unknown,
    fn: () => Promise<T>,
    summarize: (output: T) => unknown = (output) => output,
  ): Promise<T> {
    if (this.config.producerAttemptId && runId !== undefined && !isCanonicalUuid(runId))
      throw new Error("VERIFICATION_CANONICAL_RUN_ID_REQUIRED");
    const releaseState = beginExecutorStateMutation(this.store, runId);
    const startedAt = new Date().toISOString();
    try {
      const output = await fn();
      if (runId)
        await this.store.appendStep({
          runId,
          operation,
          startedAt,
          completedAt: new Date().toISOString(),
          status: "succeeded",
          input,
          output: summarize(output),
        });
      return output;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (runId)
        await this.store.appendStep({
          runId,
          operation,
          startedAt,
          completedAt: new Date().toISOString(),
          status: "failed",
          input,
          output: null,
          error: message,
        });
      throw error;
    } finally {
      releaseState();
    }
  }

  // ---- capture / locate ----------------------------------------------------------

  private async recordCapture(outcome: CaptureOutcome, runId: string | undefined) {
    if (runId) {
      const state = await this.store.readRun(runId);
      state.captureIds = [...new Set([...(state.captureIds ?? []), outcome.record.captureId])];
      await this.store.writeRun(state);
    }
    return {
      captureId: outcome.record.captureId,
      sourceId: outcome.record.sourceId,
      requestedUrl: outcome.record.requestedUrl,
      finalUrl: outcome.record.finalUrl,
      title: outcome.record.title,
      capturedAt: outcome.record.capturedAt,
      captureMethod: outcome.record.captureMethod,
      sourceKind: outcome.record.sourceKind,
      characters: outcome.record.characters,
      contentArtifact: {
        artifactId: outcome.record.contentArtifact.artifactId,
        digest: outcome.record.contentArtifact.digest,
        byteLength: outcome.record.contentArtifact.byteLength,
      },
      ...(outcome.record.originalArtifact
        ? {
            originalArtifact: {
              artifactId: outcome.record.originalArtifact.artifactId,
              digest: outcome.record.originalArtifact.digest,
              byteLength: outcome.record.originalArtifact.byteLength,
              mediaType: outcome.record.originalArtifact.mediaType,
            },
          }
        : {}),
      reused: outcome.reused,
      preview: outcome.content.slice(0, 1200),
    };
  }

  async captureSource(input: CaptureInput) {
    return this.step(
      input.runId,
      "capture_source",
      { url: input.url, method: input.method ?? "auto", captureId: input.captureId },
      async () => this.recordCapture(await captureSource(this.store, input, this.config.env), input.runId),
    );
  }

  /** Capture bytes the caller already holds (sandbox file, upload). Text conversion happens here, never in the agent. */
  async captureFile(input: CaptureFileInput) {
    return this.step(
      input.runId,
      "capture_file",
      {
        filename: input.filename,
        mediaType: input.mediaType,
        sourceUri: input.sourceUri,
        captureId: input.captureId,
        byteLength: input.bytes.byteLength,
      },
      async () => this.recordCapture(await captureFile(this.store, input, this.config.env), input.runId),
    );
  }

  supportedMediaTypes() {
    return Object.entries(SUPPORTED_MEDIA_TYPES).map(([mediaType, spec]) => ({
      mediaType,
      kind: spec.kind,
      extensions: spec.extensions,
      conversion:
        spec.kind === "text"
          ? "utf-8 decode"
          : spec.kind === "html"
            ? "tag strip (executor)"
            : "firecrawl /v2/parse → markdown",
    }));
  }

  async listCaptures() {
    const records = await this.store.listCaptures();
    return records.map((record) => ({
      captureId: record.captureId,
      url: record.finalUrl,
      title: record.title,
      characters: record.characters,
      capturedAt: record.capturedAt,
      digest: record.contentArtifact.digest,
    }));
  }

  async readCapture(input: { captureId: string; offset?: number; length?: number; runId?: string }) {
    const { record, content } = await loadCaptureContent(this.store, input.captureId);
    const offset = Math.max(0, input.offset ?? 0);
    const length = Math.min(Math.max(1, input.length ?? 6000), 20_000);
    return {
      captureId: record.captureId,
      offset,
      length: Math.min(length, Math.max(0, content.length - offset)),
      totalCharacters: content.length,
      text: content.slice(offset, offset + length),
      hasMore: offset + length < content.length,
    };
  }

  async searchCapture(input: { captureId: string; query: string; limit?: number; runId?: string }) {
    return this.step(
      input.runId,
      "search_capture",
      input,
      async () => {
        const { record, content } = await loadCaptureContent(this.store, input.captureId);
        const hits = searchContent(content, input.query, input.limit ?? 8);
        return {
          captureId: record.captureId,
          query: input.query,
          hits: hits.map((hit) => ({ ...hit, occurrenceCount: countOccurrences(content, hit.exact) })),
        };
      },
      (output) => ({ captureId: output.captureId, query: output.query, hitCount: output.hits.length }),
    );
  }

  async locateQuote(input: { captureId: string; quote: string; runId?: string }) {
    return this.step(
      input.runId,
      "locate_quote",
      { captureId: input.captureId, quote: input.quote },
      async () => {
        const { record, content } = await loadCaptureContent(this.store, input.captureId);
        return locateQuote(record, content, input.quote);
      },
      (output) => ({
        captureId: output.captureId,
        quote: output.quote,
        status: output.status,
        occurrenceCount: output.occurrenceCount,
        selectedContentDigest: output.selectedContentDigest,
      }),
    );
  }

  // ---- artifact registration -------------------------------------------------------

  /** Exact producer assistance. Tenant comes from the executor; K01 separately authorizes the target binding. */
  async captureFragment(input: CaptureFragmentInput, runId?: string) {
    const request = CaptureFragmentInputSchema.parse(input);
    return this.step(
      runId,
      "capture_fragment",
      request,
      () => captureFragment(this.store, { tenant: this.store.tenantId, binding: request.binding }, request),
      (output) => ({ fragment: output.fragment, provenance: output.provenance }),
    );
  }

  async registerArtifact(input: {
    bytes: Uint8Array;
    mediaType: string;
    label?: string;
    runId?: string;
    dataClassification?: "public" | "internal" | "confidential" | "restricted";
  }) {
    return this.step(
      input.runId,
      "register_artifact",
      { mediaType: input.mediaType, label: input.label, byteLength: input.bytes.byteLength },
      async () => {
        const handle = await this.store.put({
          bytes: input.bytes,
          mediaType: input.mediaType,
          producerActivityId: `${ACTIVITY}:register${input.label ? `:${input.label}` : ""}`,
          producerVersion: EXECUTOR_VERSION,
          ...(input.dataClassification ? { dataClassification: input.dataClassification } : {}),
        });
        return {
          artifactId: handle.artifactId,
          digest: handle.digest,
          byteLength: handle.byteLength,
          mediaType: handle.mediaType,
          objectKey: handle.objectKey,
        };
      },
    );
  }

  async artifact(input: { artifactId?: string; digest?: string; as?: "text" | "json" | "handle" }) {
    const handle = await this.store.resolveHandle(input);
    if (input.as === "handle") return { handle };
    const text = await this.store.text(handle);
    return { handle, content: input.as === "json" ? JSON.parse(text) : text };
  }
}

export { canonicalizeJson, digestCanonicalJson };
