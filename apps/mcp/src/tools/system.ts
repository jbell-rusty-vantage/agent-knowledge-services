import {
  describeReference,
  DescribeInputSchema,
  GuideInputSchema,
  guidePage,
  guideRefusalMarkdown,
} from "@aiengineer/knowledge-contracts";
import { SYSTEM_MCP_TOOL_NAMES } from "../catalog.js";
import { toolCollector, type ToolDefinition } from "./definition.js";

/**
 * The two tools an agent with nothing but this server starts from. Both answer from the contract package, give
 * the answer the API route and the `ks` command give, and read no tenant data, so the bearer the server already
 * required is their only authority.
 *
 * `knowledge_guide`: the guidance as Markdown text. Without a topic it is the start page; a skill name is that
 * skill's SKILL.md and `<skill>/<path>` one of its references, so the agent reads what a filesystem agent reads.
 * `knowledge_describe`: everything about one tool, operation or skill, so the tool list can stay small.
 */
export function systemToolDefinitions(): readonly ToolDefinition[] {
  const { definitions, add } = toolCollector();
  const [guide, describe] = SYSTEM_MCP_TOOL_NAMES;
  add(guide, GuideInputSchema.shape, async (value) => {
    const result = guidePage(GuideInputSchema.parse(value).topic);
    // A page is Markdown text, never Markdown inside a JSON string; a refusal lists the topics that exist.
    return result.ok
      ? { content: [{ type: "text" as const, text: result.markdown }] }
      : {
          content: [{ type: "text" as const, text: guideRefusalMarkdown(result.refusal) }],
          structuredContent: result.refusal as unknown as Record<string, unknown>,
          isError: true,
        };
  });
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
