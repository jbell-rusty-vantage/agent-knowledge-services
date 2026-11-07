import { readFile, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { basename, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { mediaTypeForFilename } from "./capture.js";
import { loadExecutorConfig, VerificationExecutor } from "./executor.js";
import { createVerificationMcpServer } from "./mcp.js";
import { RemoteExecutor, RemoteExecutorError } from "./remote.js";
import { parseReviewerGrant, provisionReviewerGrant } from "./reviewer-grant.js";
import { createKnowledgeFromEnv, describeRunning, startExecutorServer } from "./serve.js";

export * from "./executor.js";
export * from "./store.js";
export { createVerificationMcpServer, registerKnowledgeTools } from "./mcp.js";
export { createHttpServer } from "./http.js";
export { RemoteExecutor, RemoteExecutorError } from "./remote.js";
export { SUPPORTED_MEDIA_TYPES, mediaTypeForFilename } from "./capture.js";
export { KNOWLEDGE_BACKENDS, startExecutorServer, createKnowledgeFromEnv } from "./serve.js";
export { knowledgeOperations } from "./knowledge/operations.js";
export { createKnowledgeServices, loadKnowledgeConfig, KNOWLEDGE_EXECUTOR_VERSION } from "./knowledge/context.js";
export { defineOperation, OperationRegistry } from "./operations/define.js";
export { createKnowledgeOperationSurfaceFromEnv } from "@aiengineer/knowledge-host/knowledge-operation";
export { KnowledgeOperationService } from "@aiengineer/knowledge-host/knowledge-operation";
export { KnowledgeCredentialVerifier, loadKnowledgeAuthConfig } from "@aiengineer/knowledge-host/knowledge-operation";

const HELP = `knowledge-verify — capture and artifact executor (the verification chain is retired; see ks.knowledge_operation.v2)

Usage: knowledge-verify <command> [options]

Modes
  local   (default)            run against the filesystem store in VERIFY_STORE_DIR
  remote  VERIFY_EXECUTOR_URL  forward every command to a running \`knowledge-verify serve\`
                               (or pass --remote <url>; --token / VERIFY_EXECUTOR_TOKEN for bearer auth)

Serving
  serve [--port 4310] [--host 127.0.0.1]     HTTP: /mcp (Streamable HTTP MCP), /artifacts, /captures, /health,
                                             /knowledge/:operation (schema_*, db_*, ingest_*, artifact_get when KS_AIENG_DB_RUNTIME_DSN is set)
                                             /knowledge-operation/v2/* (K01 v2 + K07 issuer credential, when KS_KNOWLEDGE_ISSUER is set)
  mcp-stdio                                  MCP over stdio (for local agent harnesses)
  health                                     remote: GET /health; local: store info
  (the sibling \`knowledge\` binary drives the schema / db / ingest operations; \`knowledge help\`)

Capture (evidence enters the system only here)
  capture <url> --run <runId> --capture-id <id> [--method auto|firecrawl|https_get]
                                             html → markdown; pdf/docx/xlsx/pptx/csv/… behind a URL → parsed to markdown
  capture-file <path> --run <runId> --capture-id <id> [--source-uri <uri>] [--media-type <type>]
                                             a document you already hold (pdf, docx, doc, odt, rtf, xlsx, xls, pptx, ppt, epub,
                                             csv, html, md, txt, json); the executor converts it, never the agent
  media-types                                every capturable content type and how it is converted
  captures                                   list captures in the store

Inspect / locate (read-only)
  read <captureId> [--offset N] [--length N]
  search <captureId> <query> [--limit N]
  locate <captureId> <quote>                 exit 0 only when status=resolved (exactly one occurrence)
  fragment <captureId> <quote> --id <id> --binding <binding> --digest <sha256:...> --rights <public|licensed|restricted|private>

Artifacts
  register <file> --label <label> --run <runId> [--media-type <type>]
  artifact <artifactId|sha256:...> [--as text|json|handle]

Reviewer grants (OVE-169 W1)
  grant-reviewer --database-url-env <ENV NAME> --tenant <uuid> --reviewer <id> --granted-by <id>
                 --uses <names> --audiences <names> --report-kinds <names> [--allow-wildcard]
                                             one live knowledge_verification reviewer grant (report.review refuses
                                             reviewer_not_qualified without one); idempotent per reviewer + exact
                                             scope; * only with --allow-wildcard; granted_at = database now(); the
                                             DSN is read from the named variable, never printed. Independence is
                                             KS's check at review time: the run's producer is refused
                                             (reviewer_is_producer) even with a grant

Retired (SV-17)
  verify-claims, verify-extraction, judge, policy, seal, check-report and status are retired with the
  executor's file-store run truth. Register and assess reports, read exact packages and apply admitted effects
  through ks.knowledge_operation.v2 (/knowledge-operation/v2/*, MCP knowledge_operation_*).

Output
  Every command prints exactly one JSON document to stdout.
  --out <file>   also write that JSON to <file> and print a compact summary instead (keeps agent context small)

Exit codes
  0  command succeeded and its quality gate passed (see per-command notes above)
  1  command succeeded but the quality gate did not pass — read the JSON, fix the intent/quote, re-run
  2  usage, network, auth, or executor error (JSON with "error" on stderr)

Environment
  VERIFY_EXECUTOR_URL  VERIFY_EXECUTOR_TOKEN                      remote mode
  VERIFY_STORE_DIR (default .verification-store; a non-authoritative capture cache)  VERIFY_TENANT_ID
  FIRECRAWL_API_KEY (capture + document parsing)
  KS_KNOWLEDGE_ISSUER  KS_KNOWLEDGE_AUDIENCE  KS_KNOWLEDGE_JWKS_FILE | KS_KNOWLEDGE_JWKS_URL  KS_KNOWLEDGE_BINDINGS_JSON
  KS_KNOWLEDGE_AUDITOR_SCRIPT_FILE  KS_KNOWLEDGE_SEAL_KEY_ID  KS_KNOWLEDGE_SEAL_KEY_FILE  (knowledge-operation v2)`;

interface Parsed {
  command: string;
  positionals: string[];
  flags: Record<string, string | true>;
}

function parseArgs(argv: string[]): Parsed {
  const [command = "help", ...rest] = argv;
  const positionals: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index]!;
    if (item.startsWith("--")) {
      const key = item.slice(2);
      const next = rest[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        index += 1;
      } else flags[key] = true;
    } else positionals.push(item);
  }
  return { command, positionals, flags };
}

