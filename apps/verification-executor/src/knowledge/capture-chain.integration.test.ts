import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CaptureRegistrar, GovernedChainExecutor } from "@aiengineer/knowledge-db";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { disposableDatabaseUrl } from "../../../../packages/persistence/test/disposable.mjs";
import { RollbackPostgres } from "../../../../packages/persistence/test/rollback-postgres.mjs";
import { VerificationExecutor, loadExecutorConfig } from "../executor.js";
import { createVerificationMcpServer } from "../mcp.js";
import type { KnowledgeServices } from "./context.js";

/**
 * An agent's whole verification chain through the executor's own tools, on the AI Engineer lab database: it
 * captures a page and a probe's output, makes both quotable with source_prepare_captured, locates a quote, records a
 * claim anchored to it, registers a probe, records a run whose output is the second capture and proposes a verdict.
 * Every write runs as a bounded role (executor_service for the capture, pipeline_agent and verifier_agent for the
 * chain; the integration harness connects as the login role and switches with `set local role`), every scope is a savepoint of one transaction that is rolled back, and the lab's row counts are read on a
 * separate connection before and after. Needs KS_TEST_DATABASE_URL and KS_TEST_PROJECT_DIR; skips without them.
 */
const url = disposableDatabaseUrl() ?? "";
const TENANT = "00000000-0000-7000-8000-000000000001";
const COUNTED = [
  "acquisition.fetch",
  "orchestration.artifact",
  "evidence.source",
  "evidence.source_capture",
  "content.document",
  "content.document_version",
  "content.document_version_source_capture",
  "content.document_representation",
  "content.document_node",
  "evidence.locator",
  "evidence.claim",
  "verification.probe",
  "verification.probe_run",
  "verification.probe_verdict",
  "orchestration.operation_intent",
  "orchestration.operation_receipt",
  "orchestration.operation_receipt_target",
];

type Result = { isError?: boolean; content: { type: string; text: string }[] };
// biome-ignore lint/suspicious/noExplicitAny: a tool result is JSON whose fields the assertions read one by one
type Body = Record<string, any>;

async function counters(connectionString: string): Promise<Record<string, number>> {
  const client = new pg.Client({ connectionString, application_name: "ks-capture-chain-counters" });
  await client.connect();
  try {
    const counts: Record<string, number> = {};
    for (const table of COUNTED)
      counts[table] = Number((await client.query(`select count(*)::bigint as n from ${table}`)).rows[0].n);
    return counts;
  } finally {
    await client.end();
  }
}

