import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { isKnowledgeError } from "@aiengineer/knowledge-db";
import { RemoteExecutor, RemoteExecutorError } from "../remote.js";
import { UnknownOperationError, type AnyOperation } from "../operations/define.js";
import { createKnowledgeFromEnv, describeRunning, startExecutorServer } from "../serve.js";
import type { KnowledgeServices } from "./context.js";
import { knowledgeOperations } from "./operations.js";

export const KNOWLEDGE_HELP = `knowledge — schema workspace, bounded database reads, and deterministic ingestion (one JSON document per command)

Usage: knowledge <group> <command> [positionals] [--flag value]...

Modes
  local   (default)                 needs POSTGRES_URL (or KNOWLEDGE_DB_URL) and SCHEMA_WORKSPACE_DIR
  remote  KNOWLEDGE_EXECUTOR_URL    forward every command to a running executor (\`knowledge serve\` / \`knowledge-verify serve\`)
                                    (or --remote <url>; --token / KNOWLEDGE_EXECUTOR_TOKEN for bearer auth)

Serving
  serve [--port 4310] [--host 127.0.0.1]     same process as knowledge-verify serve: /mcp, /knowledge/:operation, /health
  health                                     GET /health (remote) or local heads
  ops [--schemas]                            list every operation with its CLI shape and MCP tool name;
                                             --schemas adds each operation's JSON Schema input

Schema workspace (local files, no database)
  schema search <query> [--kinds '["table"]'] [--domain slug] [--limit 10]
  schema get <id-or-path> [--max-bytes 24000]
  schema manifest                            workspace manifest + database head (exit 1 on HEAD_MISMATCH)
  schema materialize <scope> <outDir>

Database reads (pipeline_agent / app_reader, read-only transactions)
  db head [--tenant <uuid>]
  db read-intent <intent.json> [--persist]   knowledge-read-intent.v1 → knowledge-read-snapshot.v1
  db sql <sql | --sql "..."> [--params '[..]'] [--limit 200] [--statement-timeout-ms 15000]
  db explain <sql | --sql "...">

Ingestion (executor_service, one transaction, temporal helpers)
  ingest plan <intent.json> [--expected-head N]
  ingest apply <intent.json> [--expected-head N]
  ingest receipt <receiptId>
  artifact get <artifactId>

Research reports (registration is custody; a seal is not admission)
  report register <report.json> [--tenant <uuid>]
  report get <reportVersionId> [--tenant <uuid>]
  report assess <reportVersionId>            host-pinned requirement fidelity; admission is separate

Source discovery receipts (preserved provider work; never evidence)
  source discover <request.json> [--tenant <uuid>]
  source import <receipt.json> [--tenant <uuid>]     account for an externally executed attempt
  source attempt <attemptId> [--offset N] [--limit N]
  source reconcile <attemptId>               recover an interrupted attempt without a new dispatch
  source select <request.json>               selected / omitted / duplicate lead decisions

Typed content links (canonical close-out; separate from ingestion proposals)
  content plan <intent.json>                 read-only validation of content-link-intent.v1
  content apply <intent.json>                applied under an exact knowledge-head lock
  content receipt <receiptId>
  content prepare-summary <operation.json>   renders a PENDING summary; independent review required

Scoped checkpoints
  checkpoint harness <request.json>
  checkpoint commit <request.json>
  checkpoint head <scope.json>
  checkpoint read <request.json>
  checkpoint restore <request.json>
  checkpoint tombstone <request.json>

Verification recovery (durable cases; requires KNOWLEDGE_RECOVERY_CONFIG_JSON)
  recovery status
  recovery submit <runId>                    submit a host-pinned original verification
  recovery observe <runId>                   authenticated result; retains a case when unsuccessful
  recovery read <caseId>
  recovery probe <representatives.json> --case-id <id> --dependency-id <id> [--control-id <id>]
  recovery plan <actions.json> --case-id <id> --expected-revision <n> --probes <f> --reservation <f>
  recovery claim <caseId> <planDigest> [--lease-ms 30000]
  recovery execute <claim.json> --original-id <id> --reservation <f>
  recovery reconcile <caseId> <planDigest>
  recovery wait <caseId> <checkpointId> --expected-revision <n> --reason "<text>"
  recovery resume <authority.json> --case-id <id> --expected-revision <n>

Output
  Every command prints exactly one JSON document to stdout.
  --out <file>   also write the JSON to <file> and print a compact summary
  --tenant <uuid> sets tenantId; other --kebab-flags become camelCase input fields; values parse as JSON when they can.

Exit codes
  0  success (includes duplicateOf, partial, noop receipts and skipped read ops)
  1  domain outcome: INTENT_SCHEMA_INVALID, PARAMS_INVALID, QUERY_UNKNOWN, VOCABULARY_VIOLATION, RULE_VIOLATION,
     REBASE_REQUIRED, SUBJECT_*, EVIDENCE_NOT_ELIGIBLE, REVIEW_REQUIRED_ONLY, DUPLICATE_PENDING, HEAD_MISMATCH (atKnowledgeSeq), plan rejected
  2  infrastructure/usage: WORKSPACE_MISSING, WORKSPACE_STALE, HEAD_MISMATCH (migration), DB_UNAVAILABLE, ROLE_DENIED, network, auth`;