const str = (value: string | true | undefined): string | undefined => (typeof value === "string" ? value : undefined);
const num = (value: string | true | undefined): number | undefined =>
  typeof value === "string" ? Number(value) : undefined;
const need = (value: string | undefined, name: string): string => {
  if (!value) throw new UsageError(`${name} is required`);
  return value;
};

class UsageError extends Error {
  override name = "UsageError";
}
class QualityGateError extends Error {
  override name = "QualityGateError";
  constructor(
    readonly payload: unknown,
    readonly reason: string,
  ) {
    super(reason);
  }
}

function artifactMediaTypeFor(path: string, override?: string): string {
  if (override) return override;
  const ext = extname(path).toLowerCase();
  return ext === ".json"
    ? "application/json"
    : ext === ".md"
      ? "text/markdown; charset=utf-8"
      : ext === ".txt"
        ? "text/plain; charset=utf-8"
        : "application/octet-stream";
}

// ---- backends -------------------------------------------------------------------------------

interface Backend {
  readonly mode: "local" | "remote";
  call(operation: string, args: Record<string, unknown>): Promise<unknown>;
  registerBytes(input: { bytes: Uint8Array; mediaType: string; label?: string; runId?: string }): Promise<unknown>;
  captureBytes(input: {
    bytes: Uint8Array;
    filename: string;
    mediaType?: string;
    sourceUri?: string;
    captureId?: string;
    runId?: string;
  }): Promise<unknown>;
  artifact(id: string, as: "text" | "json" | "handle" | undefined): Promise<unknown>;
  health(): Promise<unknown>;
  listCaptures(): Promise<unknown>;
  mediaTypes(): Promise<unknown>;
}

function localBackend(executor: VerificationExecutor): Backend {
  const table: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
    verify_capture_source: (args) => executor.captureSource(args as never),
    verify_read_capture: (args) => executor.readCapture(args as never),
    verify_search_capture: (args) => executor.searchCapture(args as never),
    verify_locate_quote: (args) => executor.locateQuote(args as never),
    verify_capture_fragment: (args) => executor.captureFragment(args as never),
  };
  return {
    mode: "local",
    call: (operation, args) => {
      const fn = table[operation];
      if (!fn) throw new UsageError(`unknown operation ${operation}`);
      return fn(args);
    },
    registerBytes: (input) => executor.registerArtifact(input),
    captureBytes: (input) => executor.captureFile(input),
    artifact: (id, as) =>
      executor.artifact({ ...(id.startsWith("sha256:") ? { digest: id } : { artifactId: id }), ...(as ? { as } : {}) }),
    health: async () => ({
      status: "ok",
      mode: "local",
      store: executor.store.rootDir,
      tenantId: executor.store.tenantId,
    }),
    listCaptures: () => executor.listCaptures(),
    mediaTypes: async () => executor.supportedMediaTypes(),
  };
}

