/**
 * The guide on the executor: the pages the platform server serves, from the same module, for an agent that has only
 * this server. Every executor tool and command a guide page names is one this executor implements.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  GUIDE_FILES,
  GUIDE_JOBS,
  GUIDE_UNASSIGNED,
  guidePage,
  guideToolUniverse,
  guideTopics,
  PLATFORM_TOOL_NAMES,
  toolDescription,
} from "@aiengineer/knowledge-contracts";
import { runKnowledgeCli } from "./knowledge/cli.js";
import { knowledgeOperations } from "./knowledge/operations.js";
import { createVerificationMcpServer } from "./mcp.js";

const page = (topic?: string) => {
  const result = guidePage(topic);
  if (!result.ok) throw new Error(`guide topic ${topic} was refused`);
  return result.markdown;
};
const spans = (markdown: string) => [...markdown.matchAll(/`([^`\n]+)`/gu)].map((match) => match[1] as string);

describe("executor guide", () => {
  // Every tool group the executor can register: capture and artifact tools, the knowledge registry and K01.
  const full = createVerificationMcpServer({} as never, {} as never, { service: undefined, credential: () => null });
  // The executor as it starts without a database: the guide must still be there.
  const bare = createVerificationMcpServer({} as never);
  const client = new Client({ name: "executor-guide", version: "0" });
  const bareClient = new Client({ name: "executor-guide-bare", version: "0" });
  let tools: { name: string; description?: string; inputSchema: { properties?: Record<string, unknown> } }[] = [];
  let bareTools: string[] = [];
  beforeAll(async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await full.connect(serverTransport);
    await client.connect(clientTransport);
    tools = (await client.listTools()).tools as typeof tools;
    const [bareClientTransport, bareServerTransport] = InMemoryTransport.createLinkedPair();
    await bare.connect(bareServerTransport);
    await bareClient.connect(bareClientTransport);
    bareTools = (await bareClient.listTools()).tools.map((tool) => tool.name);
  });
  afterAll(async () => {
    await client.close();
    await full.close();
    await bareClient.close();
    await bare.close();
  });

  it("registers knowledge_guide with the platform tool's description and input, with or without a database", () => {
    const guide = tools.find((tool) => tool.name === "knowledge_guide");
    expect(guide?.description).toBe(toolDescription("knowledge_guide"));
    expect(guide?.inputSchema.properties).toHaveProperty("topic");
    expect(bareTools).toContain("knowledge_guide");
  });

  it("returns the start page, every skill and every reference as the Markdown the platform returns", async () => {
    const start = await client.callTool({ name: "knowledge_guide", arguments: {} });
    expect((start.content as { type: string; text: string }[])[0]).toEqual({ type: "text", text: page() });
    for (const topic of guideTopics()) {
      const result = await client.callTool({ name: "knowledge_guide", arguments: { topic } });
      expect(result.isError, topic).not.toBe(true);
      expect((result.content as { text: string }[])[0]?.text, topic).toBe(page(topic));
    }
    const refused = await client.callTool({ name: "knowledge_guide", arguments: { topic: "nothing" } });
    expect(refused.isError).toBe(true);
    expect((refused.content as { text: string }[])[0]?.text).toContain("`knowledge-research`");
  });

  it("implements every executor tool the guide names, and the guide names every tool it implements", () => {
    const implemented = tools.map((tool) => tool.name).sort();
    expect([...guideToolUniverse().executor].sort()).toEqual(implemented);
    const assigned = [...GUIDE_JOBS.flatMap((job) => job.executor), ...GUIDE_UNASSIGNED.executor, "knowledge_guide"];
    expect([...assigned].sort()).toEqual(implemented);
  });

  it("names in every page only tools that exist on the platform or on this executor", () => {
    const known = new Set([...PLATFORM_TOOL_NAMES, ...tools.map((tool) => tool.name), ...guideToolUniverse().jev]);
    const toolLike = /^(?:knowledge|verify|schema|db|ingest|artifact|source|checkpoint|jev)_[a-z0-9_]+$/u;
    for (const topic of guideTopics().filter((name) => name.startsWith("knowledge-research") || name === "tools"))
      for (const span of spans(page(topic)))
        if (toolLike.test(span)) expect(known.has(span), `${topic}: ${span}`).toBe(true);
  });

  it("names in the research skill only executor commands that exist", () => {
    const verifyCli = readFileSync(join(import.meta.dirname, "index.ts"), "utf8");
    const verifyCommands = new Set([...verifyCli.matchAll(/case "([a-z][a-z-]*)":/gu)].map((match) => match[1]));
    let checked = 0;
    for (const [file, text] of Object.entries(GUIDE_FILES).filter(([name]) => name.startsWith("knowledge-research/")))
      for (const span of spans(text)) {
        const verify = /^knowledge-verify ([a-z][a-z-]*)$/u.exec(span);
        if (verify) {
          expect(verifyCommands.has(verify[1]), `${file}: ${span}`).toBe(true);
          checked += 1;
        }
        const knowledge = /^knowledge ([a-z][a-z-]*) ([a-z][a-z-]*)$/u.exec(span);
        if (knowledge) {
          expect(
            knowledgeOperations.byCommand(knowledge[1] as string, knowledge[2] as string),
            `${file}: ${span}`,
          ).toBeDefined();
          checked += 1;
        }
      }
    expect(checked).toBeGreaterThan(20);
  });

  it("prints a page from the knowledge command line, offline", async () => {
    const written: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    try {
      await runKnowledgeCli(["guide"], {});
      await runKnowledgeCli(["guide", "knowledge-verify"], {});
    } finally {
      write.mockRestore();
    }
    expect(written).toEqual([page(), page("knowledge-verify")]);
    await expect(runKnowledgeCli(["guide", "nothing"], {})).rejects.toThrow(/Valid topics: start, tools, topics/u);
    await expect(runKnowledgeCli(["guide", "a", "b"], {})).rejects.toThrow(/at most one topic/u);
  });
});
