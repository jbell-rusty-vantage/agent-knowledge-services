import type {
  ApiGovernedWriteErrorCode,
  ApiProposeVerdictArgs,
  ApiRaiseAttentionSweepArgs,
  ApiRecordClaimArgs,
  ApiRecordProbeRunArgs,
  ApiRecordSourceAssessmentArgs,
  ApiRecordTriageArgs,
  ApiRegisterProbeArgs,
  ApiRestateClaimArgs,
  ApiSettleAttentionSweepArgs,
} from "@aiengineer/database-contract/api";
import {
  CHAIN_OPERATIONS,
  type GovernedWriteErrorCode,
  type ProposeVerdictInputSchema,
  type RaiseAttentionSweepInputSchema,
  type RecordClaimInputSchema,
  type RecordProbeRunInputSchema,
  type RecordSourceAssessmentInputSchema,
  type RecordTriageInputSchema,
  type RegisterProbeInputSchema,
  type RestateClaimInputSchema,
  type SettleAttentionSweepInputSchema,
} from "@aiengineer/knowledge-contracts";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import type { KnowledgeSqlClient, KnowledgeTransactionScope, KnowledgeTransactions } from "../ports.js";
import { isKnowledgeError } from "../schema-workspace/index.js";
import { GovernedChainExecutor, chainFailure } from "./executor.js";
import { CHAIN_FUNCTION_PARAMETERS, chainFunctionSignature, chainStatement } from "./functions.js";

/**
 * The seam to the AI Engineer database contract, checked by the compiler against the vendored package: every error
 * code the contract can raise has an entry here, and each operation's input fields are exactly the parameters of its
 * function (without `p_`, and without the key and the actor, which travel beside the input).
 */
type Assert<T extends true> = T;
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Parameters<I> = `p_${keyof I & string}` | "p_idempotency_key" | "p_actor";
export type ContractSeam = [
  Assert<Same<Exclude<ApiGovernedWriteErrorCode, GovernedWriteErrorCode>, never>>,
  Assert<Same<Parameters<z.infer<typeof RecordClaimInputSchema>>, keyof ApiRecordClaimArgs>>,
  Assert<Same<Parameters<z.infer<typeof RestateClaimInputSchema>>, keyof ApiRestateClaimArgs>>,
  Assert<Same<Parameters<z.infer<typeof RegisterProbeInputSchema>>, keyof ApiRegisterProbeArgs>>,
  Assert<Same<Parameters<z.infer<typeof RecordProbeRunInputSchema>>, keyof ApiRecordProbeRunArgs>>,
  Assert<Same<Parameters<z.infer<typeof ProposeVerdictInputSchema>>, keyof ApiProposeVerdictArgs>>,
  Assert<Same<Parameters<z.infer<typeof RecordTriageInputSchema>>, keyof ApiRecordTriageArgs>>,
  Assert<Same<Parameters<z.infer<typeof RecordSourceAssessmentInputSchema>>, keyof ApiRecordSourceAssessmentArgs>>,
  Assert<Same<Parameters<z.infer<typeof RaiseAttentionSweepInputSchema>>, keyof ApiRaiseAttentionSweepArgs>>,
  Assert<Same<Parameters<z.infer<typeof SettleAttentionSweepInputSchema>>, keyof ApiSettleAttentionSweepArgs>>,
];

const TENANT = "00000000-0000-7000-8000-000000000001";
const id = (n: number) => `0192b000-0000-7000-8000-${String(n).padStart(12, "0")}`;

interface Call {
  readonly scope: KnowledgeTransactionScope;
  readonly text: string;
  readonly values: readonly unknown[] | undefined;
}

function fakeDatabase(answer: (text: string) => { rows: Record<string, unknown>[] } | Error) {
  const calls: Call[] = [];
  const db: KnowledgeTransactions = {
    async transaction<T>(scope: KnowledgeTransactionScope, work: (client: KnowledgeSqlClient) => Promise<T>) {
      const client: KnowledgeSqlClient = {
        async query(text: string, values?: readonly unknown[]) {
          calls.push({ scope, text, values });
          const result = answer(text);
          if (result instanceof Error) throw result;
          return { rows: result.rows as never[], rowCount: result.rows.length };
        },
      };
      return work(client);
    },
  };
  return { db, calls };
}

const claimRequest = (extra: Record<string, unknown> = {}) => ({
  operation: "record_claim",
  idempotency_key: "run-2fa5:claim:7",
  input: {
    claim_type: "assertion",
    statement: "create_agent ends the loop when tool_calls is empty.",
    evidence: [{ capture_id: id(1), node_id: id(2), quote: "the loop exits when tool_calls is empty" }],
  },
  ...extra,
});