function remoteBackend(remote: RemoteExecutor): Backend {
  return {
    mode: "remote",
    call: (operation, args) => remote.tool(operation, args),
    registerBytes: (input) => remote.registerBytes(input),
    captureBytes: (input) => remote.captureBytes(input),
    artifact: (id, as) => remote.artifact(id, as ?? "json"),
    health: () => remote.health(),
    listCaptures: () => remote.listCaptures(),
    mediaTypes: () => remote.mediaTypes(),
  };
}

// ---- quality gates ------------------------------------------------------------------------

function qualityGate(command: string, output: unknown): string | undefined {
  const value = (output ?? {}) as Record<string, unknown>;
  switch (command) {
    case "locate":
      return value.status === "resolved"
        ? undefined
        : `locate status=${String(value.status)} occurrenceCount=${String(value.occurrenceCount)}`;
    default:
      return undefined;
  }
}

function summarize(output: unknown): unknown {
  if (!output || typeof output !== "object" || Array.isArray(output)) return output;
  const summary: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(output as Record<string, unknown>)) {
    if (value === null || ["string", "number", "boolean"].includes(typeof value))
      summary[key] =
        typeof value === "string" && value.length > 200 ? `${value.slice(0, 200)}… (${value.length} chars)` : value;
    else if (Array.isArray(value)) summary[key] = `[${value.length} items]`;
    else if (typeof value === "object" && "artifactId" in (value as object)) summary[key] = value;
    else summary[key] = "{…}";
  }
  return summary;
}

