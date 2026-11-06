import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ReportKindCatalog } from "@aiengineer/knowledge-application";
import { createIngestionApplyPort } from "@aiengineer/knowledge-binding-aiengineer-postgres";
import {
  DispatchRegistry,
  type InMemoryEffectLedger,
  JwksCache,
  KnowledgeCredentialVerifier,
  KnowledgeOperationService,
  ProtocolRefusal,
  createInMemoryBackend,
  staticJwksSource,
} from "@aiengineer/knowledge-host/knowledge-operation";
import {
  type JsonValue,
  type OperationEnvelope,
  type OperationReceipt,
  OperationReceiptSchema,
  ReceiptLookupSchema,
  envelopeDigest,
} from "@aiengineer/knowledge-operation-protocol";
import { ExactUseAdmissionError } from "@aiengineer/knowledge-db";
import type { AuthScope } from "@aiengineer/knowledge-research-core";
import { describe, expect, it } from "vitest";
import {
  TEST_AUDIENCE,
  TEST_INSTALLATION,
  TEST_ISSUER,
  claimsFor,
  envelopeFor,
  generateIssuerKey,
  jwksOf,
  liveOrigin,
  recoveryOriginFor,
  signCredential,
} from "./tests/test-support.js";

/**
 * WI-05 (OVE-167) service rules over the in-memory ledger with a fake native store (unit level: the "crash" is a
 * thrown protocol-receipt write in this process; the fresh-process proofs over real AIDB / Biotech PostgreSQL and
 * Neo4j are `native-recovery.integration.test.ts`). The native store counts commits so a duplicated native write is
 * visible.
 */
const KINDS = ReportKindCatalog.fromDirectory(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../../../catalog/research/report-kinds"),
);
const TENANT = "00000000-0000-7000-8000-0000000000aa";
const BOUND = `sha256:${"a".repeat(64)}`;

/** A fake native ingestion store with the real port's contract: one commit per effect, stamped with its dispatch. */
class FakeNative {
  readonly commits = new Map<string, { receiptId: string; dispatchId: string }>();
  applies = 0;
  readbacks = 0;
  /** Refuse the next apply natively (the native transaction rolls back): an admission code or a raw failure. */
  refuseNext: "STALE_DECISION" | "INTERNAL" | null = null;
  constructor(private readonly ledger: InMemoryEffectLedger) {}

  async apply(intent: unknown, options: { effectDispatchId?: string } = {}) {
    const refuse = this.refuseNext;
    this.refuseNext = null;
    if (refuse === "STALE_DECISION") {
      throw new ExactUseAdmissionError("STALE_DECISION", {
        outcome: "refused",
        reason: "stale",
        path: "component_only",
      });
    }
    if (refuse === "INTERNAL") throw new Error("NATIVE_CONNECTION_RESET");
    this.applies += 1;
    const exactUse = (intent as { exactUse: { effectKey: string } }).exactUse;
    const existing = this.commits.get(exactUse.effectKey);
    if (existing !== undefined) return this.receipt(exactUse.effectKey, existing.receiptId, existing.receiptId);
    const receiptId = `rcpt-${this.commits.size + 1}`;
    this.commits.set(exactUse.effectKey, { receiptId, dispatchId: options.effectDispatchId as string });
    this.ledger.commit(
      { tenant: TENANT } as AuthScope,
      exactUse.effectKey,
      options.effectDispatchId as string,
      { schemaVersion: "knowledge-ingestion-receipt.v1", receiptId },
      "2026-10-27T10:00:00Z",
    );
    return this.receipt(exactUse.effectKey, receiptId, null);
  }

  async committedExactUseReceipt(input: { tenantId: string; effectKey: string; receiptId: string }) {
    this.readbacks += 1;
    if (this.commits.get(input.effectKey)?.receiptId !== input.receiptId) throw new Error("RECEIPT_NOT_FOUND");
    return this.receipt(input.effectKey, input.receiptId, null);
  }

  private receipt(effectKey: string, receiptId: string, duplicateOf: string | null) {
    return {
      receiptId,
      outcome: "applied",
      head: { before: 4, after: 5, rebased: false },
      duplicateOf,
      admission: {
        path: "component_only",
        useDecisionId: "decision-1",
        boundEffectDigest: BOUND,
        effectKey,
        authoritativeEpoch: 3,
        effectReceiptDigest: `sha256:${"c".repeat(64)}`,
      },
    };
  }
}

