/**
 * What an agent that has only this MCP server is told: every tool explains itself and publishes the shape of its
 * own input, the list stays small, and `knowledge_describe` returns the rest on demand.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  describeReference,
  guidePage,
  guideTopics,
  inputJsonSchema,
  operationContractForTool,
  PLATFORM_TOOL_NAMES,
  SKILL_CATALOG,
  toolArgumentsSchema,
  toolDescription,
  toolListingSchema,
} from "@aiengineer/knowledge-contracts";
import { MCP_TOOL_CATALOG, SYSTEM_MCP_TOOL_NAMES, VERIFICATION_MCP_TOOL_NAMES } from "../catalog.js";
import { createKnowledgeMcpServer } from "../index.js";
import { buildToolDefinitions, SERVER_INSTRUCTIONS } from "../tools/register.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const options = {
  operationService: {} as never,
  apiOrigin: "https://knowledge.example",
  identity: {
    actor: { kind: "service" as const, id: id(2), serviceIdentity: "mission_control_client" as const },
    grants: [],
  },
};
type ListedTool = {
  name: string;
  description?: string;
  inputSchema: { type: string; required?: string[]; properties?: Record<string, Record<string, unknown>> };
};
/** The contract of the operation a tool runs; a tool without one fails the test that asks for it. */
const contractOf = (tool: string) => {
  const contract = operationContractForTool(tool);
  if (!contract) throw new Error(`${tool} has no operation contract`);
  return contract;
};

