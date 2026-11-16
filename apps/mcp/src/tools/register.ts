import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { catalogToolNames, type ToolDefinition } from "./definition.js";
import type { KnowledgeMcpServerOptions } from "./executors.js";
import { knowledgeToolDefinitions } from "./knowledge.js";
import { operationsToolDefinitions } from "./operations.js";
import { systemToolDefinitions } from "./system.js";
import { verificationToolDefinitions } from "./verify.js";

/** What a client is told once, when it connects: the conventions every tool shares. */
export const SERVER_INSTRUCTIONS = [
  "Knowledge Services: capture sources, prepare and promote content, embed, retrieve evidence, evaluate and verify.",
  "Start with knowledge_guide, without arguments: it returns the jobs, the skill to read and the tools of each job, and the rules that always hold. knowledge_guide with a topic returns one skill or one of its references as Markdown.",
  "The tool list shows only the required fields of each input. Call knowledge_describe with tool:<name> before the first use of a tool: it returns the full schema (including context), field notes, a valid example and the result.",
  "Operation tools take { context, input, expectedVersions } (knowledge_*) or { context, request }, or { context } with ids beside it (verify_*); knowledge_guide and knowledge_describe take their one field directly.",
  "A tool that submits work returns an accepted operation at once: poll knowledge_promotion_status (knowledge_* tools) or verify_status (verify_* tools) with its operationId, then read the ids it produced with knowledge_operation_result.",
  "An input that does not match its schema is refused with INVALID_CONTRACT and the failing fields; nothing is submitted.",
].join("\n");

export function buildToolDefinitions(options: KnowledgeMcpServerOptions): readonly ToolDefinition[] {
  return [
    ...systemToolDefinitions(),
    ...knowledgeToolDefinitions(options),
    ...verificationToolDefinitions(options),
    ...operationsToolDefinitions(),
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
  const server = new McpServer(
    { name: "ai-engineer-knowledge-services", version: "0.1.0" },
    { instructions: SERVER_INSTRUCTIONS },
  );
  for (const tool of definitions)
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.inputSchema }, tool.run);
  // The server validates arguments with each tool's full schema. The list publishes the compact form of that
  // schema (required fields and types) so it stays small; knowledge_describe returns the full one.
  server.server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: definitions.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.published as { type: "object"; [keyword: string]: unknown },
    })),
  }));
  return server;
}
