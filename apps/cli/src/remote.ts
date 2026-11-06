import { KnowledgeClient } from "@aiengineer/knowledge-client";
import { JsonValueSchema, OperationContextSchema } from "@aiengineer/knowledge-contracts";
import { dispatchCliCommand, type CliCommand } from "./commands.js";
import { EXIT, KsUsageError, type KsIo } from "./io.js";
import { waitForVerification } from "./verification-completion.js";

/** Remote configuration: `--base-url` or KNOWLEDGE_API_URL, and the bearer in KNOWLEDGE_API_TOKEN. */
export const REMOTE_ENVIRONMENT = { url: "KNOWLEDGE_API_URL", token: "KNOWLEDGE_API_TOKEN" } as const;
const REMOTE_FLAGS = new Set(["--base-url", "--context", "--input", "--timeout-ms", "--wait", "--human"]);
const VALUE_FLAGS = new Set(["--base-url", "--context", "--input", "--timeout-ms"]);

function options(argv: readonly string[]) {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!REMOTE_FLAGS.has(token))
      throw new KsUsageError(token.startsWith("--") ? `unknown option ${token}` : `unexpected argument ${token}`);
    if (!VALUE_FLAGS.has(token)) continue;
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new KsUsageError(`${token} requires a value`);
    values.set(token, value);
    index += 1;
  }
  return values;
}

/**
 * Runs a remote command through KnowledgeClient against the server profile. It never constructs host: an
 * authorization or network failure exits 2 and never falls back to local execution.
 */
export async function runRemoteCommand(
  command: CliCommand,
  argv: readonly string[],
  io: KsIo,
  fetchImplementation: typeof fetch = fetch,
): Promise<number> {
  if (command.mode === "unsupported") throw new Error(`CAPABILITY_NOT_ADMITTED:${command.reason}`);
  const values = options(argv);
  const baseUrl = values.get("--base-url") ?? io.env[REMOTE_ENVIRONMENT.url];
  if (!baseUrl) throw new KsUsageError(`${REMOTE_ENVIRONMENT.url} or --base-url is required`);
  const token = io.env[REMOTE_ENVIRONMENT.token];
  if (!token) throw new KsUsageError(`${REMOTE_ENVIRONMENT.token} is required`);
  const json = (flag: string, fallback: string): unknown => {
    try {
      return JSON.parse(values.get(flag) ?? fallback);
    } catch {
      throw new KsUsageError(`${flag} must be JSON`);
    }
  };
  const context = OperationContextSchema.parse(json("--context", "null"));
  const input = JsonValueSchema.parse(json("--input", "{}"));
  const timeoutMs = Number(values.get("--timeout-ms") ?? "60000");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300000)
    throw new KsUsageError("CLI_TIMEOUT_INVALID");
  const deadline = Date.now() + timeoutMs,
    signal = AbortSignal.timeout(timeoutMs);
  const client = new KnowledgeClient({
    baseUrl,
    getAccessToken: () => token,
    fetch: (url, init) => fetchImplementation(url, { ...init, signal }),
  });
  const human = argv.includes("--human");
  const print = (value: unknown) => io.stdout(`${JSON.stringify(value, null, human ? 2 : undefined)}\n`);
  const accepted = await dispatchCliCommand(client, command, input, context);
  if (!argv.includes("--wait") || command.mode !== "verification_mutation") {
    print(accepted);
    return EXIT.ok;
  }
  const operationId = (accepted as { operationId?: string }).operationId;
  if (!operationId) throw new Error("OPERATION_ID_REQUIRED");
  const completed = await waitForVerification(client, operationId, context, Math.max(0, deadline - Date.now()));
  print(completed);
  return completed.exitCode;
}
