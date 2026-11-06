import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { KnowledgeClient, KnowledgeClientError } from "@aiengineer/knowledge-client";
import {
  type CaptureSourceRequest,
  type VerificationCaptureTerminalResource,
  type VerificationProfileCaptureAccepted,
} from "@aiengineer/knowledge-contracts";
import {
  loadDiagnosticsOfflineCatalog,
  prepareDiagnosticsBenchmarkRefreshProposal,
} from "@aiengineer/knowledge-application";
import { digestCanonicalJson } from "@aiengineer/knowledge-verification";

const DEFAULT_OUTPUT = ".knowledge/benchmark-proposals/diagnostics-companies-v2";
const DEFAULT_PROFILE = "diagnostics-companies";
const MAX_SOURCE_TIMEOUT_MS = 60_000;
const MIN_TIMEOUT_MS = 100;

export interface BenchmarkCaptureArguments {
  readonly profile: string;
  readonly outputDirectory: string;
  readonly baseUrl?: string;
  readonly timeoutMs: number;
}

export interface BenchmarkCaptureSourceOutcome {
  readonly sourceKey: string;
  readonly sourceUri: string;
  readonly state: "succeeded" | "unavailable";
  readonly failureStage?: "submit" | "poll";
  readonly code?: string;
  /** Present only when server acceptance succeeded but no terminal capture was read. */
  readonly pendingOperationId?: string;
  readonly capture?: VerificationCaptureTerminalResource;
}

export interface BenchmarkRefreshProposalWriter {
  writeBenchmarkRefreshProposal(input: {
    readonly outputDirectory: string;
    readonly proposal: ReturnType<typeof prepareDiagnosticsBenchmarkRefreshProposal>;
    readonly sourceOutcomes: readonly BenchmarkCaptureSourceOutcome[];
  }): Promise<{
    readonly outputDirectory: string;
    readonly manifestDigest: string;
    readonly files: readonly BenchmarkCaptureOutputFile[];
  }>;
}

export interface BenchmarkCaptureOutputFile {
  readonly name: "proposal.json" | "source-outcomes.json";
  readonly digest: `sha256:${string}`;
  readonly bytes: number;
}

export interface BenchmarkCaptureClient {
  captureVerificationSourceWithProfile(
    profileName: string,
    request: CaptureSourceRequest,
    context: { readonly correlationId: string; readonly idempotencyKey: string },
  ): Promise<VerificationProfileCaptureAccepted>;
  getVerificationCaptureResult(
    operationId: string,
    context: { readonly tenantId: string; readonly correlationId: string },
  ): Promise<VerificationCaptureTerminalResource>;
}

export interface RunDiagnosticsBenchmarkCaptureOptions {
  readonly writer: BenchmarkRefreshProposalWriter;
  readonly client?: BenchmarkCaptureClient;
  readonly catalogDirectory?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

function validateBaseUrl(value: string): string {
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) throw new Error();
  } catch {
    throw new Error("BENCHMARK_CAPTURE_BASE_URL_INVALID");
  }
  return value;
}

/** Strictly parses the installed live refresh command; no arbitrary source or profile input is admitted. */
export function parseDiagnosticsBenchmarkCaptureArgs(args: readonly string[]): BenchmarkCaptureArguments {
  if (args[0] !== "benchmark" || args[1] !== "capture" || args[2] !== "diagnostics-companies") {
    throw new Error("BENCHMARK_CAPTURE_COMMAND_INVALID");
  }
  const values = new Map<string, string>();
  for (let index = 3; index < args.length; index += 1) {
    const name = args[index]!;
    if (
      !new Set(["--propose-version", "--output", "--profile", "--base-url", "--timeout-ms"]).has(name) ||
      values.has(name) ||
      !args[index + 1] ||
      args[index + 1]!.startsWith("--")
    ) {
      throw new Error("BENCHMARK_CAPTURE_OPTION_INVALID");
    }
    values.set(name, args[++index]!);
  }
  if (values.get("--propose-version") !== "diagnostics-companies-v2")
    throw new Error("BENCHMARK_CAPTURE_PROPOSED_VERSION_INVALID");
  const profile = values.get("--profile") ?? DEFAULT_PROFILE;
  if (profile !== DEFAULT_PROFILE) throw new Error("BENCHMARK_CAPTURE_PROFILE_INVALID");
  const output = values.get("--output") ?? DEFAULT_OUTPUT;
  if (!output.trim()) throw new Error("BENCHMARK_CAPTURE_OUTPUT_INVALID");
  const baseUrl = values.get("--base-url");
  if (baseUrl !== undefined) {
    validateBaseUrl(baseUrl);
  }
  const timeoutMs = Number(values.get("--timeout-ms") ?? "60000");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_SOURCE_TIMEOUT_MS) {
    throw new Error("BENCHMARK_CAPTURE_TIMEOUT_INVALID");
  }
  return { profile, outputDirectory: resolve(output), ...(baseUrl ? { baseUrl } : {}), timeoutMs };
}

