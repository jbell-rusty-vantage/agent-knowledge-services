import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { OperationKindSchema } from "../integration.js";
import {
  assertOperationInput,
  commandDescription,
  compactJsonSchema,
  describeReference,
  DESCRIBE_PREFIXES,
  inputJsonSchema,
  isKnowledgeOperationKind,
  OPERATION_CONTRACTS,
  OPERATION_INPUT_SCHEMAS,
  operationContractForKind,
  operationContractForTool,
  operationDescription,
  operationInputIssues,
  PLATFORM_TOOL_NAMES,
  SKILL_CATALOG,
  toolArgumentsExample,
  toolArgumentsSchema,
  toolDescription,
  toolListingSchema,
  VERIFICATION_REQUEST_SCHEMAS,
} from "./index.js";

const packageRoot = resolve(import.meta.dirname, "../..");
/** Every MCP tool with the contract of the operation it runs. */
const tools = OPERATION_CONTRACTS.flatMap((contract) => contract.mcp.map((tool) => [tool, contract] as const));

describe("operation contracts", () => {
  it("writes one contract for every operation kind, with the input the transports and the worker check", () => {
    for (const kind of OperationKindSchema.options) {
      // The lookup throws for a kind without a contract.
      const contract = operationContractForKind(kind);
      expect(contract.operation, kind).toBe(kind);
      expect(contract.input, kind).toBe(
        isKnowledgeOperationKind(kind) ? OPERATION_INPUT_SCHEMAS[kind] : VERIFICATION_REQUEST_SCHEMAS[kind],
      );
    }
    const names = OPERATION_CONTRACTS.map((contract) => contract.operation);
    expect(new Set(names).size).toBe(names.length);
    expect(new Set(PLATFORM_TOOL_NAMES).size).toBe(PLATFORM_TOOL_NAMES.length);
    expect(tools.map(([tool]) => tool)).toEqual(PLATFORM_TOOL_NAMES);
    for (const [tool, contract] of tools) expect(operationContractForTool(tool), tool).toBe(contract);
  });

  it("gives every operation and tool a real description of at most four short lines", () => {
    const refs = [
      ...OPERATION_CONTRACTS.map((contract) => `operation:${contract.operation}`),
      ...PLATFORM_TOOL_NAMES.map((tool) => `tool:${tool}`),
    ];
    for (const name of refs) {
      const answer = describeReference(name);
      expect(answer.ok, name).toBe(true);
      if (!answer.ok || answer.description.type === "skill") continue;
      const lines = answer.description.description.split("\n");
      expect(lines.length, name).toBeLessThanOrEqual(4);
      for (const line of lines) {
        expect(line.trim().length, `${name}: ${line}`).toBeGreaterThan(20);
        expect(line.length, `${name}: ${line}`).toBeLessThanOrEqual(190);
      }
      // No generated template, ticket ids, file paths or source file names.
      expect(answer.description.description, name).not.toMatch(
        /^Bounded |workflow over the|\b[A-Z]{2,5}-\d+\b|\bsrc\/|\.ts\b|\bapps\/|\bpackages\//u,
      );
    }
    for (const [tool] of tools) expect(toolDescription(tool), tool).not.toContain(`Bounded ${tool}`);
  });

  it("names only tools that exist, and rewrites them as ks commands for the command help", () => {
    for (const contract of OPERATION_CONTRACTS)
      for (const text of [contract, ...Object.values(contract.aliases ?? {})])
        for (const line of [text.summary, text.when, text.returns])
          for (const [name] of line.matchAll(/\b(?:knowledge|verify)_[a-z_]+\b/gu))
            expect(PLATFORM_TOOL_NAMES, `${contract.operation}: ${name}`).toContain(name);
    expect(commandDescription("knowledge source fetch")).toContain("ks knowledge document convert");
    expect(commandDescription("knowledge source fetch")).not.toContain("knowledge_document_convert");
    // A tool whose operation has no ks command keeps its tool name.
    expect(commandDescription("knowledge source discover")).toContain("knowledge_source_resolve");
    expect(commandDescription("no such command")).toBeUndefined();
  });

  it("validates every example with its own schema", () => {
    for (const contract of OPERATION_CONTRACTS) {
      const parsed = contract.input.safeParse(contract.example);
      expect(parsed.success, `${contract.operation}: ${parsed.error?.message}`).toBe(true);
      if (contract.kind) expect(operationInputIssues(contract.kind, contract.example), contract.operation).toEqual([]);
    }
    for (const [tool, contract] of tools) {
      const parsed = toolArgumentsSchema(contract).safeParse(toolArgumentsExample(contract));
      expect(parsed.success, `${tool}: ${parsed.error?.message}`).toBe(true);
    }
  });

  it("returns in every describe answer an example that its own schema accepts", () => {
    for (const [tool, contract] of tools) {
      const answer = describeReference(`tool:${tool}`);
      if (!answer.ok || answer.description.type !== "tool") throw new Error(`tool:${tool} was not described`);
      expect(toolArgumentsSchema(contract).safeParse(answer.description.example).success, tool).toBe(true);
      expect(answer.description.arguments.type, tool).toBe("object");
      expect(answer.description.surfaces.mcp, tool).toContain(tool);
    }
    for (const contract of OPERATION_CONTRACTS) {
      const answer = describeReference(`operation:${contract.operation}`);
      if (!answer.ok || answer.description.type !== "operation")
        throw new Error(`operation:${contract.operation} was not described`);
      expect(contract.input.safeParse(answer.description.example).success, contract.operation).toBe(true);
      expect(JSON.stringify(answer.description.input).length, contract.operation).toBeGreaterThan(20);
    }
  });

  it("resolves every related reference", () => {
    for (const contract of OPERATION_CONTRACTS)
      for (const ref of contract.related)
        expect(describeReference(ref).ok, `${contract.operation} -> ${ref}`).toBe(true);
  });

  it("describes every skill of the generated catalog, which matches skills/manifest.json", () => {
    expect(SKILL_CATALOG.length).toBeGreaterThanOrEqual(10);
    for (const skill of SKILL_CATALOG) {
      const answer = describeReference(`skill:${skill.name}`);
      expect(answer).toEqual({ ok: true, description: { ref: `skill:${skill.name}`, type: "skill", ...skill } });
      expect(skill.description.length, skill.name).toBeGreaterThan(20);
    }
    execFileSync(process.execPath, [resolve(packageRoot, "scripts/generate-skill-catalog.mjs"), "--check"], {
      stdio: "pipe",
      windowsHide: true,
    });
  });

  it("refuses an unknown reference with the valid prefixes and the names under the prefix used", () => {
    const unknownPrefix = describeReference("capture");
    expect(unknownPrefix).toMatchObject({
      ok: false,
      refusal: { code: "NOT_FOUND", ref: "capture", validPrefixes: DESCRIBE_PREFIXES, valid: [] },
    });
    const unknownTool = describeReference("tool:knowledge_source_inspect");
    expect(unknownTool.ok).toBe(false);
    if (!unknownTool.ok) {
      expect(unknownTool.refusal.validPrefixes).toEqual(["tool:", "operation:", "skill:"]);
      expect(unknownTool.refusal.valid).toEqual(PLATFORM_TOOL_NAMES);
    }
    const unknownOperation = describeReference("operation:nothing");
    expect(!unknownOperation.ok && unknownOperation.refusal.valid).toContain("capture");
    const unknownSkill = describeReference("skill:nothing");
    expect(!unknownSkill.ok && unknownSkill.refusal.valid).toContain("knowledge-verification");
  });
});

