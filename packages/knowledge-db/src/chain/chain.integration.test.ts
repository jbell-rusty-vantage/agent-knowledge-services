import { CHAIN_OPERATIONS, type ChainOperationName } from "@aiengineer/knowledge-contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { disposableDatabaseUrl } from "../../../persistence/test/disposable.mjs";
import { RollbackPostgres } from "../../../persistence/test/rollback-postgres.mjs";
import type { KnowledgeRole } from "../ports.js";
import { isKnowledgeError, type KnowledgeError } from "../schema-workspace/index.js";
import { GovernedChainExecutor, type EvidenceUnit } from "./executor.js";
import { chainFunctionSignature } from "./functions.js";

/**
 * The whole research verification chain through the Knowledge Services operation layer, as the bounded roles, on an
 * AI Engineer database at contract 0.10.0 (migration 20261116150000) that holds captured content. Every scope is a
 * savepoint of one transaction that `close()` rolls back, so the database is left as found. Needs
 * `KS_TEST_DATABASE_URL` and `KS_TEST_PROJECT_DIR` (the disposable-project guard); skips without them.
 */
const url = disposableDatabaseUrl();
const TENANT = "00000000-0000-7000-8000-000000000001";

describe.skipIf(!url)("governed verification chain on the AI Engineer database (rolled back)", () => {
  const suffix = Date.now().toString(36);
  const key = (name: string) => `ks-chain-test:${suffix}:${name}`;
  const actor = { label: "ks:chain-integration-test" };
  let db!: RollbackPostgres;
  let chain!: GovernedChainExecutor;
  let unit!: EvidenceUnit;
  let quote = "";
  let source = "";

  const write = async (operation: ChainOperationName, name: string, input: Record<string, unknown>) =>
    (await chain.write(TENANT, { operation, idempotency_key: key(name), input, actor })).result;
  const refused = async (work: Promise<unknown>): Promise<KnowledgeError> => {
    const error = await work.then(
      () => undefined,
      (caught: unknown) => caught,
    );
    if (!isKnowledgeError(error)) throw new Error(`expected a refusal, got ${String(error)}`);
    return error;
  };
  const as = <T>(role: KnowledgeRole, readOnly: boolean, sql: string, values: unknown[] = []) =>
    db.transaction(
      { tenantId: TENANT, role, readOnly },
      async (client) => (await client.query(sql, values)).rows as T[],
    );
  /** SQLSTATE and message of a statement a bounded role is expected to be refused. */
  const denied = async (role: KnowledgeRole, sql: string, values: unknown[]) => {
    const error = (await as(role, false, sql, values).then(
      () => undefined,
      (caught: unknown) => caught,
    )) as { code?: string; message?: string } | undefined;
    return error ? { sqlstate: error.code, message: error.message } : undefined;
  };

  beforeAll(async () => {
    db = await RollbackPostgres.open(url ?? "postgresql://unused");
    chain = new GovernedChainExecutor({ db });
    const found = await chain.evidenceUnits(TENANT, { text: "checkpoint", limit: 5, maxTextChars: 4000 });
    const first = found.units.find((candidate) => !candidate.text_truncated && candidate.text.trim().length > 60);
    if (!first) throw new Error("the database holds no captured content unit to anchor a claim to");
    unit = first;
    quote = unit.text.trim().slice(0, 60).trim();
    // A source no one has assessed yet, so the prior this test records is the first row for it.
    source = (
      await db.transaction({ tenantId: TENANT }, async (client) =>
        client.query<{ id: string }>(
          `select e.id::text from catalog.entity e
            where e.tenant_id = $1 and e.kind = 'community_actor'
              and not exists (select 1 from evidence.source_assessment a where a.subject_entity_id = e.id)
            order by e.id limit 1`,
          [TENANT],
        ),
      )
    ).rows[0]?.id as string;
    if (!source) throw new Error("the database holds no unassessed community_actor to assess");
  });

  afterAll(async () => {
    await db?.close();
  });

  it("binds the functions the database declares, each granted to the role Knowledge Services writes it as", async () => {
    const declared = await db.transaction(
      { tenantId: TENANT },
      async (client) =>
        (
          await client.query<{ proname: string; arguments: string; granted: boolean }>(
            `select p.proname, pg_get_function_identity_arguments(p.oid) as arguments,
                  has_function_privilege(x.role, p.oid, 'execute') as granted
             from unnest($1::text[], $2::text[]) as x(name, role)
             join pg_proc p on p.pronamespace = 'api'::regnamespace and p.proname = x.name`,
            [
              CHAIN_OPERATIONS.map((operation) => operation.operation),
              CHAIN_OPERATIONS.map((operation) => operation.role),
            ],
          )
        ).rows,
    );
    expect(declared).toHaveLength(9);
    for (const row of declared) {
      expect(row.arguments, row.proname).toBe(chainFunctionSignature(row.proname as ChainOperationName));
      expect(row.granted, row.proname).toBe(true);
    }
  });

  it("finds a quotable unit with its capture, which pipeline_agent cannot read for itself", async () => {
    expect(unit.anchor).toEqual({ capture_id: expect.stringMatching(/^[0-9a-f-]{36}$/), node_id: expect.any(String) });
    expect(unit.text).toContain(quote);
    const byNode = await chain.evidenceUnits(TENANT, { nodeId: unit.anchor.node_id });
    expect(byNode.units.map((item) => item.anchor)).toContainEqual(unit.anchor);
    expect(
      await denied(
        "pipeline_agent",
        "select 1 from content.document_version_source_capture where tenant_id = $1 limit 1",
        [TENANT],
      ),
    ).toMatchObject({ sqlstate: "42501" });
  });

  it("writes the whole chain as the bounded roles: claim, restatement, triage, probe, run, verdict, assessment, sweep", async () => {
    const anchor = { ...unit.anchor, quote };
    const claim = await write("record_claim", "claim", {
      claim_type: "assertion",
      statement: `KS chain test ${suffix}: the post states that the quoted behaviour holds.`,
      evidence: [{ ...anchor, role: "context" }],
      structured: { path: "community_thread", source_role: "community" },
    });
    expect(claim).toMatchObject({ created: true, reused: false, status: "proposed", replayed: false });
    expect(claim.locator_ids).toHaveLength(1);
    const claimId = String(claim.claim_id);

    // The same key with the same input replays; with another input it is refused. Nothing is written twice.
    const replay = await write("record_claim", "claim", {
      claim_type: "assertion",
      statement: `KS chain test ${suffix}: the post states that the quoted behaviour holds.`,
      evidence: [{ ...anchor, role: "context" }],
      structured: { path: "community_thread", source_role: "community" },
    });
    expect(replay).toMatchObject({ claim_id: claimId, replayed: true, receipt_id: claim.receipt_id });
    expect(
      await refused(
        write("record_claim", "claim", {
          claim_type: "assertion",
          statement: "Another statement.",
          evidence: [anchor],
        }),
      ),
    ).toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED", details: { class: "taken", submitted: true } });
    expect(
      await refused(
        write("record_claim", "paraphrase", {
          claim_type: "assertion",
          statement: `KS chain test ${suffix}: a paraphrased quote.`,
          evidence: [{ ...unit.anchor, quote: `${quote} and words the unit never contained ${suffix}` }],
        }),
      ),
    ).toMatchObject({ code: "QUOTE_NOT_IN_UNIT", details: { class: "state_refuses" } });

    const restated = await write("restate_claim", "restate", {
      original_claim_id: claimId,
      statement: `KS chain test ${suffix}: the quoted behaviour holds.`,
      qualified: false,
      dropped: "attribution",
    });
    expect(restated).toMatchObject({ original_claim_id: claimId, created: true, status: "proposed" });
    const restatedId = String(restated.claim_id);

    const triage = await write("record_triage", "triage", {
      claim_id: restatedId,
      disposition: "probe",
      checkability: "deterministic_local",
      rationale: "a short deterministic script can observe it",
      priority: 80,
    });
    expect(triage).toMatchObject({
      written: true,
      unchanged: false,
      disposition: "probe",
      review_state: "agent_proposed",
    });

    const probe = await write("register_probe", "probe", {
      slug: `KSCT-${suffix}`,
      title: "Knowledge Services chain test probe",
      hypothesis: "the quoted behaviour holds in the pinned cell",
      kind: "executed",
      claims: [{ claim_id: restatedId, expectation: { expected: "holds true in cell-a" } }],
      matrix: [{ label: "cell-a" }],
      model_policy: "fake",
    });
    expect(probe).toMatchObject({ slug: `KSCT-${suffix}`, state: "active", claims: 1 });
    const probeId = String(probe.probe_id);

    // A verdict before any run is refused; so is a passed run without its captured output.
    const verdictInput = {
      claim_id: restatedId,
      probe_id: probeId,
      verdict: "directly_supported",
      cells: { "cell-a": { holds: true } },
      rationale: "holds in cell-a",
    };
    expect(await refused(write("propose_verdict", "verdict-early", verdictInput))).toMatchObject({
      code: "VERDICT_CELL_NOT_RUN",
      details: { class: "state_refuses", role: "verifier_agent" },
    });
    const runInput = {
      probe_id: probeId,
      cell_label: "cell-a",
      outcome: "pass",
      started_at: new Date(Date.now() - 60_000).toISOString(),
      observations: { checks: { holds: true } },
    };
    expect(await refused(write("record_probe_run", "run-no-output", runInput))).toMatchObject({
      code: "PROBE_RUN_OUTPUT_REQUIRED",
    });
    const run = await write("record_probe_run", "run", { ...runInput, output: anchor });
    expect(run).toMatchObject({ probe_id: probeId, cell_label: "cell-a", outcome: "pass", origin_kind: "standalone" });

    const verdict = await write("propose_verdict", "verdict", verdictInput);
    expect(verdict).toMatchObject({
      written: true,
      unchanged: false,
      verdict: "directly_supported",
      review_state: "agent_proposed",
      claim_status: "proposed",
      claim_status_changed: false,
    });
    // Append-only: the same verdict again writes nothing; a changed verdict is a new row that supersedes.
    const same = await write("propose_verdict", "verdict-again", { ...verdictInput, rationale: "the same, again" });
    expect(same).toMatchObject({ written: false, unchanged: true, verdict_id: verdict.verdict_id });
    const changed = await write("propose_verdict", "verdict-changed", {
      ...verdictInput,
      verdict: "supported_with_qualification",
      rationale: "holds in cell-a only",
    });
    expect(changed).toMatchObject({ written: true, supersedes_id: verdict.verdict_id, review_state: "agent_proposed" });
    expect(changed.verdict_id).not.toBe(verdict.verdict_id);

    const prior = await write("record_source_assessment", "prior", {
      subject_entity_id: source,
      method: "prior",
      source_role_code: "community",
      conflict_of_interest: "none",
      rationale: "a community source",
    });
    expect(prior).toMatchObject({ method: "prior" });
    expect(prior.assessment_id).toEqual(expect.any(String));

    const sweep = await write("raise_attention_sweep", "sweep", {
      policy: "forum-weekly",
      trigger_kind: "manual",
      note: "Knowledge Services chain test",
    });
    expect(sweep).toMatchObject({
      policy: "forum-weekly",
      origin_kind: "standalone",
      open: true,
      budget_stopped: false,
    });
    const settled = await write("settle_attention_sweep", "settle", {
      sweep_id: sweep.sweep_id,
      outcome: "completed",
      items_seen: 3,
      items_selected: 1,
      items_captured: 1,
      rejected: { off_topic: 2 },
    });
    expect(settled).toMatchObject({ sweep_id: sweep.sweep_id, outcome: "completed", settled: true });
    expect(
      await refused(
        write("settle_attention_sweep", "settle-twice", {
          sweep_id: sweep.sweep_id,
          outcome: "completed",
          items_seen: 3,
          items_selected: 1,
          items_captured: 1,
        }),
      ),
    ).toMatchObject({ code: "SWEEP_ALREADY_SETTLED" });

    // The ledger names the role that wrote each step, and the actor as the caller sent it.
    const ledger = await as<{ function: string; session_role: string; actor_label: string }>(
      "pipeline_agent",
      true,
      `select i.payload ->> 'function' as function, i.payload -> 'actor' ->> 'session_role' as session_role,
              i.payload -> 'actor' ->> 'label' as actor_label
         from orchestration.operation_intent i
        where i.tenant_id = util.current_tenant_id() and i.intent_type = 'governed_chain_write'
          and i.idempotency_key like $1 order by i.created_at, i.id`,
      [`chain:ks-chain-test:${suffix}:%`],
    );
    const roleOf = Object.fromEntries(ledger.map((row) => [row.function.replace(/^api\./, ""), row.session_role]));
    expect(roleOf).toEqual({
      record_claim: "pipeline_agent",
      restate_claim: "pipeline_agent",
      record_triage: "verifier_agent",
      register_probe: "verifier_agent",
      record_probe_run: "verifier_agent",
      propose_verdict: "verifier_agent",
      record_source_assessment: "verifier_agent",
      raise_attention_sweep: "pipeline_agent",
      settle_attention_sweep: "pipeline_agent",
    });
    expect(new Set(ledger.map((row) => row.actor_label))).toEqual(new Set([actor.label]));

    // Rule 1, verified: the chain left both claims proposed, and no bounded role can set the status directly.
    const statuses = await as<{ id: string; status: string }>(
      "executor_service",
      true,
      "select id::text, status::text from evidence.claim where id = any($1::uuid[])",
      [[claimId, restatedId]],
    );
    expect(statuses.map((row) => row.status)).toEqual(["proposed", "proposed"]);
    for (const role of ["executor_service", "pipeline_agent", "verifier_agent", "control_plane"] as const) {
      const direct = await denied(role, "update evidence.claim set status = 'verified' where id = $1", [restatedId]);
      expect(direct, role).toBeDefined();
      expect(
        direct?.message === "VERIFIED_CLAIM_REQUIRES_ADMITTED_USE" || direct?.sqlstate === "42501",
        `${role}: ${direct?.sqlstate} ${direct?.message}`,
      ).toBe(true);
    }
    expect(
      (await denied("executor_service", "update evidence.claim set status = 'verified' where id = $1", [restatedId]))
        ?.message,
    ).toBe("VERIFIED_CLAIM_REQUIRES_ADMITTED_USE");

    // Rule 2, a person's judgment: refused before submitting, by the function, and at the table.
    expect(
      await refused(write("record_source_assessment", "reviewed", { subject_entity_id: source, method: "reviewed" })),
    ).toMatchObject({ code: "HUMAN_REVIEW_NOT_AGENT_WRITABLE", details: { submitted: false } });
    expect(
      await refused(
        chain.write(TENANT, {
          operation: "record_triage",
          idempotency_key: key("human-label"),
          input: { claim_id: restatedId, disposition: "not_checkable", checkability: "not_applicable", rationale: "r" },
          actor: { label: "human reviewer" },
        }),
      ),
    ).toMatchObject({ code: "ACTOR_INVALID", details: { class: "malformed", submitted: true } });
    for (const role of ["verifier_agent", "pipeline_agent", "control_plane"] as const) {
      const confirm = await denied(
        role,
        "update verification.probe_verdict set review_state = 'human_confirmed' where id = $1",
        [changed.verdict_id],
      );
      expect(confirm?.sqlstate, role).toBe("42501");
    }

    // Rule 3, append-only: no bounded role rewrites or deletes a verdict, a triage row or an assessment.
    for (const [table, rowId] of [
      ["verification.probe_verdict", verdict.verdict_id],
      ["verification.claim_triage", triage.triage_id],
      ["evidence.source_assessment", prior.assessment_id],
    ] as const) {
      for (const role of ["verifier_agent", "pipeline_agent"] as const) {
        expect(
          (await denied(role, `update ${table} set rationale = 'rewritten' where id = $1`, [rowId]))?.sqlstate,
          table,
        ).toMatch(/^(42501|23514|P0001)$/);
        expect((await denied(role, `delete from ${table} where id = $1`, [rowId]))?.sqlstate, table).toMatch(
          /^(42501|23514|P0001)$/,
        );
      }
    }
    const kept = await as<{ verdict: string; review_state: string }>(
      "pipeline_agent",
      true,
      "select verdict::text, review_state from api.claim_verdicts where claim_id = $1 order by decided_at",
      [restatedId],
    );
    expect(kept.every((row) => row.review_state === "agent_proposed")).toBe(true);
    expect(kept.map((row) => row.verdict)).toContain("supported_with_qualification");
  });
});
