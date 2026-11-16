import { describeReference, DescribeInputSchema } from "@aiengineer/knowledge-contracts";
import { SYSTEM_MCP_TOOL_NAMES } from "../catalog.js";
import { toolCollector, type ToolDefinition } from "./definition.js";

/**
 * `knowledge_describe`: everything about one tool, operation or skill, so the tool list can stay small. The
 * answer comes from the operation contracts and is the one the API route and the `ks` command return; it reads
 * no tenant data, so the bearer the server already required is its only authority.
 */
export function systemToolDefinitions(): readonly ToolDefinition[] {
  const { definitions, add } = toolCollector();
  const [describe] = SYSTEM_MCP_TOOL_NAMES;
  add(describe, DescribeInputSchema.shape, async (value) => {
    const result = describeReference(DescribeInputSchema.parse(value).ref);
    const body = result.ok ? result.description : result.refusal;
    return {
      content: [{ type: "text" as const, text: JSON.stringify(body) }],
      structuredContent: body as unknown as Record<string, unknown>,
      ...(result.ok ? {} : { isError: true }),
    };
  });
  return definitions;
}