describe("platform MCP tool contracts", () => {
  const client = new Client({ name: "tool-contracts", version: "0" });
  const server = createKnowledgeMcpServer(options);
  let listing: { tools: ListedTool[] };
  beforeAll(async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    listing = (await client.listTools()) as { tools: ListedTool[] };
  });
  afterAll(async () => {
    await client.close();
    await server.close();
  });
  const describeTool = async (ref: string) => {
    const result = await client.callTool({ name: "knowledge_describe", arguments: { ref } });
    const [content] = result.content as { text: string }[];
    return {
      isError: result.isError === true,
      body: JSON.parse(content?.text ?? "null") as Record<string, unknown>,
      structured: result.structuredContent,
    };
  };

  it("lists the 45 tools: the guide and describe tools first, then the knowledge and the verification tools", () => {
    const names = listing.tools.map((tool) => tool.name);
    expect(names).toHaveLength(45);
    expect(names.slice(0, 2)).toEqual(["knowledge_guide", "knowledge_describe"]);
    expect([...names].sort()).toEqual(
      [
        ...SYSTEM_MCP_TOOL_NAMES,
        ...Object.keys(MCP_TOOL_CATALOG),
        ...VERIFICATION_MCP_TOOL_NAMES,
        "verify_benchmark_show",
        "verify_benchmark_manifest",
        "verify_reconciliation_apply",
        "verify_reconciliation_show",
        "verify_extraction_show",
        "verify_benchmark_comparison",
        "verify_status",
      ].sort(),
    );
    expect([...names].sort()).toEqual([...PLATFORM_TOOL_NAMES].sort());
  });

  it("gives every tool a real description of at most four short lines, taken from its operation contract", () => {
    for (const tool of listing.tools) {
      const description = tool.description ?? "";
      expect(description, tool.name).toBe(toolDescription(tool.name));
      // Not the generated template, and nothing that names the tool instead of explaining it.
      expect(description, tool.name).not.toMatch(/^Bounded |workflow over the|workflow through in-process/u);
      expect(description, tool.name).not.toContain(`${tool.name} workflow`);
      const lines = description.split("\n");
      expect(lines.length, tool.name).toBeGreaterThanOrEqual(3);
      expect(lines.length, tool.name).toBeLessThanOrEqual(4);
      for (const line of lines) expect(line.length, `${tool.name}: ${line}`).toBeLessThanOrEqual(190);
      // Plain words: no ticket ids, file paths or source file names.
      expect(description, tool.name).not.toMatch(/\b[A-Z]{2,5}-\d+\b|\bsrc\/|\.ts\b|\bapps\/|\bpackages\//u);
    }
    // No tool is another name for an operation: every description is listed once.
    const descriptions = listing.tools.map((tool) => tool.description);
    expect(new Set(descriptions).size).toBe(descriptions.length);
    const names = listing.tools.map((tool) => tool.name);
    for (const removed of [
      "knowledge_promotion_propose_domain_mapping",
      "knowledge_promotion_propose_claims",
      "knowledge_promotion_propose_entity_links",
      "knowledge_embed_status",
    ])
      expect(names, removed).not.toContain(removed);
    expect(names).toContain("knowledge_promotion_propose");
    expect(names).toContain("knowledge_promotion_status");
  });

  it("refuses a call to a removed name as an unknown tool", async () => {
    for (const removed of ["knowledge_embed_status", "knowledge_promotion_propose_claims"]) {
      const outcome = await client.callTool({ name: removed, arguments: {} }).then(
        (result) => ({ isError: result.isError === true, text: JSON.stringify(result.content) }),
        (error: unknown) => ({ isError: true, text: error instanceof Error ? error.message : String(error) }),
      );
      expect(outcome.isError, removed).toBe(true);
      expect(outcome.text, removed).toContain(removed);
    }
  });

  it("returns the start page from knowledge_guide without arguments, as Markdown text", async () => {
    const result = await client.callTool({ name: "knowledge_guide", arguments: {} });
    expect(result.isError).not.toBe(true);
    const content = result.content as { type: string; text: string }[];
    expect(content).toHaveLength(1);
    expect(content[0]?.type).toBe("text");
    const start = content[0]?.text ?? "";
    const expected = guidePage();
    expect(expected.ok && start).toBe(expected.ok && expected.markdown);
    // Markdown, never Markdown inside a JSON string, and no structured copy of it.
    expect(start.startsWith("# Knowledge Services\n")).toBe(true);
    expect(() => JSON.parse(start)).toThrow();
    expect(result.structuredContent).toBeUndefined();
    // Every tool the start page names for the platform server is in the tool list.
    const listed = new Set(listing.tools.map((tool) => tool.name));
    for (const line of start.split("\n").filter((text) => /^\d\. /u.test(text))) {
      const platform = /Platform: ([^.]+)\./u.exec(line)?.[1] ?? "";
      for (const [, pattern] of platform.matchAll(/`([^`]+)`/gu)) {
        const wildcard = /^([a-z0-9_]+_)\*$/u.exec(pattern as string);
        const braces = /^([a-z0-9_]+_)\{([a-z0-9_,]+)\}$/u.exec(pattern as string);
        const tools = wildcard
          ? [...listed].filter((name) => name.startsWith(wildcard[1] as string))
          : braces
            ? (braces[2] as string).split(",").map((rest) => `${braces[1]}${rest}`)
            : [pattern as string];
        expect(tools.length, pattern).toBeGreaterThan(0);
        for (const tool of tools) expect(listed.has(tool), `${pattern}: ${tool}`).toBe(true);
      }
    }
  });

  it("returns every skill and every reference from knowledge_guide by topic", async () => {
    for (const topic of guideTopics()) {
      const result = await client.callTool({ name: "knowledge_guide", arguments: { topic } });
      const [content] = result.content as { type: string; text: string }[];
      const expected = guidePage(topic);
      expect(result.isError, topic).not.toBe(true);
      expect(expected.ok && content?.text, topic).toBe(expected.ok && expected.markdown);
      expect((content?.text ?? "").length, topic).toBeGreaterThan(100);
    }
    const method = await client.callTool({
      name: "knowledge_guide",
      arguments: { topic: "knowledge-research/references/tools/tavily" },
    });
    expect((method.content as { text: string }[])[0]?.text).toContain("# Tavily playbook");
    const refused = await client.callTool({ name: "knowledge_guide", arguments: { topic: "no-such-skill" } });
    expect(refused.isError).toBe(true);
    expect((refused.content as { text: string }[])[0]?.text).toContain("`knowledge-research`");
    expect(refused.structuredContent).toMatchObject({ code: "NOT_FOUND", valid: guideTopics() });
  });

  it("publishes a typed input for every tool: no tool falls back to any JSON", () => {
    for (const tool of listing.tools) {
      const contract = contractOf(tool.name);
      expect(tool.inputSchema, tool.name).toEqual(toolListingSchema(tool.name));
      expect(tool.inputSchema.type, tool.name).toBe("object");
      const member = contract.shape === "envelope" ? "input" : contract.shape === "request" ? "request" : undefined;
      if (!member) continue;
      const input = tool.inputSchema.properties?.[member];
      expect(input?.type, `${tool.name}.${member}`).toBe("object");
      // The member names its fields, its variants, or says that it takes none.
      expect(
        input?.properties !== undefined || input?.anyOf !== undefined || input?.additionalProperties === false,
        `${tool.name}.${member} is untyped`,
      ).toBe(true);
      const required = inputJsonSchema(contract.input).required as string[] | undefined;
      if (required?.length) expect(input?.required, `${tool.name}.${member}`).toEqual(required);
    }
    // The 29 knowledge tools no longer share one schema.
    const knowledge = listing.tools.filter((tool) => tool.name in MCP_TOOL_CATALOG);
    expect(knowledge).toHaveLength(29);
    // The guide's one field is optional, so the list publishes it whole.
    expect(listing.tools.find((tool) => tool.name === "knowledge_guide")?.inputSchema.properties).toHaveProperty(
      "topic",
    );
    const distinct = new Set(knowledge.map((tool) => JSON.stringify(tool.inputSchema.properties?.input)));
    expect(distinct.size).toBeGreaterThanOrEqual(20);
  });

  it("validates arguments with the schema knowledge_describe publishes for the tool", () => {
    const envelope = toolArgumentsSchema({ input: z.unknown(), shape: "envelope" });
    for (const tool of buildToolDefinitions(options)) {
      const contract = contractOf(tool.name);
      const validated = inputJsonSchema(z.object(tool.inputSchema)) as { properties: Record<string, unknown> };
      const described = inputJsonSchema(toolArgumentsSchema(contract)) as {
        properties: Record<string, unknown>;
        required?: string[];
      };
      expect(Object.keys(validated.properties).sort(), tool.name).toEqual(Object.keys(described.properties).sort());
      if (contract.shape !== "envelope") {
        // The verification tools and knowledge_describe are validated by the server with the described schema itself.
        expect(validated.properties, tool.name).toEqual(described.properties);
        continue;
      }
      // A knowledge tool's envelope is validated by the server; its input is checked by the executor against the
      // operation's schema, which is the `input` the description publishes.
      const shared = inputJsonSchema(envelope) as { properties: Record<string, unknown> };
      for (const member of ["context", "expectedVersions"])
        expect(validated.properties[member], `${tool.name}.${member}`).toEqual(shared.properties[member]);
      expect(described.properties.context, tool.name).toEqual(shared.properties.context);
    }
  });

  it("keeps the tool list small: compact schemas inline, full schemas on demand", () => {
    const characters = JSON.stringify(listing).length;
    // About 12,000 tokens at four characters a token is the ceiling; the list is well under it.
    expect(characters).toBeLessThan(44_000);
    for (const tool of listing.tools) {
      const answer = describeReference(`tool:${tool.name}`);
      if (!answer.ok || answer.description.type !== "tool") throw new Error(`tool:${tool.name} was not described`);
      expect(JSON.stringify(tool.inputSchema).length, tool.name).toBeLessThanOrEqual(
        JSON.stringify(answer.description.arguments).length,
      );
    }
    expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
    expect(SERVER_INSTRUCTIONS).toContain("knowledge_describe");
    expect(SERVER_INSTRUCTIONS).toContain("Start with knowledge_guide");
    expect(SERVER_INSTRUCTIONS).toContain("knowledge_operation_result");
    // About 10,000 tokens is the budget of the whole list.
    expect(Math.ceil(characters / 4)).toBeLessThanOrEqual(10_000);
  });

  it("describes any tool, operation or skill with the content the contract package serves", async () => {
    for (const ref of [
      "tool:knowledge_source_fetch",
      "tool:verify_extract",
      "tool:knowledge_describe",
      "operation:capture",
      "operation:promotion_decision",
      ...SKILL_CATALOG.slice(0, 1).map((skill) => `skill:${skill.name}`),
    ]) {
      const expected = describeReference(ref);
      const observed = await describeTool(ref);
      expect(observed.isError, ref).toBe(false);
      expect(expected.ok && observed.body, ref).toEqual(
        expected.ok && JSON.parse(JSON.stringify(expected.description)),
      );
      expect(observed.structured, ref).toEqual(observed.body);
    }
    const fetch = (await describeTool("tool:knowledge_source_fetch")).body;
    expect(Object.keys(fetch)).toEqual([
      "ref",
      "type",
      "name",
      "operation",
      "effect",
      "description",
      "arguments",
      "notes",
      "example",
      "result",
      "related",
      "surfaces",
    ]);
    expect(fetch.surfaces).toEqual({
      mcp: ["knowledge_source_fetch"],
      cli: ["ks knowledge source fetch"],
      http: ["POST /v1/captures"],
    });
  });

  it("returns for every tool an example the tool's own arguments schema accepts", async () => {
    for (const tool of buildToolDefinitions(options)) {
      const described = (await describeTool(`tool:${tool.name}`)).body;
      const parsed = z.object(tool.inputSchema).safeParse(described.example);
      expect(parsed.success, `${tool.name}: ${parsed.error?.message}`).toBe(true);
      expect(toolArgumentsSchema(contractOf(tool.name)).safeParse(described.example).success).toBe(true);
    }
  });

  it("refuses an unknown reference with a typed error that lists the valid prefixes", async () => {
    const unknown = await describeTool("capture");
    expect(unknown.isError).toBe(true);
    expect(unknown.body).toMatchObject({
      code: "NOT_FOUND",
      ref: "capture",
      validPrefixes: ["tool:", "operation:", "skill:"],
      valid: [],
    });
    const tool = await describeTool("tool:knowledge_source_inspect");
    expect(tool.isError).toBe(true);
    expect(tool.body).toMatchObject({ code: "NOT_FOUND", validPrefixes: ["tool:", "operation:", "skill:"] });
    expect(tool.body.valid).toEqual([...PLATFORM_TOOL_NAMES]);
    expect((await describeTool("skill:nothing")).body.valid).toEqual(SKILL_CATALOG.map((skill) => skill.name));
  });
});
