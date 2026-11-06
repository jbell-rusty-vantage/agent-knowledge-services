import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isKnowledgeError } from "@aiengineer/knowledge-db";
import { z } from "zod";
import type { VerificationExecutor } from "./executor.js";
import type { KnowledgeServices } from "./knowledge/context.js";
import { knowledgeOperations } from "./knowledge/operations.js";
import { registerKnowledgeOperationTools } from "./knowledge-operation/mcp-tools.js";
import type { KnowledgeOperationService } from "@aiengineer/knowledge-host/knowledge-operation";
import { CaptureFragmentInputSchema } from "./knowledge-operation/capture-bridge.js";

/**
 * One MCP tool per executor capture/artifact step (SV-17 retired the verification chain tools; verification runs,
 * claims and seals are served only by ks.knowledge_operation.v2). An optional `runId` logs non-authoritative step
 * receipts in the local working cache.
 * When knowledge services are configured, the `schema_*` / `db_*` / `ingest_*` /
 * `artifact_get` tools are generated from the same operation registry as the CLI and HTTP routes.
 */

const runId = z
  .string()
  .min(1)
  .max(200)
  .describe("Agent-chosen run id; capture steps are logged as non-authoritative step receipts under it.");
const captureId = z.string().min(1).max(255);

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function ok(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

/** Knowledge errors keep `code` and `exit` so remote CLIs reproduce the exit lattice. */
export function errorEnvelope(err: unknown): Record<string, unknown> {
  if (isKnowledgeError(err)) return err.toJSON();
  const message = err instanceof Error ? err.message : String(err);
  const issues = typeof err === "object" && err && "issues" in err ? (err as { issues: unknown }).issues : undefined;
  return { error: message, ...(issues ? { issues, code: "INPUT_INVALID", exit: 1 } : {}) };
}

function error(err: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(errorEnvelope(err), null, 2) }], isError: true };
}

const guard = <T>(fn: () => Promise<T>) => fn().then(ok).catch(error);

export function registerKnowledgeTools(server: McpServer, services: KnowledgeServices): void {
  for (const operation of knowledgeOperations.list()) {
    server.registerTool(
      operation.name,
      { title: operation.title, description: operation.description, inputSchema: operation.input },
      async (input) =>
        guard(async () => {
          const { output } = await knowledgeOperations.invoke(operation.name, input, services);
          const gate = operation.gate?.(output);
          return gate
            ? { ...(output as Record<string, unknown>), qualityGate: { passed: false, reason: gate } }
            : output;
        }),
    );
  }
}

export interface KnowledgeOperationMcpOptions {
  readonly service: KnowledgeOperationService | undefined;
  /** The K07 credential of this MCP request (out of band of tool arguments); `null` refuses every tool. */
  readonly credential: () => string | null;
}