describe("the binding of the nine governed functions", () => {
  it("declares every input field of every operation, and nothing else", () => {
    for (const operation of CHAIN_OPERATIONS) {
      const declared = CHAIN_FUNCTION_PARAMETERS[operation.operation as keyof typeof CHAIN_FUNCTION_PARAMETERS];
      expect(declared.map(([field]) => field).sort(), operation.operation).toEqual(
        Object.keys(operation.input.shape).sort(),
      );
    }
    expect(chainFunctionSignature("propose_verdict")).toBe(
      "p_idempotency_key text, p_claim_id uuid, p_probe_id uuid, p_verdict text, p_cells jsonb, p_rationale text, p_actor jsonb",
    );
  });

  it("calls in named notation, with the key and the actor as the caller sent them and absent fields left out", () => {
    const actor = { label: "ks:claim-extractor", mission_id: id(9) };
    const statement = chainStatement({
      operation: "record_claim",
      function: "api.record_claim",
      idempotencyKey: "run-2fa5:claim:7",
      actor,
      fields: { claim_type: "assertion", statement: "S", evidence: [{ locator_id: id(3) }] },
    });
    expect(statement.text).toBe(
      "select api.record_claim(p_idempotency_key => $1::text, p_claim_type => $2::text, p_statement => $3::text, p_evidence => $4::jsonb, p_actor => $5::jsonb) as result",
    );
    expect(statement.values).toEqual([
      "run-2fa5:claim:7",
      "assertion",
      "S",
      JSON.stringify([{ locator_id: id(3) }]),
      JSON.stringify(actor),
    ]);
    const probe = chainStatement({
      operation: "register_probe",
      function: "api.register_probe",
      idempotencyKey: "k",
      actor: undefined,
      fields: { slug: "P1", subject_entity_ids: [id(4)], budget_usd: 0 },
    });
    expect(probe.text).toContain("p_subject_entity_ids => $3::uuid[]");
    expect(probe.text).toContain("p_budget_usd => $4::numeric");
    expect(probe.text).not.toContain("p_actor");
    expect(probe.values).toEqual(["k", "P1", [id(4)], 0]);
    expect(() =>
      chainStatement({
        operation: "record_claim",
        function: "evidence.claim; drop",
        idempotencyKey: "k",
        actor: undefined,
        fields: {},
      }),
    ).toThrow(/not a governed function/);
  });
});

