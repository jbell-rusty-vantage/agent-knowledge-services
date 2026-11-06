#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createJevService } from "@aiengineer/knowledge-application/jev";
import { KnowledgeJevClient } from "@aiengineer/knowledge-client/jev";
import { JevTaskSchema } from "@aiengineer/knowledge-contracts/jev";
import { z } from "zod";
import { loadJevConfig } from "./config.js";
import { createJevHttpServer } from "./http.js";
import { createJevMcpServer } from "./mcp.js";

const HELP = `jev — process workers for TypeSafe System One

serve                     Start HTTP API + MCP and worker processes
mcp-stdio                 Start a dedicated stdio MCP host and worker processes
submit <task.json>         Submit one task through the HTTP API
batch <tasks.json>         Submit a JSON array of tasks through the HTTP API
get <id>                  Read a job/result
cancel <id>               Cancel a queued/running job
list                      List recent jobs
workers                   Show live worker PIDs and queue counts

Options: --wait (submit/batch); --out <file>; --timeout <milliseconds>
Client: JEV_SERVICE_URL (http://127.0.0.1:4318), JEV_SERVICE_TOKEN
Host: JEV_HOST, JEV_PORT, JEV_WORKERS, JEV_DATABASE_PATH,
      JEV_ALLOWED_ROOTS (JSON array), JEV_REMOTE_ORIGINS (JSON array),
      JEV_PROVIDER (gateway/direct), AI_GATEWAY_API_KEY or JEV_API_KEY
Inputs: inline text/JSON, allowed-root files, allowlisted HTTPS text/JSON artifacts.
Binary documents need Knowledge Services capture/conversion first.
One host owns each SQLite database. HTTP and its /mcp share that host.
`;

async function serve(command: string): Promise<void> {
  const config = loadJevConfig();
  const application = createJevService(config.service);
  try {
    await application.start();
  } catch (error) {
    await application.close();
    throw error;
  }
  const transport = command === "mcp-stdio" ? new StdioServerTransport() : undefined;
  const mcp = transport ? createJevMcpServer(application) : undefined;
  const http = transport
    ? undefined
    : createJevHttpServer(application, {
        ...(config.token ? { token: config.token } : {}),
        reportPath: resolve("docs/jev/results/index.html"),
        experimentReadmePath: resolve("scripts/experiments/jev/README.md"),
      });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await mcp?.close();
      await new Promise<void>((done) => {
        if (!http) {
          done();
          return;
        }
        http.close(() => done());
        http.closeAllConnections();
      });
    } finally {
      await application.close();
    }
  };
  const requestStop = () => {
    void stop().catch(() => {
      process.stderr.write("Jev shutdown failed\n");
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", requestStop);
  process.once("SIGTERM", requestStop);
  if (mcp && transport) {
    try {
      await mcp.connect(transport);
    } catch (error) {
      await application.close();
      throw error;
    }
    process.stdin.once("end", requestStop);
  } else if (http) {
    try {
      await new Promise<void>((done, fail) => {
        http.once("error", fail);
        http.listen(config.port, config.host, done);
      });
      process.stderr.write(`Jev listening on ${JSON.stringify(http.address())}\n`);
    } catch (error) {
      await application.close();
      throw error;
    }
  }
}

async function runClient(command: string, positional: string[], values: { wait?: boolean; timeout?: string }) {
  const client = new KnowledgeJevClient({
    baseUrl: process.env.JEV_SERVICE_URL ?? "http://127.0.0.1:4318",
    getAccessToken: () => process.env.JEV_SERVICE_TOKEN ?? "",
  });
  if (command === "workers") return client.health();
  if (command === "list") return client.list();
  const argument = positional[1];
  if (!argument) throw new Error(`${command} requires a file or job ID`);
  if (command === "get") return client.get(argument);
  if (command === "cancel") return client.cancel(argument);
  if (command !== "submit" && command !== "batch") throw new Error("Unknown command; run jev help");
  const timeoutMs = z.coerce
    .number()
    .int()
    .min(1)
    .max(86_400_000)
    .parse(values.timeout ?? 120_000);
  const contents = await readFile(resolve(argument), "utf8");
  let input: unknown;
  try {
    input = JSON.parse(contents);
  } catch {
    throw new Error("Task file must contain valid JSON");
  }
  const jobs =
    command === "submit"
      ? [await client.submit(JevTaskSchema.parse(input))]
      : await client.submitBatch(z.array(JevTaskSchema).min(1).max(1000).parse(input));
  const results = [];
  // Jobs execute in parallel; polling one at a time bounds client traffic for large batches.
  for (const job of jobs) results.push(values.wait ? await client.wait(job.id, { timeoutMs }) : job);
  if (results.some((job) => job.status === "failed" || job.status === "cancelled")) process.exitCode = 1;
  return command === "submit" ? results[0] : results;
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { wait: { type: "boolean" }, out: { type: "string" }, timeout: { type: "string" } },
  });
  const command = positionals[0] ?? "help";
  if (command === "help") {
    process.stdout.write(HELP);
    return;
  }
  if (command === "serve" || command === "mcp-stdio") {
    await serve(command);
    return;
  }
  const result = await runClient(command, positionals, values);
  if (values.out) {
    await writeFile(resolve(values.out), JSON.stringify(result, null, 2) + "\n");
    process.stdout.write(JSON.stringify({ output: resolve(values.out) }) + "\n");
  } else process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

main().catch((error: unknown) => {
  // Never serialize provider errors or request payloads into the CLI error stream.
  const message =
    error instanceof z.ZodError
      ? "Invalid input; check the Jev task schema"
      : error instanceof Error
        ? error.message
        : "Jev command failed";
  process.stderr.write(JSON.stringify({ error: message }) + "\n");
  process.exitCode = 2;
});