// ---- main -----------------------------------------------------------------------------------

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { command, positionals, flags } = parseArgs(argv);
  if (command === "help" || command === "--help" || command === "-h") {
    console.log(HELP);
    return;
  }

  const remoteUrl = str(flags.remote) ?? process.env.VERIFY_EXECUTOR_URL?.trim();
  const token = str(flags.token) ?? process.env.VERIFY_EXECUTOR_TOKEN?.trim();
  const run = str(flags.run);
  const out = str(flags.out);

  const emit = async (value: unknown) => {
    const text = JSON.stringify(value, null, 2);
    if (out) {
      await writeFile(out, `${text}\n`, "utf8");
      process.stdout.write(`${JSON.stringify({ ...(summarize(value) as object), writtenTo: out }, null, 2)}\n`);
    } else process.stdout.write(`${text}\n`);
  };

  if (command === "grant-reviewer") {
    await emit(await provisionReviewerGrant(parseReviewerGrant(flags), process.env));
    return;
  }
  if (command === "mcp-stdio") {
    const executor = await VerificationExecutor.create(loadExecutorConfig());
    await createVerificationMcpServer(executor, await createKnowledgeFromEnv(process.env, executor)).connect(
      new StdioServerTransport(),
    );
    return;
  }
  if (command === "serve") {
    const port = num(flags.port) ?? Number(process.env.VERIFY_PORT ?? 4310);
    const host = str(flags.host) ?? process.env.VERIFY_HOST ?? "127.0.0.1";
    const running = await startExecutorServer({ port, host, ...(token ? { token } : {}) });
    console.error(JSON.stringify(describeRunning(running, token ? "bearer" : "none")));
    await new Promise<void>((resolve) => {
      process.on("SIGINT", () => void running.close().then(resolve));
      process.on("SIGTERM", () => void running.close().then(resolve));
    });
    return;
  }

  const backend: Backend = remoteUrl
    ? remoteBackend(new RemoteExecutor({ baseUrl: remoteUrl, ...(token ? { token } : {}) }))
    : localBackend(await VerificationExecutor.create(loadExecutorConfig()));

  const withRun = (args: Record<string, unknown>) => ({ ...args, ...(run ? { runId: run } : {}) });
  let output: unknown;
  switch (command) {
    case "health":
      output = await backend.health();
      break;
    case "media-types":
      output = await backend.mediaTypes();
      break;
    case "captures":
      output = await backend.listCaptures();
      break;
    case "capture": {
      const method = str(flags.method);
      output = await backend.call(
        "verify_capture_source",
        withRun({
          url: need(positionals[0], "url"),
          ...(str(flags["capture-id"]) ? { captureId: str(flags["capture-id"]) } : {}),
          ...(method ? { method } : {}),
        }),
      );
      break;
    }
    case "capture-file": {
      const path = need(positionals[0], "file path");
      const bytes = new Uint8Array(await readFile(path));
      const filename = basename(path);
      const mediaType = str(flags["media-type"]) ?? mediaTypeForFilename(filename);
      output = await backend.captureBytes({
        bytes,
        filename,
        ...(mediaType ? { mediaType } : {}),
        ...(str(flags["source-uri"]) ? { sourceUri: str(flags["source-uri"]) } : {}),
        ...(str(flags["capture-id"]) ? { captureId: str(flags["capture-id"]) } : {}),
        ...(run ? { runId: run } : {}),
      });
      break;
    }
    case "read":
      output = await backend.call(
        "verify_read_capture",
        withRun({
          captureId: need(positionals[0], "captureId"),
          ...(num(flags.offset) !== undefined ? { offset: num(flags.offset) } : {}),
          ...(num(flags.length) !== undefined ? { length: num(flags.length) } : {}),
        }),
      );
      break;
    case "search":
      output = await backend.call(
        "verify_search_capture",
        withRun({
          captureId: need(positionals[0], "captureId"),
          query: need(positionals.slice(1).join(" "), "query"),
          ...(num(flags.limit) !== undefined ? { limit: num(flags.limit) } : {}),
        }),
      );
      break;
    case "locate":
      output = await backend.call(
        "verify_locate_quote",
        withRun({ captureId: need(positionals[0], "captureId"), quote: need(positionals.slice(1).join(" "), "quote") }),
      );
      break;
    case "fragment":
      output = await backend.call("verify_capture_fragment", {
        captureId: need(positionals[0], "captureId"),
        quote: need(positionals.slice(1).join(" "), "quote"),
        id: need(str(flags.id), "--id"),
        binding: need(str(flags.binding), "--binding"),
        representationDigest: need(str(flags.digest), "--digest"),
        access: { rights: need(str(flags.rights), "--rights"), limits: [] },
      });
      break;
    case "register": {
      const path = need(positionals[0], "file");
      output = await backend.registerBytes({
        bytes: new Uint8Array(await readFile(path)),
        mediaType: artifactMediaTypeFor(path, str(flags["media-type"])),
        ...(str(flags.label) ? { label: str(flags.label) } : {}),
        ...(run ? { runId: run } : {}),
      });
      break;
    }
    case "artifact":
      output = await backend.artifact(
        need(positionals[0], "artifactId"),
        str(flags.as) as "text" | "json" | "handle" | undefined,
      );
      break;
    case "verify-claims":
    case "verify-extraction":
    case "judge":
    case "policy":
    case "seal":
    case "check-report":
    case "status":
      throw new UsageError(
        `${command} is retired (SV-17): verification runs, claims and seals are served by ks.knowledge_operation.v2`,
      );
    default:
      throw new UsageError(`Unknown command: ${command}\n\n${HELP}`);
  }
  await emit(output);
  const gate = qualityGate(command, output);
  if (gate) throw new QualityGateError(output, gate);
}

const invokedDirectly = (() => {
  try {
    if (!process.argv[1]) return false;
    const entry = realpathSync.native(process.argv[1]);
    const modulePath = realpathSync.native(fileURLToPath(import.meta.url));
    return process.platform === "win32" ? entry.toLowerCase() === modulePath.toLowerCase() : entry === modulePath;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((error: unknown) => {
    if (error instanceof QualityGateError) {
      process.stderr.write(`${JSON.stringify({ qualityGate: "failed", reason: error.reason })}\n`);
      process.exitCode = 1;
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    const issues =
      typeof error === "object" && error && "issues" in error ? (error as { issues: unknown }).issues : undefined;
    const payload = error instanceof RemoteExecutorError ? error.payload : undefined;
    process.stderr.write(
      `${JSON.stringify({ error: message, ...(issues ? { issues } : {}), ...(payload !== undefined ? { payload } : {}) }, null, 2)}\n`,
    );
    process.exitCode = 2;
  });
}
