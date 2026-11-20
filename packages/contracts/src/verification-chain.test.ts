import { describe, expect, it } from "vitest";
import {
  CHAIN_OPERATION_NAMES,
  CHAIN_OPERATIONS,
  ChainWriteRequestSchema,
  EvidenceAnchorSchema,
  EvidenceUnitsInputSchema,
  GOVERNED_WRITE_ERRORS,
  GOVERNED_WRITE_SQLSTATE_CLASS,
  GovernedActorSchema,
  chainRuleRefusal,
  describeChainOperation,
  governedWriteError,
  parseChainWrite,
} from "./verification-chain.js";

const id = (n: number) => `0192b000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const call = (operation: string, input: unknown, extra: Record<string, unknown> = {}) => ({
  operation,
  idempotency_key: `test:${operation}:1`,
  input,
  ...extra,
});

describe("the nine governed writes are defined once", () => {
  it("names the functions of contract 0.12.0 in chain order, each with a granted role", () => {
    expect(CHAIN_OPERATIONS.map((item) => [item.operation, item.function, item.role])).toEqual([
      ["record_claim", "api.record_claim", "pipeline_agent"],
      ["restate_claim", "api.restate_claim", "pipeline_agent"],
      ["record_triage", "api.record_triage", "verifier_agent"],
      ["register_probe", "api.register_probe", "verifier_agent"],
      ["record_probe_run", "api.record_probe_run", "verifier_agent"],
      ["propose_verdict", "api.propose_verdict", "verifier_agent"],
      ["record_source_assessment", "api.record_source_assessment", "verifier_agent"],
      ["raise_attention_sweep", "api.raise_attention_sweep", "pipeline_agent"],
      ["settle_attention_sweep", "api.settle_attention_sweep", "pipeline_agent"],
    ]);
    expect(CHAIN_OPERATIONS.map((item) => item.step)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(new Set(CHAIN_OPERATION_NAMES).size).toBe(9);
  });

  it("gives every operation an example its own schema accepts, and describes it in full", () => {
    for (const operation of CHAIN_OPERATIONS) {
      expect(operation.input.safeParse(operation.example).success, operation.operation).toBe(true);
      const described = describeChainOperation(operation.operation);
      expect(described).toMatchObject({
        ref: `operation:${operation.operation}`,
        function: operation.function,
        role: operation.role,
        surfaces: { mcp: ["chain_write"] },
      });
      expect(described?.input).toMatchObject({ type: "object", additionalProperties: false });
      expect(parseChainWrite(described?.example).ok, operation.operation).toBe(true);
      expect(operation.notes.length).toBeGreaterThan(0);
    }
    expect(describeChainOperation("verify_claim")).toBeUndefined();
  });

  it("accepts the three anchor forms and no mixture of them", () => {
    expect(EvidenceAnchorSchema.safeParse({ locator_id: id(3), role: "supports" }).success).toBe(true);
    expect(EvidenceAnchorSchema.safeParse({ capture_id: id(1), node_id: id(2), quote: "exact words" }).success).toBe(
      true,
    );
    expect(
      EvidenceAnchorSchema.safeParse({
        capture_id: id(1),
        node_id: id(2),
        selector_kind: "json_pointer",
        pointer: "/a",
      }).success,
    ).toBe(true);
    expect(EvidenceAnchorSchema.safeParse({ locator_id: id(3), capture_id: id(1) }).success).toBe(false);
    expect(EvidenceAnchorSchema.safeParse({ capture_id: id(1), node_id: id(2) }).success).toBe(false);
    expect(
      EvidenceAnchorSchema.safeParse({ capture_id: id(1), node_id: id(2), quote: "q", role: "proves" }).success,
    ).toBe(false);
  });

  it("keeps the actor in the database's own shape", () => {
    const actor = {
      label: "ks:claim-extractor",
      mission_id: id(9),
      mc: {
        mission_id: "m-1",
        run_id: "2fa5e2ab",
        operation_id: "op-3",
        operation_attempt: 1,
        execution_generation: 0,
        lane: "deep_agents",
      },
    };
    expect(GovernedActorSchema.parse(actor)).toEqual(actor);
    expect(GovernedActorSchema.safeParse({ ...actor, mc: { run_id: "r" } }).success).toBe(false);
    expect(GovernedActorSchema.safeParse({ reviewer: "john" }).success).toBe(false);
  });
});

describe("a wrong request is refused before anything is submitted", () => {
  it("passes the idempotency key and the actor through unchanged", () => {
    const actor = { label: "ks:agent", mission_id: id(9) };
    const parsed = parseChainWrite({
      operation: "record_claim",
      idempotency_key: "  run-1:claim:7 ",
      input: CHAIN_OPERATIONS[0]?.example,
      actor,
    });
    expect(parsed.ok && parsed.idempotencyKey).toBe("  run-1:claim:7 ");
    expect(parsed.ok && parsed.actor).toEqual(actor);
    expect(parsed.ok && parsed.operation.function).toBe("api.record_claim");
  });

  it("names the failing fields of the envelope and of the operation's input", () => {
    const envelope = parseChainWrite({ operation: "record_claim", input: {} });
    expect(envelope).toMatchObject({ ok: false, refusal: { code: "INPUT_INVALID", class: "invalid_input" } });
    const input = parseChainWrite(call("record_claim", { claim_type: "assertion", statement: "x", evidence: [] }));
    expect(input).toMatchObject({
      ok: false,
      refusal: { code: "INPUT_INVALID", details: { operation: "record_claim" } },
    });
    expect(JSON.stringify(input)).toContain("evidence");
    expect(parseChainWrite(call("propose_verdict", { ...CHAIN_OPERATIONS[5]?.example, cells: {} })).ok).toBe(false);
    expect(parseChainWrite(call("record_claim", { ...CHAIN_OPERATIONS[0]?.example, tenant_id: id(1) })).ok).toBe(false);
    expect(ChainWriteRequestSchema.safeParse(call("record_claim", {}, { tenantId: id(1) })).success).toBe(false);
  });
});

describe("the three rules are plain refusals", () => {
  it("verified: no operation and no field sets a claim's status", () => {
    for (const operation of ["verify_claim", "mark_verified", "admit_claim"])
      expect(parseChainWrite(call(operation, { claim_id: id(1) }))).toMatchObject({
        ok: false,
        refusal: { code: "VERIFIED_CLAIM_REQUIRES_ADMITTED_USE", class: "not_allowed" },
      });
    const withStatus = parseChainWrite(call("record_claim", { ...CHAIN_OPERATIONS[0]?.example, status: "verified" }));
    expect(withStatus).toMatchObject({ ok: false, refusal: { code: "VERIFIED_CLAIM_REQUIRES_ADMITTED_USE" } });
    expect(JSON.stringify(withStatus)).toContain("Knowledge Services admits");
  });

  it("a person's judgment: reviewed, human_confirmed and human_rejected are never written", () => {
    const reviewed = parseChainWrite(
      call("record_source_assessment", { subject_entity_id: id(31), method: "reviewed" }),
    );
    expect(reviewed).toMatchObject({ ok: false, refusal: { code: "HUMAN_REVIEW_NOT_AGENT_WRITABLE" } });
    const confirmed = parseChainWrite(
      call("propose_verdict", { ...CHAIN_OPERATIONS[5]?.example, review_state: "human_confirmed" }),
    );
    expect(confirmed).toMatchObject({
      ok: false,
      refusal: { code: "HUMAN_REVIEW_NOT_AGENT_WRITABLE", details: { fields: ["review_state"] } },
    });
    for (const operation of ["confirm_verdict", "review_release", "reject_triage"])
      expect(chainRuleRefusal(call(operation, {}))?.code).toBe("HUMAN_REVIEW_NOT_AGENT_WRITABLE");
  });

  it("append-only: there is no operation that changes or deletes a row", () => {
    for (const operation of ["update_verdict", "delete_triage", "set_claim_status", "supersede_assessment"]) {
      const refused = parseChainWrite(call(operation, {}));
      expect(refused).toMatchObject({ ok: false, refusal: { code: "CHAIN_OPERATION_UNKNOWN" } });
      expect(JSON.stringify(refused)).toContain("append-only");
    }
  });
});

describe("every governed-write error names what to do next", () => {
  it("covers the 71 codes of the contract and the two table-level rules", () => {
    const codes = Object.keys(GOVERNED_WRITE_ERRORS);
    expect(codes).toHaveLength(73);
    for (const code of codes) {
      const entry = governedWriteError(code);
      expect(entry?.meaning.length, code).toBeGreaterThan(10);
      expect(entry?.next.length, code).toBeGreaterThan(10);
      expect(Object.values(GOVERNED_WRITE_SQLSTATE_CLASS)).toContain(entry?.class);
    }
    expect(governedWriteError("VERDICT_REQUIRES_RUNS")).toMatchObject({ class: "malformed" });
    expect(governedWriteError("VERDICT_REQUIRES_RUNS")?.next).toContain("record_probe_run");
    expect(governedWriteError("NOT_A_CODE")).toBeUndefined();
  });
});

describe("evidence_units", () => {
  it("takes filters only", () => {
    expect(EvidenceUnitsInputSchema.safeParse({ text: "checkpoint_ns", limit: 5 }).success).toBe(true);
    expect(EvidenceUnitsInputSchema.safeParse({ capture_id: id(1) }).success).toBe(false);
    expect(EvidenceUnitsInputSchema.safeParse({ limit: 500 }).success).toBe(false);
  });
});