describe("GovernedChainExecutor.write", () => {
  it("runs each operation as the bounded role of its contract, in one tenant-scoped transaction", async () => {
    const { db, calls } = fakeDatabase(() => ({ rows: [{ result: { claim_id: id(5), replayed: false } }] }));
    const chain = new GovernedChainExecutor({ db });
    const written = await chain.write(TENANT, claimRequest({ actor: { label: "ks:agent" } }));
    expect(written).toEqual({
      operation: "record_claim",
      function: "api.record_claim",
      role: "pipeline_agent",
      result: { claim_id: id(5), replayed: false },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.scope).toMatchObject({ tenantId: TENANT, role: "pipeline_agent" });
    expect(calls[0]?.scope.readOnly).toBeUndefined();
    await chain.write(TENANT, {
      operation: "propose_verdict",
      idempotency_key: "run-2fa5:verdict:1",
      input: {
        claim_id: id(5),
        probe_id: id(6),
        verdict: "directly_supported",
        cells: { D1: { ok: true } },
        rationale: "r",
      },
    });
    expect(calls[1]?.scope.role).toBe("verifier_agent");
  });

  it("refuses a wrong request before it opens a transaction", async () => {
    const { db, calls } = fakeDatabase(() => new Error("must not be reached"));
    const chain = new GovernedChainExecutor({ db });
    const refused = async (request: unknown) => {
      const error = await chain.write(TENANT, request).catch((caught: unknown) => caught);
      if (!isKnowledgeError(error)) throw error;
      return error;
    };
    const invalid = await refused(claimRequest({ input: { claim_type: "assertion", statement: "S", evidence: [] } }));
    expect(invalid).toMatchObject({ code: "INPUT_INVALID", exit: 1, details: { submitted: false } });
    expect((await refused({ ...claimRequest(), operation: "verify_claim" })).code).toBe(
      "VERIFIED_CLAIM_REQUIRES_ADMITTED_USE",
    );
    expect(
      (
        await refused({
          operation: "record_source_assessment",
          idempotency_key: "k",
          input: { subject_entity_id: id(7), method: "reviewed" },
        })
      ).code,
    ).toBe("HUMAN_REVIEW_NOT_AGENT_WRITABLE");
    const append = await refused({ operation: "update_verdict", idempotency_key: "k", input: {} });
    expect(append.code).toBe("CHAIN_OPERATION_UNKNOWN");
    expect(append.message).toContain("append-only");
    expect(calls).toEqual([]);
  });

  it("keeps the database's stable code, its class and its detail, and says what to do next", async () => {
    const raised = Object.assign(new Error("VERDICT_REQUIRES_RUNS"), {
      code: "22023",
      detail: "p_cells is an object keyed by the cell labels of the runs the verdict rests on, with what each showed",
    });
    const { db } = fakeDatabase(() => raised);
    const error = await new GovernedChainExecutor({ db })
      .write(TENANT, {
        operation: "propose_verdict",
        idempotency_key: "k",
        input: { claim_id: id(5), probe_id: id(6), verdict: "contradicted", cells: { D9: {} }, rationale: "r" },
      })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: "VERDICT_REQUIRES_RUNS",
      exit: 1,
      details: {
        class: "malformed",
        sqlstate: "22023",
        detail: raised.detail,
        operation: "propose_verdict",
        function: "api.propose_verdict",
        role: "verifier_agent",
        submitted: true,
      },
    });
    expect((error as Error).message).toContain("Next: Record a run for each cell with record_probe_run");
  });

  it("classes a code it does not know, a missing grant and anything else", () => {
    const call = { operation: "record_claim", function: "api.record_claim", role: "pipeline_agent" };
    const newer = chainFailure(Object.assign(new Error("CLAIM_FROZEN"), { code: "23514", detail: "d" }), call);
    expect(newer).toMatchObject({ code: "CLAIM_FROZEN", exit: 1, details: { class: "state_refuses", detail: "d" } });
    const grant = chainFailure(
      Object.assign(new Error("permission denied for function record_claim"), { code: "42501" }),
      call,
    );
    expect(grant).toMatchObject({ code: "CHAIN_ROLE_NOT_GRANTED", exit: 2 });
    const human = chainFailure(Object.assign(new Error("HUMAN_REVIEW_NOT_AGENT_WRITABLE"), { code: "42501" }), call);
    expect(human).toMatchObject({
      code: "HUMAN_REVIEW_NOT_AGENT_WRITABLE",
      exit: 1,
      details: { class: "not_allowed" },
    });
    const verified = chainFailure(
      Object.assign(new Error("VERIFIED_CLAIM_REQUIRES_ADMITTED_USE"), { code: "23514", hint: "h" }),
      call,
    );
    expect(verified).toMatchObject({ code: "VERIFIED_CLAIM_REQUIRES_ADMITTED_USE", details: { hint: "h" } });
    expect(chainFailure(new Error("connection reset"), call)).toMatchObject({ code: "CHAIN_WRITE_FAILED", exit: 2 });
  });
});

describe("GovernedChainExecutor.evidenceUnits", () => {
  it("reads as executor_service, read-only, and returns each unit's anchor", async () => {
    const { db, calls } = fakeDatabase(() => ({
      rows: [
        {
          node_id: id(2),
          capture_id: id(1),
          document_id: id(3),
          document_version_id: id(4),
          source_id: id(5),
          unit_kind: "thread_post",
          ordinal: 7,
          request_url: "https://forum.example/t/1",
          captured_at: new Date("2026-11-10T00:00:00Z"),
          capture_role: "primary",
          text: "the loop exits when",
          text_chars: 400,
        },
      ],
    }));
    const result = await new GovernedChainExecutor({ db }).evidenceUnits(TENANT, { text: "50%_off", limit: 5 });
    expect(calls[0]?.scope).toMatchObject({ tenantId: TENANT, role: "executor_service", readOnly: true });
    expect(calls[0]?.values?.[5]).toBe("50\\%\\_off");
    expect(calls[0]?.values?.[7]).toBe(6);
    expect(result).toMatchObject({
      role: "executor_service",
      truncated: false,
      units: [
        {
          anchor: { capture_id: id(1), node_id: id(2) },
          unit_kind: "thread_post",
          captured_at: "2026-11-10T00:00:00.000Z",
          text_truncated: true,
        },
      ],
    });
  });

  it("requires a filter", async () => {
    const { db, calls } = fakeDatabase(() => ({ rows: [] }));
    await expect(new GovernedChainExecutor({ db }).evidenceUnits(TENANT, { limit: 5 })).rejects.toMatchObject({
      code: "EVIDENCE_UNITS_FILTER_REQUIRED",
    });
    await expect(new GovernedChainExecutor({ db }).evidenceUnits(TENANT, { capture_id: id(1) })).rejects.toMatchObject({
      code: "INPUT_INVALID",
    });
    expect(calls).toEqual([]);
  });
});
