/**
 * The executor's tool list as an agent receives it, with the knowledge database configured and every tool group
 * registered: it stays under a byte ceiling, every large input is published in a short form whose full schema
 * `knowledge_describe` returns, and the server still validates a call with the full schema before anything runs.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CHAIN_OPERATION_NAMES, CHAIN_OPERATIONS, inputJsonSchema } from "@aiengineer/knowledge-contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { KnowledgeServices } from "./knowledge/context.js";
import { knowledgeOperations } from "./knowledge/operations.js";
import { createVerificationMcpServer } from "./mcp.js";
import { EXECUTOR_INSTRUCTIONS, PUBLISH_WHOLE_BYTES } from "./tool-catalog.js";

/** The ceiling of `tools/list`, in bytes of its JSON (about 9,000 tokens at four bytes a token). */
const TOOL_LIST_CEILING_BYTES = 36_000;

type Listed = { name: string; description?: string; inputSchema: Record<string, unknown> };
type Result = { isError?: boolean; content: { type: string; text: string }[] };
const TENANT = "00000000-0000-7000-8000-000000000001";
const id = (n: number) => `0192b000-0000-7000-8000-${String(n).padStart(12, "0")}`;

describe("executor tool list", () => {
  const chainWrites: unknown[] = [];
  const reached: string[] = [];
  // Knowledge services whose every backend refuses: a call that reaches one was not stopped by validation.
  const services = {
    config: { defaultTenantId: TENANT },
    chain: {
      write: async (tenantId: string, request: unknown) => {
        chainWrites.push({ tenantId, request });
        return {
          operation: "record_claim",
          function: "api.record_claim",
          role: "pipeline_agent",
          result: { ok: true },
        };
      },
      evidenceUnits: async () => ({ units: [], truncated: false, role: "executor_service" }),
    },
    checkpoints: new Proxy(
      {},
      {
        get: (_target, method) => async () => {
          reached.push(`checkpoints.${String(method)}`);
          throw new Error("BACKEND_REACHED");
        },
      },
    ),
    sourceDiscovery: new Proxy(
      {},
      {
        get: (_target, method) => async () => {
          reached.push(`sourceDiscovery.${String(method)}`);
          throw new Error("BACKEND_REACHED");
        },
      },
    ),
  } as unknown as KnowledgeServices;
  const server = createVerificationMcpServer({} as never, services, { service: undefined, credential: () => null });
  const client = new Client({ name: "executor-tool-list", version: "0" });
  let tools: Listed[] = [];
  let listBytes = 0;

  const call = async (name: string, args: Record<string, unknown>): Promise<Result> => {
    try {
      return (await client.callTool({ name, arguments: args })) as Result;
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
      };
    }
  };
  const json = (result: Result) => JSON.parse(result.content[0]?.text ?? "null") as Record<string, unknown>;
  const describeRef = async (ref: string) => json(await call("knowledge_describe", { ref }));

  beforeAll(async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const listed = await client.listTools();
    tools = listed.tools as Listed[];
    listBytes = Buffer.byteLength(JSON.stringify({ tools: listed.tools }), "utf8");
  });
  afterAll(async () => {
    await client.close();
    await server.close();
  });

  it(`stays under ${TOOL_LIST_CEILING_BYTES} bytes with every tool group registered`, () => {
    const names = tools.map((tool) => tool.name);
    for (const name of [
      ...knowledgeOperations.list().map((operation) => operation.name),
      "chain_write",
      "evidence_units",
    ])
      expect(names).toContain(name);
    for (const name of ["knowledge_guide", "knowledge_describe", "knowledge_operation_invoke", "verify_capture_source"])
      expect(names).toContain(name);
    expect(names.length).toBeGreaterThanOrEqual(42);
    const largest = tools
      .map((tool) => [tool.name, JSON.stringify(tool).length] as const)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
    expect(
      listBytes,
      `tools/list is ${listBytes} bytes for ${names.length} tools; largest: ${JSON.stringify(largest)}`,
    ).toBeLessThanOrEqual(TOOL_LIST_CEILING_BYTES);
  });

  it("publishes a short form of every large input and says where the full one is", async () => {
    expect(EXECUTOR_INSTRUCTIONS).toContain("knowledge_describe");
    expect(client.getInstructions()).toBe(EXECUTOR_INSTRUCTIONS);
    let short = 0;
    for (const tool of tools) {
      const described = await describeRef(`tool:${tool.name}`);
      expect(described, tool.name).toMatchObject({ ref: `tool:${tool.name}`, type: "tool", name: tool.name });
      const full = described.arguments as Record<string, unknown>;
      expect(full.type, tool.name).toBe("object");
      if (JSON.stringify(full).length <= PUBLISH_WHOLE_BYTES) {
        expect(tool.inputSchema, tool.name).toEqual(full);
        continue;
      }
      short += 1;
      expect(String(tool.inputSchema.description), tool.name).toContain(`tool:${tool.name}`);
      expect(JSON.stringify(tool.inputSchema).length, tool.name).toBeLessThan(JSON.stringify(full).length);
      // Every top-level field of the full schema is still named in the list, required or not.
      expect(Object.keys(tool.inputSchema.properties as object).sort(), tool.name).toEqual(
        Object.keys(full.properties as object).sort(),
      );
      expect(tool.inputSchema.required ?? [], tool.name).toEqual(full.required ?? []);
    }
    expect(short).toBeGreaterThanOrEqual(5);
    // The five inputs that were most of the list are all in short form now.
    for (const name of [
      "checkpoint_commit",
      "source_import",
      "checkpoint_harness",
      "checkpoint_restore",
      "checkpoint_read",
    ])
      expect(JSON.stringify(tools.find((tool) => tool.name === name)?.inputSchema).length, name).toBeLessThan(1_600);
  });

  it("describes a tool with the schema the server validates with", async () => {
    for (const operation of knowledgeOperations.list()) {
      const described = await describeRef(`tool:${operation.name}`);
      expect(described.arguments, operation.name).toEqual(inputJsonSchema(operation.published ?? operation.input));
      expect(described.surfaces, operation.name).toMatchObject({
        cli: [`knowledge ${operation.cli.command.join(" ")}`],
        http: [`POST /knowledge/${operation.name}`],
      });
    }
    const unknown = await call("knowledge_describe", { ref: "tool:nothing" });
    expect(unknown.isError).toBe(true);
    expect(json(unknown)).toMatchObject({ code: "NOT_FOUND", validPrefixes: ["tool:", "operation:"] });
    expect((json(unknown).valid as string[]).length).toBe(tools.length);
    // Without a reference the tool still answers for the K01 binding (refused here: no service is configured).
    expect(JSON.stringify(json(await call("knowledge_describe", {})))).toContain("CAPABILITY_UNAVAILABLE");
  });

  it("still validates with the full schema: an input the short form would admit is refused before the backend", async () => {
    // The short form of checkpoint_commit lists only the required fields of `request` and their types.
    const listed = tools.find((tool) => tool.name === "checkpoint_commit")?.inputSchema as {
      properties: { request: { required: string[] } };
    };
    const hollow = Object.fromEntries(listed.properties.request.required.map((name) => [name, {}]));
    const refusedCommit = await call("checkpoint_commit", { request: hollow });
    expect(refusedCommit.isError).toBe(true);
    const refusedImport = await call("source_import", { receipt: { provider: 7 } });
    expect(refusedImport.isError).toBe(true);
    const refusedRestore = await call("checkpoint_restore", { request: {}, tenantId: "not-a-uuid" });
    expect(refusedRestore.isError).toBe(true);
    for (const result of [refusedCommit, refusedImport, refusedRestore])
      expect(result.content[0]?.text).not.toContain("BACKEND_REACHED");
    expect(reached).toEqual([]);
  });

  it("serves the nine chain operations through one tool, each described in full on demand", async () => {
    const tool = tools.find((item) => item.name === "chain_write") as Listed;
    for (const name of CHAIN_OPERATION_NAMES) expect(tool.description).toContain(name);
    const request = (tool.inputSchema.properties as { request: { properties: Record<string, { enum?: string[] }> } })
      .request;
    expect(request.properties.operation?.enum).toEqual(CHAIN_OPERATION_NAMES);
    const described = await describeRef("tool:chain_write");
    expect((described.operations as { ref: string }[]).map((item) => item.ref)).toEqual(
      CHAIN_OPERATIONS.map((operation) => `operation:${operation.operation}`),
    );
    expect(JSON.stringify(described.notes)).toContain("append-only");
    for (const operation of CHAIN_OPERATIONS) {
      const one = await describeRef(`operation:${operation.operation}`);
      expect(one, operation.operation).toMatchObject({
        type: "chain_operation",
        function: operation.function,
        role: operation.role,
        input: { type: "object", additionalProperties: false },
      });
      // The example it returns is a call the tool accepts.
      const before = chainWrites.length;
      const accepted = await call("chain_write", { request: one.example as Record<string, unknown> });
      expect(accepted.isError, operation.operation).not.toBe(true);
      expect(chainWrites.length).toBe(before + 1);
      expect(chainWrites.at(-1)).toEqual({ tenantId: TENANT, request: one.example });
    }
    const unknown = await call("knowledge_describe", { ref: "operation:verify_claim" });
    expect(json(unknown)).toMatchObject({ code: "NOT_FOUND", valid: CHAIN_OPERATION_NAMES });
    const units = await call("evidence_units", { text: "checkpoint", limit: 3 });
    expect(json(units)).toMatchObject({ role: "executor_service" });
    expect((await call("evidence_units", { capture_id: id(1) })).isError).toBe(true);
  });
});