export interface Parsed {
  readonly positionals: readonly string[];
  readonly flags: Readonly<Record<string, string | true>>;
}

export function parseArgv(argv: readonly string[]): Parsed {
  const positionals: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]!;
    if (!item.startsWith("--")) {
      positionals.push(item);
      continue;
    }
    const key = item.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      index += 1;
    } else flags[key] = true;
  }
  return { positionals, flags };
}

const RESERVED_FLAGS = new Set(["out", "remote", "token", "tenant"]);
const camel = (flag: string): string => flag.replace(/-([a-z0-9])/g, (_, letter: string) => letter.toUpperCase());

function coerce(value: string | true): unknown {
  if (value === true) return true;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** Builds the operation input from positionals (by the operation's binding) and `--flags` (camelCased, JSON-coerced). */
export async function buildInput(operation: AnyOperation<unknown>, parsed: Parsed): Promise<Record<string, unknown>> {
  const input: Record<string, unknown> = {};
  const positional = operation.cli.positional ?? [];
  for (const [index, name] of positional.entries()) {
    const value = parsed.positionals[index];
    if (value === undefined) continue;
    input[name] = operation.cli.jsonFiles?.includes(name) ? JSON.parse(await readFile(value, "utf8")) : coerce(value);
  }
  for (const [flag, value] of Object.entries(parsed.flags)) {
    if (RESERVED_FLAGS.has(flag)) continue;
    const name = camel(flag);
    input[name] =
      operation.cli.jsonFiles?.includes(name) && typeof value === "string"
        ? JSON.parse(await readFile(value, "utf8"))
        : coerce(value);
  }
  if (typeof parsed.flags.tenant === "string") input.tenantId = parsed.flags.tenant;
  return input;
}

export class UsageError extends Error {
  override readonly name = "UsageError";
}
export class GateError extends Error {
  override readonly name = "GateError";
  constructor(
    readonly payload: unknown,
    readonly reason: string,
  ) {
    super(reason);
  }
}

interface Invocation {
  readonly operation: AnyOperation<unknown>;
  readonly input: Record<string, unknown>;
}

async function invokeLocal(invocation: Invocation, services: KnowledgeServices | undefined): Promise<unknown> {
  if (!services)
    throw new UsageError(
      "local mode needs POSTGRES_URL (or KNOWLEDGE_DB_URL) and a schema workspace; or set KNOWLEDGE_EXECUTOR_URL for remote mode",
    );
  const { output } = await knowledgeOperations.invoke(invocation.operation.name, invocation.input, services);
  const gate = invocation.operation.gate?.(output);
  if (gate) throw new GateError(output, gate);
  return output;
}

async function invokeRemote(invocation: Invocation, remote: RemoteExecutor): Promise<unknown> {
  const output = await remote.tool(invocation.operation.name, invocation.input);
  const gate = (output as { qualityGate?: { passed: boolean; reason: string } } | null)?.qualityGate;
  if (gate && gate.passed === false) throw new GateError(output, gate.reason);
  return output;
}

function summarize(output: unknown): unknown {
  if (!output || typeof output !== "object" || Array.isArray(output)) return output;
  const summary: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(output as Record<string, unknown>)) {
    if (value === null || ["string", "number", "boolean"].includes(typeof value))
      summary[key] =
        typeof value === "string" && value.length > 200 ? `${value.slice(0, 200)}… (${value.length} chars)` : value;
    else if (Array.isArray(value)) summary[key] = `[${value.length} items]`;
    else summary[key] = "{…}";
  }
  return summary;
}

export async function runKnowledgeCli(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  const [group, sub, ...rest] = argv;
  if (!group || group === "help" || group === "--help" || group === "-h") {
    console.log(KNOWLEDGE_HELP);
    return;
  }
  const parsed = parseArgv(group === "serve" || group === "health" || group === "ops" ? argv.slice(1) : rest);
  const out = typeof parsed.flags.out === "string" ? parsed.flags.out : undefined;
  const emit = async (value: unknown) => {
    const text = JSON.stringify(value, null, 2);
    if (out) {
      await writeFile(out, `${text}\n`, "utf8");
      process.stdout.write(`${JSON.stringify({ ...(summarize(value) as object), writtenTo: out }, null, 2)}\n`);
    } else process.stdout.write(`${text}\n`);
  };
  const remoteUrl =
    typeof parsed.flags.remote === "string"
      ? parsed.flags.remote
      : env.KNOWLEDGE_EXECUTOR_URL?.trim() || env.VERIFY_EXECUTOR_URL?.trim();
  const token =
    typeof parsed.flags.token === "string"
      ? parsed.flags.token
      : env.KNOWLEDGE_EXECUTOR_TOKEN?.trim() || env.VERIFY_EXECUTOR_TOKEN?.trim();

  if (group === "ops") {
    const schemas = parsed.flags.schemas === true;
    await emit(
      knowledgeOperations.list().map((operation) => ({
        tool: operation.name,
        cli: `knowledge ${operation.cli.command.join(" ")} ${(operation.cli.positional ?? []).map((name) => `<${name}>`).join(" ")}`.trim(),
        title: operation.title,
        ...(schemas
          ? {
              jsonFiles: operation.cli.jsonFiles ?? [],
              inputSchema: z.toJSONSchema(operation.input, { io: "input", unrepresentable: "any" }),
            }
          : {}),
      })),
    );
    return;
  }
  if (group === "serve") {
    const port =
      typeof parsed.flags.port === "string"
        ? Number(parsed.flags.port)
        : Number(env.KNOWLEDGE_PORT ?? env.VERIFY_PORT ?? 4310);
    const host =
      typeof parsed.flags.host === "string"
        ? parsed.flags.host
        : (env.KNOWLEDGE_HOST ?? env.VERIFY_HOST ?? "127.0.0.1");
    const running = await startExecutorServer({ port, host, ...(token ? { token } : {}), env });
    console.error(JSON.stringify(describeRunning(running, token ? "bearer" : "none")));
    await new Promise<void>((resolve) => {
      process.on("SIGINT", () => void running.close().then(resolve));
      process.on("SIGTERM", () => void running.close().then(resolve));
    });
    return;
  }
  if (group === "health") {
    if (remoteUrl) {
      await emit(await new RemoteExecutor({ baseUrl: remoteUrl, ...(token ? { token } : {}) }).health());
      return;
    }
    const services = await createKnowledgeFromEnv(env);
    if (!services) throw new UsageError("no database configured");
    try {
      await emit(await knowledgeOperations.invoke("schema_manifest", {}, services).then((result) => result.output));
    } finally {
      await services.close();
    }
    return;
  }
  if (!sub) throw new UsageError(`missing command for group ${group}\n\n${KNOWLEDGE_HELP}`);
  const operation = knowledgeOperations.byCommand(group, sub) as AnyOperation<unknown> | undefined;
  if (!operation) throw new UsageError(`unknown command: knowledge ${group} ${sub}\n\n${KNOWLEDGE_HELP}`);
  const input = await buildInput(operation, parsed);
  if (remoteUrl) {
    await emit(
      await invokeRemote({ operation, input }, new RemoteExecutor({ baseUrl: remoteUrl, ...(token ? { token } : {}) })),
    );
    return;
  }
  const services = await createKnowledgeFromEnv(env);
  try {
    await emit(await invokeLocal({ operation, input }, services));
  } finally {
    await services?.close();
  }
}

/** Exit lattice: 0 ok, 1 domain outcome, 2 infrastructure/usage. */
export function exitCodeFor(error: unknown): 1 | 2 {
  if (error instanceof GateError) return 1;
  if (isKnowledgeError(error)) return error.exit;
  if (error instanceof RemoteExecutorError) {
    const exit = (error.payload as { exit?: number } | undefined)?.exit;
    return exit === 1 ? 1 : 2;
  }
  if (error instanceof UnknownOperationError || error instanceof UsageError) return 2;
  if (typeof error === "object" && error && "issues" in error) return 1;
  return 2;
}

export function errorPayload(error: unknown): Record<string, unknown> {
  if (error instanceof GateError) return { qualityGate: "failed", reason: error.reason };
  if (isKnowledgeError(error)) return error.toJSON();
  if (error instanceof RemoteExecutorError)
    return typeof error.payload === "object" && error.payload
      ? (error.payload as Record<string, unknown>)
      : { error: error.message };
  const message = error instanceof Error ? error.message : String(error);
  const issues =
    typeof error === "object" && error && "issues" in error ? (error as { issues: unknown }).issues : undefined;
  return { error: message, ...(issues ? { code: "INPUT_INVALID", issues } : {}) };
}