describe.skipIf(!url)(
  "an agent's capture to an anchored claim and a verdict, through the executor (rolled back)",
  () => {
    const suffix = Date.now().toString(36);
    const quote = `A checkpointer saves the graph state after every super-step ${suffix}`;
    const page = [
      `# Persistence ${suffix}`,
      "",
      "LangGraph has a built-in persistence layer, implemented through checkpointers.",
      "",
      `${quote}, so a thread can be resumed.`,
      "",
      "- threads\n- checkpoints",
    ].join("\n");
    const runOutput = JSON.stringify(
      { probe: `KSCAP-${suffix}`, checks: { saves_after_superstep: true }, cells: 1 },
      null,
      2,
    );
    let before: Record<string, number> = {};
    let root = "";
    let db!: RollbackPostgres;
    const client = new Client({ name: "ks-capture-chain", version: "0" });
    let closeServer: () => Promise<void> = async () => undefined;

    const call = async (name: string, args: Record<string, unknown>) => {
      const result = (await client.callTool({ name, arguments: args })) as Result;
      const body = JSON.parse(result.content[0]?.text ?? "null") as Body;
      if (result.isError) throw Object.assign(new Error(`${name}: ${JSON.stringify(body)}`), { body });
      return body;
    };
    const write = async (operation: string, name: string, input: Record<string, unknown>) =>
      (
        await call("chain_write", {
          request: {
            operation,
            idempotency_key: `ks-capture-chain:${suffix}:${name}`,
            input,
            actor: { label: "ks:capture-chain-test" },
          },
        })
      ).result as Body;

    beforeAll(async () => {
      before = await counters(url);
      root = await mkdtemp(join(tmpdir(), "ks-capture-chain-"));
      const executor = await VerificationExecutor.create(
        loadExecutorConfig({ VERIFY_STORE_DIR: root, VERIFY_TENANT_ID: TENANT }),
      );
      db = await RollbackPostgres.open(url);
      const services = {
        config: { defaultTenantId: TENANT },
        chain: new GovernedChainExecutor({ db }),
        captures: new CaptureRegistrar({ db, executorVersion: "knowledge-executor/test" }),
        captureStore: executor.store,
        remoteCustody: false,
      } as unknown as KnowledgeServices;
      const server = createVerificationMcpServer(executor, services);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      closeServer = () => server.close();
    });

    afterAll(async () => {
      await client.close();
      await closeServer();
      await db?.close();
      if (root) await rm(root, { recursive: true, force: true });
      // The lab is left as found: every scope was rolled back with the outer transaction.
      expect(await counters(url)).toEqual(before);
    });

    it("goes from a capture it made to an anchored claim, a probe run with captured output and a verdict", async () => {
      // 1. Capture a page the agent holds (no network), and locate the quote in the captured text.
      const captured = await call("verify_capture_file", {
        filename: `persistence-${suffix}.md`,
        text: page,
        sourceUri: `https://docs.example.test/persistence/${suffix}`,
      });
      const located = await call("verify_locate_quote", { captureId: captured.captureId, quote });
      expect(located).toMatchObject({ status: "resolved", occurrenceCount: 1 });

      // 2. Make it quotable: one call returns the database capture, its units and the anchor of the quote.
      const prepared = await call("source_prepare_captured", {
        captureId: captured.captureId,
        title: "Persistence (test page)",
        quotes: [quote, "words that are not on the page at all"],
      });
      expect(prepared).toMatchObject({
        executor_capture_id: captured.captureId,
        media_type: "text/markdown",
        replayed: false,
        role: "executor_service",
        custody: { remote: false, storage_state: "pending" },
      });
      expect(prepared.units.map((unit: { unit_kind: string }) => unit.unit_kind)).toEqual([
        "section",
        "paragraph",
        "paragraph",
        "list",
      ]);
      expect(prepared.units[2]).toMatchObject({ start_offset: page.indexOf(quote) });
      expect(prepared.anchors[0]).toMatchObject({
        status: "found",
        unit_kind: "paragraph",
        anchor: { capture_id: prepared.capture_id, node_id: prepared.units[2].anchor.node_id, quote },
      });
      expect(prepared.anchors[1]).toEqual({
        quote: "words that are not on the page at all",
        status: "not_in_one_unit",
      });

      // The same bytes again: the same capture, nothing new written.
      const again = await call("source_prepare_captured", { captureId: captured.captureId });
      expect(again).toMatchObject({
        replayed: true,
        capture_id: prepared.capture_id,
        receipt: prepared.receipt,
        units_total: prepared.units_total,
      });
      // The contract declares no intent type for a capture registration yet, so none is filed (and the result says so).
      expect(prepared.receipt).toMatchObject({
        receipt_id: null,
        unavailable: expect.stringContaining("INTENT_TYPE_UNDECLARED"),
      });
      // evidence_units finds the unit by the new capture, with the same anchor.
      const units = await call("evidence_units", { captureId: prepared.capture_id, text: "super-step" });
      expect(units.units.map((unit: { anchor: unknown }) => unit.anchor)).toEqual([
        { capture_id: prepared.capture_id, node_id: prepared.anchors[0].anchor.node_id },
      ]);

      // 3. Record the claim anchored to the quote; restating is not needed for a direct statement.
      const claim = await write("record_claim", "claim", {
        claim_type: "assertion",
        statement: `KS capture chain ${suffix}: a checkpointer saves the graph state after every super-step.`,
        evidence: [{ ...prepared.anchors[0].anchor, role: "supports" }],
        structured: { path: "official_docs", source_role: "first_party" },
      });
      expect(claim).toMatchObject({ created: true, status: "proposed" });
      expect(claim.locator_ids).toHaveLength(1);

      // 4. Register a probe that tests it.
      const probe = await write("register_probe", "probe", {
        slug: `KSCAP-${suffix}`,
        title: "Checkpointer saves after each super-step",
        hypothesis: "the saved checkpoints advance once per super-step",
        kind: "executed",
        claims: [{ claim_id: claim.claim_id, expectation: { expected: "one checkpoint per super-step" } }],
        matrix: [{ label: "cell-a" }],
        model_policy: "fake",
      });
      expect(probe).toMatchObject({ state: "active", claims: 1 });

      // 5. Capture the run's output the same way, and record the run with it as a json_pointer anchor.
      const output = await call("verify_capture_file", { filename: `run-${suffix}.json`, text: runOutput });
      const outputUnits = await call("source_prepare_captured", {
        captureId: output.captureId,
        quotes: ['"saves_after_superstep": true'],
      });
      expect(outputUnits).toMatchObject({ media_type: "application/json", replayed: false });
      const checks = outputUnits.units.find((unit: { pointer?: string }) => unit.pointer === "/checks");
      expect(checks).toMatchObject({ unit_kind: "metadata_field", start_offset: runOutput.indexOf('"checks"') });
      expect(outputUnits.anchors[0]).toMatchObject({ status: "found", anchor: { node_id: checks.anchor.node_id } });
      const run = await write("record_probe_run", "run", {
        probe_id: probe.probe_id,
        cell_label: "cell-a",
        outcome: "pass",
        started_at: new Date(Date.now() - 60_000).toISOString(),
        observations: { checks: { saves_after_superstep: true } },
        output: {
          ...checks.anchor,
          selector_kind: "json_pointer",
          pointer: "/checks",
          quote: '"saves_after_superstep": true',
        },
      });
      expect(run).toMatchObject({
        outcome: "pass",
        output_capture_id: outputUnits.capture_id,
        origin_kind: "standalone",
      });

      // 6. Propose the verdict; it stays a proposal and the claim stays proposed.
      const verdict = await write("propose_verdict", "verdict", {
        claim_id: claim.claim_id,
        probe_id: probe.probe_id,
        verdict: "directly_supported",
        cells: { "cell-a": { saves_after_superstep: true } },
        rationale: "the run observed one checkpoint per super-step",
      });
      expect(verdict).toMatchObject({
        written: true,
        verdict: "directly_supported",
        review_state: "agent_proposed",
        claim_status: "proposed",
      });

      // The capture rows were written by executor_service under a receipt, and an HTML capture keeps the page bytes.
      const html = await call("verify_capture_file", {
        filename: `page-${suffix}.html`,
        text: `<html><head><title>T ${suffix}</title></head><body><h1>Title ${suffix}</h1><p>First paragraph ${suffix}.</p><p>Second paragraph.</p></body></html>`,
        sourceUri: `https://docs.example.test/page/${suffix}`,
      });
      const htmlUnits = await call("source_prepare_captured", {
        captureId: html.captureId,
        quotes: [`First paragraph ${suffix}.`],
      });
      expect(htmlUnits).toMatchObject({ media_type: "text/html" });
      expect(htmlUnits.anchors[0]).toMatchObject({ status: "found" });
      const rows = await db.transaction(
        { tenantId: TENANT, role: "executor_service", readOnly: true },
        async (sql) =>
          (
            await sql.query(
              `select c.media_type, c.capture_method, r.representation_class, r.media_type as representation_media_type,
                  c.context ->> 'custody' as custody, f.tool, f.origin_kind, a.storage_state, a.artifact_type
             from evidence.source_capture c
             join content.document_version_source_capture vc on vc.source_capture_id = c.id
             join content.document_representation r on r.document_version_id = vc.document_version_id
             join acquisition.fetch f on f.id = c.acquisition_fetch_id
             join orchestration.artifact a on a.id = c.artifact_id
            where c.id = $1`,
              [htmlUnits.capture_id],
            )
          ).rows,
      );
      expect(rows).toEqual([
        {
          media_type: "text/html",
          capture_method: "other",
          representation_class: "faithful_normalization",
          representation_media_type: "text/markdown; charset=utf-8",
          custody: "local",
          tool: "upload",
          origin_kind: "native_harness",
          storage_state: "pending",
          artifact_type: "source_capture",
        },
      ]);
    });
  },
);
