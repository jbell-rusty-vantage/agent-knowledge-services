import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeError } from "@aiengineer/knowledge-db";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineOperation, OperationRegistry, type AnyOperation } from "../operations/define.js";
import { buildInput, exitCodeFor, GateError, parseArgv, UsageError } from "./cli.js";
import { knowledgeOperations } from "./operations.js";

describe("operation registry", () => {
  it("exposes knowledge operations with CLI bindings and short descriptions", () => {
    const names = knowledgeOperations.list().map((operation) => operation.name);
    expect(names).toEqual([
      "source_prepare_captured",
      "checkpoint_harness",
      "checkpoint_commit",
      "checkpoint_head",
      "checkpoint_read",
      "checkpoint_restore",
      "checkpoint_tombstone",
      "schema_search",
      "schema_get",
      "schema_manifest",
      "schema_materialize",
      "db_head",
      "db_read_intent",
      "db_sql_readonly",
      "db_explain",
      "ingest_plan",
      "ingest_apply",
      "ingest_receipt",
      "artifact_get",
      "source_discover",
      "source_import",
      "source_attempt",
      "source_reconcile",
      "source_select",
    ]);
    expect(knowledgeOperations.byCommand("db", "read-intent")?.name).toBe("db_read_intent");
    expect(knowledgeOperations.list().every((operation) => operation.description.length <= 300)).toBe(true);
  });

  it("validates input and output through one path", async () => {
    const echo = defineOperation({
      name: "echo_it",
      title: "Echo",
      description: "echo",
      input: z.object({ value: z.number() }),
      output: z.object({ doubled: z.number() }),
      cli: { command: ["x", "echo"], positional: ["value"] },
      run: async (input) => ({ doubled: input.value * 2 }),
    });
    const registry = new OperationRegistry<undefined>([echo]);
    expect((await registry.invoke("echo_it", { value: 2 }, undefined)).output).toEqual({ doubled: 4 });
    await expect(registry.invoke("echo_it", { value: "x" }, undefined)).rejects.toHaveProperty("issues");
    await expect(registry.invoke("nope", {}, undefined)).rejects.toMatchObject({ name: "UnknownOperationError" });
    expect(() => defineOperation({ ...echo, description: "x".repeat(301) })).toThrow(/exceeds/);
  });
});

describe("knowledge CLI argument mapping", () => {
  const dir = mkdtempSync(join(tmpdir(), "ks-cli-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("maps positionals, camelCases flags, coerces JSON, and reads JSON files", async () => {
    const intentPath = join(dir, "intent.json");
    writeFileSync(intentPath, JSON.stringify({ schemaVersion: "knowledge-read-intent.v1" }));
    const parsed = parseArgv([
      intentPath,
      "--persist",
      "--expected-head",
      "41",
      "--tenant",
      "00000000-0000-7000-8000-000000000001",
      "--out",
      "x.json",
    ]);
    const input = await buildInput(knowledgeOperations.get("db_read_intent") as AnyOperation<unknown>, parsed);
    expect(input).toEqual({
      intent: { schemaVersion: "knowledge-read-intent.v1" },
      persist: true,
      expectedHead: 41,
      tenantId: "00000000-0000-7000-8000-000000000001",
    });
    const sql = await buildInput(
      knowledgeOperations.get("db_sql_readonly") as AnyOperation<unknown>,
      parseArgv(["select 1", "--params", '[1,"a"]', "--limit", "5"]),
    );
    expect(sql).toEqual({ sql: "select 1", params: [1, "a"], limit: 5 });
  });

  it("maps errors onto the exit lattice", () => {
    expect(exitCodeFor(new KnowledgeError("PARAMS_INVALID", "bad", 1))).toBe(1);
    expect(exitCodeFor(new KnowledgeError("HEAD_MISMATCH", "stale", 2))).toBe(2);
    expect(exitCodeFor(new GateError({}, "plan rejected"))).toBe(1);
    expect(exitCodeFor(new UsageError("usage"))).toBe(2);
    expect(exitCodeFor(new Error("boom"))).toBe(2);
  });
});