const defaultSleep = async (milliseconds: number) =>
  new Promise<void>((resolvePromise) => setTimeout(resolvePromise, milliseconds));
const safeCode = (error: unknown): string => {
  if (error instanceof KnowledgeClientError) return error.problem.code;
  return "CLIENT_FAILURE";
};
const isPending = (error: unknown): boolean => error instanceof KnowledgeClientError && error.problem.status === 409;
const sourceRequest = (sourceKey: string, sourceUri: string): CaptureSourceRequest =>
  sourceKey === "tru-sample-report"
    ? {
        verificationContractVersion: "verification.v1",
        source: { mode: "acquire", sourceKind: "pdf", sourceUri },
        requestedProjectionKinds: ["pdf_text", "geometry"],
      }
    : {
        verificationContractVersion: "verification.v1",
        source: { mode: "acquire", sourceKind: "web_page", sourceUri },
        requestedProjectionKinds: ["html_dom"],
      };

/** A cheap preflight only; the writer retains the race-safe final lock. */
async function assertOutputAbsent(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  throw new Error("BENCHMARK_CAPTURE_OUTPUT_EXISTS");
}

async function awaitCapture(
  client: BenchmarkCaptureClient,
  operationId: string,
  tenantId: string,
  correlationId: string,
  deadline: number,
  now: () => number,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<{ readonly capture?: VerificationCaptureTerminalResource; readonly code?: string }> {
  while (now() < deadline) {
    try {
      return { capture: await client.getVerificationCaptureResult(operationId, { tenantId, correlationId }) };
    } catch (error) {
      if (!isPending(error)) return { code: safeCode(error) };
      const remaining = deadline - now();
      if (remaining <= 0) break;
      await sleep(Math.min(250, remaining));
    }
  }
  return { code: "DEADLINE_EXCEEDED" };
}

/**
 * Sequentially invokes the server-owned diagnostics profile for all pinned v1
 * sources. It neither creates source authority nor turns failed captures into
 * selectors, labels, or a frozen benchmark dataset.
 */
export async function runDiagnosticsBenchmarkCapture(
  args: readonly string[],
  options: RunDiagnosticsBenchmarkCaptureOptions,
) {
  const parsed = parseDiagnosticsBenchmarkCaptureArgs(args);
  const environment = options.environment ?? process.env;
  const baseUrl = parsed.baseUrl ?? environment.KNOWLEDGE_API_URL;
  const token = environment.KNOWLEDGE_API_TOKEN;
  // The loop is deliberately sequential, so the real transport can use one
  // active source signal without coupling unrelated source attempts.
  let activeSignal: AbortSignal | undefined;
  const client =
    options.client ??
    (() => {
      if (!baseUrl) throw new Error("KNOWLEDGE_API_URL_REQUIRED");
      if (!token) throw new Error("KNOWLEDGE_API_TOKEN_REQUIRED");
      return new KnowledgeClient({
        baseUrl: validateBaseUrl(baseUrl),
        getAccessToken: () => token,
        fetch: (url, init) => {
          const signal = activeSignal ?? init?.signal;
          return signal === undefined ? fetch(url, init) : fetch(url, { ...init, signal });
        },
      });
    })();
  const catalogDirectory =
    options.catalogDirectory ??
    fileURLToPath(new URL("./demo-assets/catalog/diagnostics-companies-v1/", import.meta.url));
  const catalog = await loadDiagnosticsOfflineCatalog("diagnostics-companies-v1", catalogDirectory);
  const ledgerBytes = catalog.files.get("source-ledger.json");
  if (!ledgerBytes) throw new Error("BENCHMARK_CAPTURE_LEDGER_MISSING");
  const ledger = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(ledgerBytes));
  await assertOutputAbsent(parsed.outputDirectory);
  const now = options.now ?? Date.now,
    sleep = options.sleep ?? defaultSleep;
  const outcomes: BenchmarkCaptureSourceOutcome[] = [];
  let tenantId: string | undefined;

  for (const source of ledger.sources as readonly { sourceKey: string; url: string }[]) {
    const correlationId = `benchmark-capture:${source.sourceKey}:${randomUUID()}`;
    const deadline = now() + parsed.timeoutMs;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), parsed.timeoutMs);
    try {
      activeSignal = controller.signal;
      let accepted: VerificationProfileCaptureAccepted;
      try {
        accepted = await client.captureVerificationSourceWithProfile(
          parsed.profile,
          sourceRequest(source.sourceKey, source.url),
          {
            correlationId,
            idempotencyKey: `benchmark-capture-${randomUUID()}`,
          },
        );
      } catch (error) {
        outcomes.push({
          sourceKey: source.sourceKey,
          sourceUri: source.url,
          state: "unavailable",
          failureStage: "submit",
          code: controller.signal.aborted ? "DEADLINE_EXCEEDED" : safeCode(error),
        });
        continue;
      }
      if (tenantId === undefined) tenantId = accepted.tenantId;
      else if (tenantId !== accepted.tenantId) throw new Error("BENCHMARK_CAPTURE_TENANT_MISMATCH");
      const result = await awaitCapture(
        client,
        accepted.operation.operationId,
        tenantId,
        correlationId,
        deadline,
        now,
        sleep,
      );
      if (!result.capture) {
        outcomes.push({
          sourceKey: source.sourceKey,
          sourceUri: source.url,
          state: "unavailable",
          failureStage: "poll",
          code: result.code!,
          pendingOperationId: accepted.operation.operationId,
        });
        continue;
      }
      if (result.capture.operationId !== accepted.operation.operationId)
        throw new Error("BENCHMARK_CAPTURE_OPERATION_MISMATCH");
      if (result.capture.tenantId !== tenantId) throw new Error("BENCHMARK_CAPTURE_TENANT_MISMATCH");
      outcomes.push({
        sourceKey: source.sourceKey,
        sourceUri: source.url,
        state: "succeeded",
        capture: result.capture,
      });
    } finally {
      clearTimeout(timeout);
      activeSignal = undefined;
    }
  }
  if (!tenantId) throw new Error("BENCHMARK_CAPTURE_TENANT_UNAVAILABLE");
  const proposal = prepareDiagnosticsBenchmarkRefreshProposal({
    tenantId,
    baselineDataset: catalog.dataset,
    baselineSourceLedger: ledger,
    baselineCatalogManifestDigest: catalog.catalogManifestDigest,
    baselineSourceLedgerCanonicalDigest: digestCanonicalJson(ledger),
    authenticatedCaptureOutcomes: outcomes.map((item) =>
      item.state === "succeeded"
        ? { sourceKey: item.sourceKey, state: "succeeded", capture: item.capture! }
        : { sourceKey: item.sourceKey, state: "unavailable", unavailableCode: item.code ?? "CAPTURE_UNAVAILABLE" },
    ),
  });
  const written = await options.writer.writeBenchmarkRefreshProposal({
    outputDirectory: parsed.outputDirectory,
    proposal,
    sourceOutcomes: outcomes,
  });
  const unavailable = outcomes.some((item) => item.state === "unavailable");
  return Object.freeze({
    command: "benchmark capture" as const,
    status: unavailable ? ("refresh_incomplete" as const) : ("proposed_review_required" as const),
    exitCode: unavailable ? (2 as const) : (0 as const),
    profile: parsed.profile,
    tenantId,
    proposal,
    sourceOutcomes: Object.freeze(outcomes),
    ...written,
  });
}
