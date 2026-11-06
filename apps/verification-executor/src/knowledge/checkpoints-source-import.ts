import { z } from "zod";
import {
  ImportedSourceDiscoveryReceiptSchema,
  SourceDiscoveryResultSchema,
  type CheckpointScope,
  type VerificationArtifactHandle,
} from "@aiengineer/knowledge-contracts";
import { checkpointScopeId, type SourceDiscoveryApplicationService } from "@aiengineer/knowledge-application";
import { canonicalizeJson, sha256Digest } from "@aiengineer/knowledge-verification";
import type { FilesystemStore } from "../store.js";
import type { ArtifactCustody } from "../store-custody.js";
import {
  findNativeCheckpointAction,
  unwrapNativeCheckpointOutput,
  type NativeCheckpointEvent,
} from "./checkpoints-native.js";

const PROVIDERS: Readonly<Record<string, { provider: string; method: "search" | "map" }>> = {
  tavily__tavily_search: { provider: "tavily", method: "search" },
  tavily__tavily_map: { provider: "tavily", method: "map" },
  firecrawl__firecrawl_search: { provider: "firecrawl", method: "search" },
  firecrawl__firecrawl_map: { provider: "firecrawl", method: "map" },
};
const Row = z
  .object({
    url: z.string().url(),
    title: z.string().optional(),
    content: z.string().optional(),
    description: z.string().optional(),
    requestedUrl: z.string().url().optional(),
    finalUrl: z.string().url().optional(),
    redirectUrls: z.array(z.string().url()).max(32).optional(),
  })
  .passthrough();

export function normalizeExternalCheckpointResults(
  provider: string,
  method: "search" | "map",
  output: Record<string, unknown>,
) {
  let proposed: unknown;
  if (method === "map") proposed = provider === "tavily" ? output.results : output.links;
  else if (provider === "tavily") proposed = output.results;
  else {
    if (output.success === false) throw new Error("EXTERNAL_PROVIDER_FAILED");
    proposed = Array.isArray(output.data)
      ? output.data
      : z.object({ web: z.array(z.unknown()) }).parse(output.data).web;
  }
  const rows = z
    .array(
      z.union([
        Row,
        z
          .string()
          .url()
          .transform((url) => ({ url })),
      ]),
    )
    .max(10000)
    .parse(proposed);
  const seen = new Set<string>();
  return rows.map((raw, index) => {
    const row = Row.parse(raw);
    const finalUrl = row.finalUrl ?? row.url;
    const duplicate = seen.has(finalUrl);
    seen.add(finalUrl);
    return SourceDiscoveryResultSchema.parse({
      rank: index + 1,
      requestedUrl: row.requestedUrl ?? row.url,
      finalUrl,
      redirectUrls: row.redirectUrls ?? [],
      disposition: duplicate ? "duplicate" : "unreviewed",
      sourceClass: "web_page",
      ...(row.title ? { title: row.title.slice(0, 2000) } : {}),
      ...(row.content || row.description ? { snippet: (row.content || row.description)!.slice(0, 16000) } : {}),
      payloadDigest: sha256Digest(canonicalizeJson(raw)),
    });
  });
}

/** Native providers retain self-reported provenance; this does not impersonate a managed dispatch. */
export async function importNativeCheckpointSource(input: {
  scope: CheckpointScope;
  store: FilesystemStore;
  custody: ArtifactCustody;
  sourceDiscovery: SourceDiscoveryApplicationService;
  previousRequiredArtifacts: readonly VerificationArtifactHandle[];
  event: NativeCheckpointEvent;
  observationArtifact: VerificationArtifactHandle;
}): Promise<VerificationArtifactHandle[]> {
  if (input.event.eventType !== "action.result") return [];
  const data = z
    .object({
      status: z.string(),
      result: z.object({
        kind: z.literal("tool-result"),
        callId: z.string(),
        toolName: z.string(),
        output: z.unknown(),
        isError: z.boolean().optional(),
      }),
    })
    .safeParse(input.event.data);
  if (!data.success) return [];
  const result = data.data.result;
  if (!Object.hasOwn(PROVIDERS, result.toolName)) return [];
  const provider = PROVIDERS[result.toolName]!;
  const action = await findNativeCheckpointAction(input, result);
  let state: "succeeded" | "failed" | "uncertain" =
    data.data.status === "completed" && !result.isError ? "succeeded" : "failed";
  let failureCode: string | undefined =
    state === "failed"
      ? data.data.status === "rejected"
        ? "EXTERNAL_TOOL_REJECTED"
        : "EXTERNAL_TOOL_FAILED"
      : undefined;
  let results: ReturnType<typeof normalizeExternalCheckpointResults> = [];
  try {
    const output = unwrapNativeCheckpointOutput(result.output);
    if (state === "succeeded") results = normalizeExternalCheckpointResults(provider.provider, provider.method, output);
  } catch (error) {
    if (state === "succeeded") {
      const providerFailure =
        error instanceof Error && ["EXTERNAL_PROVIDER_FAILED", "CHECKPOINT_NATIVE_TOOL_ERROR"].includes(error.message);
      state = providerFailure ? "failed" : "uncertain";
      failureCode = providerFailure ? "EXTERNAL_TOOL_FAILED" : "EXTERNAL_RECEIPT_UNPARSEABLE";
    }
  }
  const query =
    typeof action.input.query === "string"
      ? action.input.query
      : typeof action.input.url === "string"
        ? action.input.url
        : result.toolName;
  const requestedUrl = z.string().url().safeParse(action.input.url);
  const receipt = ImportedSourceDiscoveryReceiptSchema.parse({
    schemaVersion: "source-discovery-import-receipt.v1",
    idempotencyKey: `checkpoint-source:${checkpointScopeId(input.scope)}:${sha256Digest(result.callId).slice(7)}`,
    providerCode: provider.provider,
    providerVersion: "unspecified",
    queryText: query,
    purpose: "Native discovery output captured by the deterministic checkpoint harness",
    parameters: action.input,
    requestedUrls: requestedUrl.success ? [requestedUrl.data] : [],
    externalAttemptId: result.callId,
    occurredAt: input.observationArtifact.createdAt,
    selfReported: true,
    externalReceiptArtifact: input.observationArtifact,
    rawOutputArtifact: input.observationArtifact,
    state,
    ...(failureCode ? { failureCode } : {}),
    results,
  });
  const attempt = await input.sourceDiscovery.importExternal(input.scope.tenantId, receipt);
  return [
    attempt.requestArtifact,
    attempt.rawOutputArtifact,
    attempt.externalReceiptArtifact,
    attempt.completionArtifact,
  ].filter((value) => value !== undefined);
}
