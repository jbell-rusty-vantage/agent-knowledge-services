import { pathToFileURL } from "node:url";
import type { JsonValue, OperationContext } from "@aiengineer/knowledge-contracts";
import { createMcpRuntime } from "./server/http.js";
import handler from "./server/vercel.js";

export * from "./server/http.js";
export { createMcpRequestHandler } from "./server/vercel.js";
export * from "./tools/executors.js";
export { createKnowledgeMcpServer } from "./tools/register.js";
export default handler;

async function main() {
  const runtime = await createMcpRuntime();
  const shutdown = () =>
    void runtime.close().catch((error) => {
      process.stderr.write(
        `${JSON.stringify({ event: "knowledge.mcp.shutdown_failed", error: error instanceof Error ? error.message : "unknown" })}
`,
      );
      process.exitCode = 1;
    });
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try {
    await runtime.app.listen({ host: runtime.config.HOST, port: runtime.config.PORT });
  } catch (error) {
    await runtime.close().catch(() => undefined);
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main().catch(() => {
    process.stderr.write(
      `${JSON.stringify({
        event: "knowledge.mcp.start_failed",
        code: "MCP_START_FAILED",
      })}\n`,
    );
    process.exitCode = 1;
  });

export type { JsonValue, OperationContext };
export type { McpToolArguments } from "./tools/executors.js";