describe("operation input check", () => {
  it("accepts a valid input unchanged and reports every failure under input with its path", () => {
    const capture = operationContractForKind("capture").example as { request: Record<string, unknown> };
    expect(() => assertOperationInput("capture", capture)).not.toThrow();
    expect(operationInputIssues("capture", { ...capture, request: { ...capture.request, maximumBytes: 0 } })).toEqual([
      { path: "input.request.maximumBytes", message: expect.stringContaining("0") },
    ]);
    expect(operationInputIssues("capture", {})).toContainEqual({
      path: "input.schemaVersion",
      message: expect.any(String),
    });
    expect(operationInputIssues("chunk_set", null)).toEqual([{ path: "input", message: expect.any(String) }]);
    try {
      assertOperationInput("chunk_set", {});
      throw new Error("an invalid input was accepted");
    } catch (error) {
      expect(error).toBeInstanceOf(ZodError);
    }
  });

  it("reports the cross-field rules the published schema cannot express", () => {
    const capture = operationContractForKind("capture").example as { source: Record<string, unknown> };
    expect(
      operationInputIssues("capture", { ...capture, source: { ...capture.source, sensitivity: "restricted" } }),
    ).toEqual([{ path: "input.source.sensitivity", message: "source sensitivity must equal capture classification" }]);
  });

  it("checks the form the caller sent for the two kinds that accept two forms", () => {
    expect(
      operationInputIssues("vector_store_ingestion", { schemaVersion: "knowledge.vector-store-ingestion/v1" }).map(
        (issue) => issue.path,
      ),
    ).toEqual(["input.vectorStoreId", "input.chains"]);
    expect(
      operationInputIssues("vector_store_ingestion", { schemaVersion: "knowledge.selected-candidate-index/v1" }).map(
        (issue) => issue.path,
      ),
    ).toContain("input.selection");
    expect(
      operationInputIssues("vector_store_evaluation", {
        schemaVersion: "knowledge.selected-candidate-evaluation/v1",
      }).map((issue) => issue.path),
    ).toContain("input.candidate");
    expect(operationInputIssues("vector_store_evaluation", {}).map((issue) => issue.path)).toEqual([
      "input.vectorSpaceVersionId",
      "input.queryEmbedding",
    ]);
  });

  it("leaves verification kinds to their request schemas", () => {
    expect(operationInputIssues("verification_extraction", { anything: true })).toEqual([]);
  });
});