function harness() {
  const key = generateIssuerKey("mc-recovery");
  let native!: FakeNative;
  const backend = createInMemoryBackend({
    application: "ai-engineer",
    binding: "in-memory",
    kinds: KINDS,
    auditor: null,
    apply: createIngestionApplyPort({
      apply: (intent, options) => native.apply(intent, options) as never,
      committedExactUseReceipt: (input) => native.committedExactUseReceipt(input) as never,
    }),
  });
  native = new FakeNative(backend.ledger);
  const svc = new KnowledgeOperationService({
    verifier: new KnowledgeCredentialVerifier({
      issuer: TEST_ISSUER,
      audience: TEST_AUDIENCE,
      jwks: new JwksCache(staticJwksSource(jwksOf([key]))),
    }),
    backends: [backend],
    installed: [{ application: "ai-engineer", binding: "in-memory", installationId: TEST_INSTALLATION, tenants: null }],
    dispatches: new DispatchRegistry(),
    signingIssuer: "knowledge-services",
  });
  /** Lose the next protocol-receipt write: the native commit happened, the K01 acknowledgment did not. */
  const crashNextAck = () => {
    const record = backend.ledger.record.bind(backend.ledger);
    backend.ledger.record = async () => {
      backend.ledger.record = record;
      throw new Error("CRASH_BEFORE_PROTOCOL_RECEIPT");
    };
  };
  return { svc, key, native, ledger: backend.ledger, crashNextAck };
}

const origin = liveOrigin(TENANT, { invocation: "inv-wi05" });

function envelopeOf(effectKey: string, bound = BOUND): OperationEnvelope {
  return envelopeFor({
    operation: "knowledge.apply",
    origin,
    payload: {
      schemaVersion: "knowledge-ingestion-intent.v1",
      intentId: `intent-${effectKey}`,
      context: { tenantId: TENANT },
      exactUse: {
        useDecisionId: "decision-1",
        boundEffectDigest: bound,
        processedEpoch: 0,
        normalizedValuesDigest: `sha256:${"b".repeat(64)}`,
        effectKey,
        originatingOrigin: origin,
      },
    } as unknown as JsonValue,
    effectKey,
    boundEffectDigest: bound,
  });
}

async function send(
  h: ReturnType<typeof harness>,
  envelope: OperationEnvelope,
  caller = origin,
  recovery?: Parameters<typeof claimsFor>[0]["recovery"],
): Promise<OperationReceipt | { code: string }> {
  const effect = envelope.effect as NonNullable<OperationEnvelope["effect"]>;
  const token = signCredential(
    h.key,
    claimsFor({
      origin: caller,
      operations: ["knowledge.apply"],
      dispatchId: envelope.dispatchId,
      effect: { effectKey: effect.effectKey, boundEffectDigest: effect.boundEffectDigest },
      ...(recovery ? { recovery } : {}),
    }),
  );
  return h.svc.invoke(token, envelope).then(
    (answer) => OperationReceiptSchema.parse(answer),
    (error: unknown) => {
      if (error instanceof ProtocolRefusal) return error.error;
      throw error;
    },
  );
}

async function lookup(h: ReturnType<typeof harness>, effectKey: string) {
  const recovery = recoveryOriginFor(TENANT, "recovery-wi05");
  const claims = claimsFor({
    origin: recovery,
    operations: ["receipt.get"],
    dispatchId: `dispatch-lookup-${effectKey}-${Math.random().toString(36).slice(2)}`,
    recovery: { scope: "read_only", authorityRef: "recovery-wi05", effectKey, boundEffectDigest: BOUND },
  });
  return ReceiptLookupSchema.parse(await h.svc.receipt(signCredential(h.key, claims), effectKey));
}