export function createVerificationMcpServer(
  executor: VerificationExecutor,
  knowledge?: KnowledgeServices,
  knowledgeOperation?: KnowledgeOperationMcpOptions,
): McpServer {
  const server = new McpServer({ name: "knowledge-verification-executor", version: "0.1.0" });
  if (knowledge) registerKnowledgeTools(server, knowledge);
  if (knowledgeOperation) {
    registerKnowledgeOperationTools(server, knowledgeOperation.service, knowledgeOperation.credential);
  }

  server.registerTool(
    "verify_capture_source",
    {
      title: "Capture a source",
      description:
        "Fetch a URL (Firecrawl when configured, otherwise HTTPS GET), store the captured text as an immutable content-addressed artifact, and return a captureId plus a preview. Quotes used in intents must be exact substrings of this captured text.",
      inputSchema: {
        url: z.string().url(),
        runId: runId.optional(),
        captureId: captureId.optional().describe("Optional stable id; defaults to a digest-derived id."),
        method: z.enum(["auto", "firecrawl", "https_get"]).optional(),
      },
    },
    async (input) => guard(() => executor.captureSource(input)),
  );

  server.registerTool(
    "verify_capture_file",
    {
      title: "Capture a document you already hold",
      description:
        "Capture bytes instead of a URL: markdown/text/json inline as `text`, or any supported document (pdf, docx, doc, odt, rtf, xlsx, xls, pptx, ppt, epub, csv, html) as `base64`. The executor converts the document to markdown itself (Firecrawl parse) and stores the original bytes beside the text, so the capture is trustworthy evidence. Sandbox files are normally pushed through the HTTP POST /captures route instead of inlining base64.",
      inputSchema: {
        filename: z.string().min(1).max(255).describe("File name with extension; drives media-type detection."),
        text: z.string().min(1).max(4_000_000).optional().describe("UTF-8 content for text-like files."),
        base64: z.string().min(1).max(70_000_000).optional().describe("Base64 bytes for binary documents."),
        mediaType: z.string().min(1).max(120).optional(),
        sourceUri: z
          .string()
          .min(1)
          .max(2000)
          .optional()
          .describe("Where the bytes came from (URL, bucket key, sandbox path)."),
        captureId: captureId.optional(),
        runId: runId.optional(),
      },
    },
    async (input) =>
      guard(async () => {
        if (!input.text && !input.base64) throw new Error("TEXT_OR_BASE64_REQUIRED");
        const bytes = input.base64
          ? new Uint8Array(Buffer.from(input.base64, "base64"))
          : new TextEncoder().encode(input.text!);
        return executor.captureFile({
          bytes,
          filename: input.filename,
          ...(input.mediaType ? { mediaType: input.mediaType } : {}),
          ...(input.sourceUri ? { sourceUri: input.sourceUri } : {}),
          ...(input.captureId ? { captureId: input.captureId } : {}),
          ...(input.runId ? { runId: input.runId } : {}),
        });
      }),
  );

  server.registerTool(
    "verify_supported_media_types",
    {
      title: "Supported capture media types",
      description:
        "List every content type the executor can capture and how each is converted to the text representation quotes are selected from.",
      inputSchema: {},
    },
    async () => guard(async () => executor.supportedMediaTypes()),
  );

  server.registerTool(
    "verify_list_captures",
    {
      title: "List captures",
      description: "List every capture in the store with its digest and size.",
      inputSchema: {},
    },
    async () => guard(() => executor.listCaptures()),
  );

  server.registerTool(
    "verify_read_capture",
    {
      title: "Read captured text",
      description:
        "Read a window of the exact captured text (default 6000 chars, max 20000). Use this to inspect the source before choosing quotes.",
      inputSchema: {
        captureId,
        offset: z.number().int().nonnegative().optional(),
        length: z.number().int().positive().max(20_000).optional(),
        runId: runId.optional(),
      },
    },
    async (input) => guard(() => executor.readCapture(input)),
  );

  server.registerTool(
    "verify_search_capture",
    {
      title: "Search captured text",
      description:
        "Find where a phrase (or the words of a phrase) occurs in a capture. Returns exact substrings with context and their occurrence counts so you can build a unique quote.",
      inputSchema: {
        captureId,
        query: z.string().min(1).max(400),
        limit: z.number().int().positive().max(25).optional(),
        runId: runId.optional(),
      },
    },
    async (input) => guard(() => executor.searchCapture(input)),
  );

  server.registerTool(
    "verify_locate_quote",
    {
      title: "Locate a quote",
      description:
        "Resolve a candidate quote as a text_quote selector on the captured bytes. status=resolved means it occurs exactly once and is safe to put in an intent; ambiguous/not_found include suggestions.",
      inputSchema: { captureId, quote: z.string().min(1).max(4000), runId: runId.optional() },
    },
    async (input) => guard(() => executor.locateQuote(input)),
  );

  server.registerTool(
    "verify_capture_fragment",
    {
      title: "Export an exact captured evidence fragment",
      description:
        "Resolve a unique quote against an exact representation digest and return a research-core.fragment.v2 with original capture custody and acquisition-time provenance. Requires durable artifact custody. Tenant is host-owned; rights are producer-declared and registration/admission remain separate.",
      inputSchema: CaptureFragmentInputSchema,
    },
    async (input) => guard(() => executor.captureFragment(input)),
  );

  server.registerTool(
    "verify_register_artifact",
    {
      title: "Register an artifact",
      description:
        "Store text (an intent file, a report, notes) as a content-addressed artifact and get back its artifactId/digest. Sandbox files are normally pushed via the HTTP /artifacts route instead.",
      inputSchema: {
        text: z.string().min(1).max(2_000_000),
        mediaType: z.string().min(1).max(120).default("application/json"),
        label: z.string().max(80).optional(),
        runId: runId.optional(),
      },
    },
    async (input) =>
      guard(() =>
        executor.registerArtifact({
          bytes: new TextEncoder().encode(input.text),
          mediaType: input.mediaType,
          ...(input.label ? { label: input.label } : {}),
          ...(input.runId ? { runId: input.runId } : {}),
        }),
      ),
  );

  server.registerTool(
    "verify_get_artifact",
    {
      title: "Get artifact",
      description: "Fetch a stored artifact by artifactId or digest (as text, json or just the handle).",
      inputSchema: {
        artifactId: z.string().optional(),
        digest: z.string().optional(),
        as: z.enum(["text", "json", "handle"]).optional(),
      },
    },
    async (input) => guard(() => executor.artifact(input)),
  );

  return server;
}
