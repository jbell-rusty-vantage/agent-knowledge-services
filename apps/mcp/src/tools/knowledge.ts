import { MCP_TOOL_CATALOG } from "../catalog.js";
import { createMcpToolExecutor, McpToolArgumentsSchema, type KnowledgeMcpServerOptions } from "./executors.js";
import { toolCollector } from "./definition.js";

/**
 * The knowledge tools take `{ context, input, expectedVersions }`. The server validates that envelope; the
 * executor then checks `input` against the operation's own schema before anything is submitted.
 */
export function knowledgeToolDefinitions(options: KnowledgeMcpServerOptions) {
  const { definitions, add } = toolCollector();
  const execute = createMcpToolExecutor(options);
  for (const [name, kind] of Object.entries(MCP_TOOL_CATALOG))
    add(name, McpToolArgumentsSchema.shape, async (argumentsValue) =>
      execute(name as keyof typeof MCP_TOOL_CATALOG, kind, argumentsValue),
    );
  return definitions;
}