describe("WI-05 native receipt reconstruction (K01 service, in-memory ledger)", () => {
  it("crash after the native commit and before the protocol receipt: the retry answers the ORIGINAL dispatch's receipt without applying again", async () => {
    const h = harness();
    const original = envelopeOf("effect-crash-1");
    h.crashNextAck();
    expect(await send(h, original)).toMatchObject({ code: "INTERNAL", retryable: true });
    expect(h.native.applies).toBe(1);
    expect(await h.ledger.lookup({ tenant: TENANT } as AuthScope, "effect-crash-1")).toMatchObject({
      state: "native_only",
      commit: { dispatchId: original.dispatchId },
    });
    const retry = { ...original, dispatchId: "dispatch-retry-1" };
    const receipt = (await send(h, retry)) as OperationReceipt;
    expect(h.native.applies).toBe(1);
    expect(h.native.readbacks).toBe(1);
    expect(receipt.effect).toMatchObject({
      dispatchId: original.dispatchId,
      envelopeDigest: envelopeDigest(original),
      dispatchSequence: 1,
      currentCallerOrigin: origin,
    });
    expect(receipt).toMatchObject({
      outcome: "applied",
      nativeReceiptRef: { id: "rcpt-1" },
      appliedAt: "2026-10-27T10:00:00Z",
      details: { duplicateOf: null },
    });
    // The receipt is stable: receipt.get and another retry answer the same recorded document.
    expect(await lookup(h, "effect-crash-1")).toEqual({ disposition: "found", receipt });
    expect(await send(h, { ...original, dispatchId: "dispatch-retry-2" })).toEqual(receipt);
    expect(h.native.applies).toBe(1);
  });

  it("receipt.get alone reconciles a native_only effect into the original receipt (read-only recovery, no apply)", async () => {
    const h = harness();
    const original = envelopeOf("effect-crash-2");
    h.crashNextAck();
    expect(await send(h, original)).toMatchObject({ code: "INTERNAL", retryable: true });
    const found = await lookup(h, "effect-crash-2");
    expect(found.disposition).toBe("found");
    expect(found.disposition === "found" && found.receipt.effect.dispatchId).toBe(original.dispatchId);
    expect(h.native.applies).toBe(1);
  });

  it("a recovering caller (new attempt with an effect grant) still receives the original caller's receipt", async () => {
    const h = harness();
    const original = envelopeOf("effect-crash-3");
    h.crashNextAck();
    expect(await send(h, original)).toMatchObject({ code: "INTERNAL", retryable: true });
    const attempt2 = liveOrigin(TENANT, { attempt: 2, invocation: "inv-wi05-attempt-2" });
    const retry = { ...original, dispatchId: "dispatch-attempt-2" };
    const receipt = (await send(h, retry, attempt2, {
      scope: "effect",
      authorityRef: "recovery-grant-wi05",
      effectKey: "effect-crash-3",
      boundEffectDigest: BOUND,
    })) as OperationReceipt;
    expect(receipt.effect.currentCallerOrigin).toEqual(origin);
    expect(receipt.effect.dispatchId).toBe(original.dispatchId);
    expect(h.native.applies).toBe(1);
  });

  it("changed bytes under a native_only effect key refuse EFFECT_CONFLICT; nothing native runs", async () => {
    const h = harness();
    const original = envelopeOf("effect-crash-4");
    h.crashNextAck();
    expect(await send(h, original)).toMatchObject({ code: "INTERNAL", retryable: true });
    const changed = envelopeOf("effect-crash-4", `sha256:${"d".repeat(64)}`);
    expect(await send(h, changed)).toMatchObject({ code: "EFFECT_CONFLICT" });
    expect(h.native.applies).toBe(1);
    expect(h.native.readbacks).toBe(0);
  });

  it("journal poisoning: a refused wrong-digest dispatch never pins the key; the correct dispatch then succeeds", async () => {
    const h = harness();
    const correct = envelopeOf("effect-poison-8");
    // The envelope names another bound digest than its intent: journaled, then refused by the native port.
    const wrong = envelopeFor({
      operation: "knowledge.apply",
      origin,
      payload: correct.input?.inlinePayload as JsonValue,
      effectKey: "effect-poison-8",
      boundEffectDigest: `sha256:${"f".repeat(64)}`,
    });
    expect(await send(h, wrong)).toMatchObject({
      code: "EFFECT_CONFLICT",
      details: { dispatch: "not_journaled" },
    });
    expect(h.ledger.dispatches.get(`${TENANT}/effect-poison-8`)).toHaveLength(1);
    const receipt = (await send(h, correct)) as OperationReceipt;
    expect(receipt).toMatchObject({
      outcome: "applied",
      effect: { dispatchId: correct.dispatchId, dispatchSequence: 2 },
    });
    expect(h.native.applies).toBe(1);
  });

  it("every knowledge.apply refusal names what its dispatch did natively (details.dispatch)", async () => {
    const h = harness();
    // Committed natively, protocol receipt lost: `committed`.
    h.crashNextAck();
    expect(await send(h, envelopeOf("effect-state-9"))).toMatchObject({
      code: "INTERNAL",
      details: { dispatch: "committed" },
    });
    // A typed pre-commit refusal (the native transaction rolled back), fenced under the commit lock:
    // `journaled_uncommitted` with `fenced`, and the dispatch can never commit later.
    h.native.refuseNext = "STALE_DECISION";
    const stale = envelopeOf("effect-state-10");
    expect(await send(h, stale)).toMatchObject({
      code: "STALE_DECISION",
      details: { dispatch: "journaled_uncommitted", fenced: true },
    });
    expect(h.ledger.abandoned.has(`${TENANT}/effect-state-10/${stale.dispatchId}`)).toBe(true);
    expect(() =>
      h.ledger.commit({ tenant: TENANT } as AuthScope, "effect-state-10", stale.dispatchId, {}, "2026-10-28T00:00:00Z"),
    ).toThrow("DISPATCH_ABANDONED");
    // Refused before anything was sent (expired deadline at envelope admission): `not_journaled`.
    const late = {
      ...envelopeOf("effect-state-11"),
      governors: { ...envelopeOf("x").governors, deadline: "2020-01-01T00:00:00Z" },
    };
    expect(await send(h, late)).toMatchObject({ details: { dispatch: "not_journaled" } });
    expect(h.ledger.dispatches.get(`${TENANT}/effect-state-11`)).toBeUndefined();
    // An untyped failure (connection reset, timeout: the commit may be in flight) is `unknown`, never fenced.
    h.native.refuseNext = "INTERNAL";
    const reset = envelopeOf("effect-state-13");
    expect(await send(h, reset)).toMatchObject({ code: "INTERNAL", details: { dispatch: "unknown" } });
    expect(h.ledger.abandoned.has(`${TENANT}/effect-state-13/${reset.dispatchId}`)).toBe(false);
    // Whether the native transaction committed cannot be read back: `unknown`.
    h.native.refuseNext = "INTERNAL";
    const lookup = h.ledger.lookup.bind(h.ledger);
    let calls = 0;
    h.ledger.lookup = async (scope, key) => {
      calls += 1;
      if (calls === 2) throw new Error("STORE_UNAVAILABLE");
      return lookup(scope, key);
    };
    expect(await send(h, envelopeOf("effect-state-12"))).toMatchObject({ details: { dispatch: "unknown" } });
  });

  it("reordered acknowledgment: a late original receipt write after reconstruction keeps the first-recorded receipt", async () => {
    const h = harness();
    const original = envelopeOf("effect-late-5");
    const record = h.ledger.record.bind(h.ledger);
    let release!: () => void;
    const held = new Promise<void>((done) => {
      release = done;
    });
    h.ledger.record = async (scope, receipt) => {
      h.ledger.record = record;
      await held; // the original dispatch's acknowledgment is delayed past the recovery
      return record(scope, receipt);
    };
    const late = send(h, original);
    await new Promise((done) => setTimeout(done, 10));
    const recovered = await lookup(h, "effect-late-5");
    expect(recovered.disposition).toBe("found");
    release();
    const answered = (await late) as OperationReceipt;
    expect(recovered.disposition === "found" && answered).toEqual(
      recovered.disposition === "found" && recovered.receipt,
    );
    expect(h.native.applies).toBe(1);
  });

  it("a native_only effect without a commit stamp stays UNRESOLVED_EFFECT and is never applied again", async () => {
    const h = harness();
    const original = envelopeOf("effect-legacy-6");
    // A pre-2.5.0 / non-K01 native commit: the commit stamp exists without a journaled dispatch the host can read.
    h.ledger.commits.set(`${TENANT}/effect-legacy-6`, {
      dispatchId: "dispatch-unknown",
      nativeRef: { receiptId: "rcpt-legacy" },
      committedAt: "2026-10-27T09:00:00Z",
    });
    expect(await send(h, original)).toMatchObject({ code: "UNRESOLVED_EFFECT" });
    expect((await lookup(h, "effect-legacy-6")).disposition).toBe("unresolved");
    expect(h.native.applies).toBe(0);
  });
});
