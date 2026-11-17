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
 * Each registration leaves an operation intent, a receipt and receipt targets (contract 0.10.0), and a quote against a
 * unit with no text, or a quote of only whitespace, is refused as the executor returns it.
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
        quotes: [quote, "words that are not on the page at all", "\t \n"],
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
      // A quote of only whitespace is in no unit (the database refuses it as no quote).
      expect(prepared.anchors[2]).toEqual({ quote: "\t \n", status: "not_in_one_unit" });

      // The same bytes again: the same capture, nothing new written.
      const again = await call("source_prepare_captured", { captureId: captured.captureId });
      expect(again).toMatchObject({
        replayed: true,
        capture_id: prepared.capture_id,
        receipt: prepared.receipt,
        units_total: prepared.units_total,
      });
      // Contract 0.10.0 declares the intent type capture_registration: the registration is filed on the ledger as an
      // intent, its receipt and receipt targets, written as executor_service in the same transaction.
      const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
      expect(prepared.receipt).toEqual({
        intent_id: expect.stringMatching(UUID),
        receipt_id: expect.stringMatching(UUID),
      });
      expect(JSON.stringify(prepared)).not.toContain("INTENT_TYPE_UNDECLARED");
      const ledger = await db.transaction(
        { tenantId: TENANT, role: "executor_service", readOnly: true },
        async (sql) =>
          (
            await sql.query(
              `select i.intent_type, i.payload ->> 'operation' as operation, i.payload ->> 'executor_capture_id' as executor_capture_id,
                      i.approval_state, i.origin_kind, r.id::text as receipt_id, r.outcome, r.executor_version,
                      (select string_agg(t.target_schema || '.' || t.target_table || ':' || t.role || ':' || t.action || ':' || t.target_id, ' ' order by t.ordinal)
                         from orchestration.operation_receipt_target t where t.tenant_id = i.tenant_id and t.receipt_id = r.id) as targets
                 from orchestration.operation_intent i join orchestration.operation_receipt r on r.intent_id = i.id
                where i.tenant_id = $1 and i.id = $2`,
              [TENANT, prepared.receipt.intent_id],
            )
          ).rows,
      );
      expect(ledger).toEqual([
        {
          intent_type: "capture_registration",
          operation: "source_prepare_captured",
          executor_capture_id: captured.captureId,
          approval_state: "approved",
          origin_kind: "standalone",
          receipt_id: prepared.receipt.receipt_id,
          outcome: "applied",
          executor_version: "knowledge-executor/test",
          targets: [
            `evidence.source_capture:subject:created:${prepared.capture_id}`,
            `evidence.source:provenance:created:${prepared.source_id}`,
            `acquisition.fetch:provenance:created:${prepared.fetch_id}`,
          ].join(" "),
        },
      ]);
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

      // A unit with no text holds no quote. The executor's grammar never makes one, so the test adds a unit with NULL
      // text to the registered representation (as executor_service, rolled back) and anchors to it; a quote of only
      // whitespace is refused against a unit that has text.
      const emptyNode = await db.transaction({ tenantId: TENANT, role: "executor_service" }, async (sql) =>
        String(
          (
            await sql.query<{ id: string }>(
              `insert into content.document_node(tenant_id, representation_id, ordinal, stable_local_key, unit_kind, inline_text, normalized_content_sha256)
               values ($1, $2, 9999, $3, 'paragraph', null, repeat('0', 64)) returning id::text as id`,
              [TENANT, prepared.representation_id, `ks-capture-chain-empty-${suffix}`],
            )
          ).rows[0]?.id,
        ),
      );
      const refused = async (name: string, evidence: Record<string, unknown>) => {
        try {
          await write("record_claim", name, {
            claim_type: "assertion",
            statement: `KS capture chain ${suffix}: ${name}.`,
            evidence: [evidence],
          });
        } catch (error) {
          return (error as { body?: Body }).body;
        }
        throw new Error(`${name}: record_claim was accepted`);
      };
      expect(await refused("empty-unit", { capture_id: prepared.capture_id, node_id: emptyNode, quote })).toMatchObject(
        {
          code: "QUOTE_NOT_IN_UNIT",
          details: { class: "state_refuses" },
        },
      );
      expect(
        await refused("whitespace-quote", {
          capture_id: prepared.capture_id,
          node_id: prepared.units[2].anchor.node_id,
          quote: "\t\n",
        }),
      ).toMatchObject({ code: "QUOTE_REQUIRED", details: { class: "malformed" } });

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
      // Every registration of this test (page, run output, HTML page) left one receipt with its three targets.
      const filed = await db.transaction(
        { tenantId: TENANT, role: "executor_service", readOnly: true },
        async (sql) =>
          (
            await sql.query<{ receipts: string; targets: string }>(
              `select count(distinct r.id)::text as receipts, count(t.*)::text as targets
               from orchestration.operation_intent i join orchestration.operation_receipt r on r.intent_id = i.id
               left join orchestration.operation_receipt_target t on t.tenant_id = i.tenant_id and t.receipt_id = r.id
              where i.tenant_id = $1 and i.intent_type = 'capture_registration' and i.payload ->> 'executor_capture_id' = any($2::text[])`,
              [TENANT, [captured.captureId, output.captureId, html.captureId]],
            )
          ).rows[0],
      );
      expect(filed).toEqual({ receipts: "3", targets: "9" });
      expect([outputUnits.receipt.receipt_id, htmlUnits.receipt.receipt_id]).not.toContain(null);
    });
  },
);
