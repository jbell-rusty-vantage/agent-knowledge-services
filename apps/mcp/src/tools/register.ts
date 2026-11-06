import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { catalogToolNames, type ToolDefinition } from "./definition.js";
import type { KnowledgeMcpServerOptions } from "./executors.js";
import { knowledgeToolDefinitions } from "./knowledge.js";
import { operationsToolDefinitions } from "./operations.js";
import { systemToolDefinitions } from "./system.js";
import { verificationToolDefinitions } from "./verify.js";

export function buildToolDefinitions(options: KnowledgeMcpServerOptions): readonly ToolDefinition[] {
  return [
    ...knowledgeToolDefinitions(options),
    ...verificationToolDefinitions(options),
    ...operationsToolDefinitions(),
    ...systemToolDefinitions(),
  ];
}

export function createKnowledgeMcpServer(options: KnowledgeMcpServerOptions) {
  const definitions = buildToolDefinitions(options);
  const registered = new Set(definitions.map((tool) => tool.name));
  const catalog = catalogToolNames();
  if (
    registered.size !== definitions.length ||
    registered.size !== catalog.size ||
    [...catalog].some((name) => !registered.has(name))
  )
    throw new Error("MCP_TOOL_CATALOG_MISMATCH");
  const server = new McpServer({ name: "ai-engineer-knowledge-services", version: "0.1.0" });
  for (const tool of definitions)
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.inputSchema }, tool.run);
  return server;
}
