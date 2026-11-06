import { MCP_TOOL_CATALOG } from "../catalog.js";
import { createMcpToolExecutor, McpToolArgumentsSchema, type KnowledgeMcpServerOptions } from "./executors.js";
import { toolCollector } from "./definition.js";

export function knowledgeToolDefinitions(options: KnowledgeMcpServerOptions) {
  const { definitions, add } = toolCollector();
  const execute = createMcpToolExecutor(options);
  for (const [name, kind] of Object.entries(MCP_TOOL_CATALOG))
    add(
      name,
      {
        description: `Bounded ${name} workflow over the Knowledge Services v1 application contract.`,
        inputSchema: McpToolArgumentsSchema.shape,
      },
      async (argumentsValue) => execute(name as keyof typeof MCP_TOOL_CATALOG, kind, argumentsValue),
    );
  return definitions;
}