describe("generated OpenAPI document", () => {
  it("takes the summary and description of every route with a contract from that contract", () => {
    const document = JSON.parse(readFileSync(resolve(packageRoot, "generated/openapi.json"), "utf8")) as {
      paths: Record<string, Record<string, { summary: string; description?: string; requestBody?: unknown }>>;
    };
    let routes = 0;
    for (const contract of OPERATION_CONTRACTS)
      for (const route of contract.http) {
        const [method, path] = route.split(" ") as [string, string];
        const operation = document.paths[path]?.[method.toLowerCase()];
        expect(operation?.summary, route).toBe(contract.summary);
        expect(operation?.description, route).toBe(operationDescription(contract));
        routes += 1;
      }
    expect(routes).toBeGreaterThanOrEqual(45);
    // No route keeps a summary that says nothing about the operation.
    for (const [path, item] of Object.entries(document.paths))
      for (const [method, operation] of Object.entries(item))
        expect(operation.summary, `${method} ${path}`).not.toMatch(/^Admit a bounded knowledge mutation$/u);
  });

  it("publishes the input schema of every knowledge operation and types the routes that submit one", () => {
    const document = JSON.parse(readFileSync(resolve(packageRoot, "generated/openapi.json"), "utf8")) as {
      paths: Record<string, Record<string, { requestBody?: unknown }>>;
      components: { schemas: Record<string, unknown> };
    };
    for (const name of ["CaptureInput", "ChunkSetInput", "EvaluationRunInput", "VectorStoreEvaluationInput"])
      expect(document.components.schemas[name], name).toBeDefined();
    expect(JSON.stringify(document.paths["/v1/captures"]?.post?.requestBody)).toContain(
      "#/components/schemas/CaptureInput",
    );
    expect(JSON.stringify(document.paths["/v1/chunk-sets"]?.post?.requestBody)).toContain(
      "#/components/schemas/ChunkSetInput",
    );
  });
});

describe("published input schemas", () => {
  it("derives a full schema and a compact, typed listing schema for every tool", () => {
    for (const [tool, contract] of tools) {
      const full = inputJsonSchema(toolArgumentsSchema(contract));
      expect(full.type, tool).toBe("object");
      const listed = toolListingSchema(tool, 1);
      expect(listed?.type, tool).toBe("object");
      expect(JSON.stringify(listed).length, tool).toBeLessThan(JSON.stringify(full).length);
      if (contract.shape === "envelope") {
        const input = (listed?.properties as Record<string, Record<string, unknown>> | undefined)?.input;
        expect(input?.type, tool).toBe("object");
        // An input with required fields names them; nothing falls back to "any JSON".
        const required = inputJsonSchema(contract.input).required as string[] | undefined;
        if (required?.length) expect(input?.required, tool).toEqual(required);
      }
    }
  });

  it("keeps literals and required fields in the compact form and drops bounds and patterns", () => {
    const compact = compactJsonSchema(inputJsonSchema(operationContractForKind("chunk_set").input), 1);
    expect(compact).toEqual({
      type: "object",
      required: ["schemaVersion", "representationId", "profileName", "profileVersion"],
      properties: {
        schemaVersion: { const: "knowledge.chunk-set/v1" },
        representationId: { type: "string" },
        profileName: { type: "string" },
        profileVersion: { type: "string" },
      },
    });
  });
});
