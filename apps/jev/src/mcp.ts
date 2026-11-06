import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { JevTaskSchema } from "@aiengineer/knowledge-contracts/jev";
import type { createJevService } from "@aiengineer/knowledge-application/jev";
import { publicErrorCode } from "./errors.js";

type JevApplication = ReturnType<typeof createJevService>;

async function execute(operation: () => unknown | Promise<unknown>) {
  try {
    return { content: [{ type: "text" as const, text: JSON.stringify(await operation()) }] };
  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: JSON.stringify({ error: publicErrorCode(error) }) }],
    };
  }
}

export function createJevMcpServer(application: JevApplication): McpServer {
  const server = new McpServer({ name: "knowledge-jev", version: "0.1.0" });
  server.registerTool(
    "jev_submit",
    {
      description:
        "Queue one closed-choice/score/boolean decision on inline state, a permitted local file, or remote text/JSON artifact. Returns job ID; workers run in separate processes.",
      inputSchema: JevTaskSchema,
    },
    (input) => execute(() => application.submit(input)),
  );
  server.registerTool(
    "jev_batch",
    {
      description:
        "Queue up to 1000 independent tasks for bounded parallel worker processes. Poll returned job IDs. Each task can contain many independent questions.",
      inputSchema: { tasks: z.array(JevTaskSchema).min(1).max(1000) },
    },
    ({ tasks }) => execute(() => application.submitBatch(tasks)),
  );
  server.registerTool(
    "jev_get",
    {
      description: "Read a durable job, its result, input provenance, provider usage, or failure.",
      inputSchema: { id: z.string().min(1) },
      annotations: { readOnlyHint: true },
    },
    ({ id }) => execute(async () => (await application.get(id)) ?? { error: "NOT_FOUND" }),
  );
  server.registerTool(
    "jev_list",
    {
      description: "List recent jobs; use get for individual results.",
      inputSchema: { limit: z.number().int().min(1).max(1000).default(100) },
      annotations: { readOnlyHint: true },
    },
    ({ limit }) => execute(() => application.list({ limit })),
  );
  server.registerTool(
    "jev_cancel",
    {
      description: "Cancel a queued or running job. Completed provider work may already have been billed.",
      inputSchema: { id: z.string().min(1) },
    },
    ({ id }) => execute(async () => (await application.cancel(id)) ?? { error: "NOT_FOUND" }),
  );
  server.registerTool(
    "jev_workers",
    {
      description: "Inspect worker PIDs and queue counts to observe process parallelism.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () => execute(() => application.stats()),
  );
  return server;
}
