import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { handleKnowledgeOperation } from "./http.js";
import { ReportKindCatalog } from "@aiengineer/knowledge-application";
import { IngestionExecutor, type IngestionExecutorConfig, KnowledgeError } from "@aiengineer/knowledge-db";
import { normalizedValuesDigest } from "@aiengineer/knowledge-research-core";
import {
  type JsonValue,
  KnowledgePlanPreviewSchema,
  OperationEnvelopeSchema,
  ReceiptLookupSchema,
  digestCanonical,
} from "@aiengineer/knowledge-operation-protocol";
import { describe, expect, it } from "vitest";
import {
  DispatchRegistry,
  JwksCache,
  KnowledgeCredentialVerifier,
  KnowledgeOperationService,
  ProtocolRefusal,
  createInMemoryBackend,
  staticJwksSource,
} from "@aiengineer/knowledge-host/knowledge-operation";
import { createIngestionApplyPort } from "@aiengineer/knowledge-binding-aiengineer-postgres";
import {
  TEST_AUDIENCE,
  TEST_INSTALLATION,
  TEST_ISSUER,
  claimsFor,
  envelopeFor,
  generateIssuerKey,
  jwksOf,
  liveOrigin,
  signCredential,
} from "./tests/test-support.js";

/**
 * Sprint OC `knowledge.plan_preview` through the K01 service and the AI Engineer ingestion port, with a fake native
 * executor (the real planner needs the AI Engineer database: `aidb-apply.integration.test.ts`). Read-only: the apply
 * path is never entered, nothing is bound or journaled; refusals are typed.
 */
const KINDS = ReportKindCatalog.fromDirectory(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../../../catalog/research/report-kinds"),
);
const TENANT = "00000000-0000-7000-8000-0000000000ac";
const origin = liveOrigin(TENANT, { invocation: "inv-preview" });
const PREVIEW = {
  planId: "0b9d6f5e-1c2a-8a3b-9c4d-5e6f7a8b9c0d",
  semanticPayloadDigest: `sha256:${"1".repeat(64)}`,
  boundEffectDigest: `sha256:${"2".repeat(64)}`,
  normalizedValuesDigest: `sha256:${"3".repeat(64)}`,
  processedEpoch: 4,
  migrationHead: "20261031010000",
};

interface Native {
  apply(intent: unknown): Promise<unknown>;
  preview?(intent: unknown): Promise<unknown>;
}

function service(native: Native) {
  const key = generateIssuerKey("mc-preview");
  const backend = createInMemoryBackend({
    application: "ai-engineer",
    binding: "in-memory",
    kinds: KINDS,
    auditor: null,
    apply: createIngestionApplyPort(native as never),
  });
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
  return { svc, key, backend };
}

/** The apply intent WITHOUT the decision fields (what Mission Control has before it decides). */
function previewIntent(effectKey: string, tenant = TENANT, exactUse: Record<string, unknown> = {}): JsonValue {
  return {
    schemaVersion: "knowledge-ingestion-intent.v1",
    intentId: "intent-preview",
    context: { tenantId: tenant },
    exactUse: { effectKey, originatingOrigin: origin, ...exactUse },
  } as unknown as JsonValue;
}

interface Call {
  readonly operations?: Parameters<typeof claimsFor>[0]["operations"];
  readonly effectGrant?: boolean;
  readonly effectKey?: string;
  readonly withoutEffect?: boolean;
  readonly nativeContract?: { name: string; version: string };
  readonly declaredUse?: { use: string; audience: string };
}

async function preview(
  svc: KnowledgeOperationService,
  key: ReturnType<typeof generateIssuerKey>,
  intent: JsonValue,
  call: Call = {},
) {
  const effectKey = call.effectKey ?? "effect-preview-1";
  const envelope = envelopeFor({
    operation: "knowledge.plan_preview",
    origin,
    payload: intent,
    effectKey,
    // The same envelope as the apply, before the decision: any well-formed bound digest is ignored.
    boundEffectDigest: `sha256:${"f".repeat(64)}`,
    ...(call.withoutEffect ? { withoutEffect: true } : {}),
    ...(call.nativeContract ? { nativeContract: call.nativeContract } : {}),
    ...(call.declaredUse ? { declaredUse: call.declaredUse } : {}),
  });
  const token = signCredential(
    key,
    claimsFor({
      origin,
      operations: call.operations ?? ["knowledge.plan_preview"],
      dispatchId: envelope.dispatchId,
      ...(call.effectGrant ? { effect: { effectKey, boundEffectDigest: `sha256:${"f".repeat(64)}` } } : {}),
    }),
  );
  return svc.invoke(token, envelope).catch((error: unknown) => {
    if (error instanceof ProtocolRefusal) return error.error;
    throw error;
  });
}

describe("knowledge.plan_preview over K01", () => {
  it("answers the native planner's knowledge-plan-preview.v1 without entering the apply path", async () => {
    const previewed: unknown[] = [];
    const applied: unknown[] = [];
    const { svc, key } = service({
      apply: async (intent) => applied.push(intent),
      preview: async (intent) => {
        previewed.push(intent);
        return PREVIEW;
      },
    });
    const intent = previewIntent("effect-preview-1");
    const result = await preview(svc, key, intent);
    expect(KnowledgePlanPreviewSchema.parse(result)).toEqual(PREVIEW);
    expect(applied).toEqual([]);
    // The native planner receives the intent as sent (no decision fields are added).
    expect(previewed).toEqual([intent]);
    // Nothing is bound, journaled or receipted under the effect key.
    const lookup = await svc.receipt(
      signCredential(
        key,
        claimsFor({ origin, operations: ["receipt.get"], dispatchId: `dispatch-lookup-${Date.now()}` }),
      ),
      "effect-preview-1",
    );
    expect(ReceiptLookupSchema.parse(lookup).disposition).toBe("not_found");
  });

  it("takes the envelope with or without the effect binding, and ignores presented decision fields", async () => {
    const previewed: unknown[] = [];
    const { svc, key } = service({
      apply: async () => {
        throw new Error("never");
      },
      preview: async (intent) => {
        previewed.push(intent);
        return PREVIEW;
      },
    });
    expect(await preview(svc, key, previewIntent("effect-preview-2"), { withoutEffect: true })).toEqual(PREVIEW);
    const decided = previewIntent("effect-preview-3", TENANT, {
      useDecisionId: "ud-anything",
      boundEffectDigest: `sha256:${"9".repeat(64)}`,
      processedEpoch: 0,
      normalizedValuesDigest: `sha256:${"8".repeat(64)}`,
    });
    expect(await preview(svc, key, decided, { effectKey: "effect-preview-3" })).toEqual(PREVIEW);
    expect(previewed).toHaveLength(2);
  });

  it("is described next to knowledge.apply only when the apply port previews", async () => {
    const withPreview = service({ apply: async () => null, preview: async () => PREVIEW });
    const operations = withPreview.svc.descriptorFor(withPreview.backend).operations;
    expect(operations).toContain("knowledge.plan_preview");
    expect(operations.indexOf("knowledge.plan_preview")).toBe(operations.indexOf("knowledge.apply") + 1);
    const applyOnly = service({ apply: async () => null });
    expect(applyOnly.svc.descriptorFor(applyOnly.backend).operations).not.toContain("knowledge.plan_preview");
    expect(await preview(applyOnly.svc, applyOnly.key, previewIntent("effect-preview-4"))).toMatchObject({
      code: "SCHEMA_UNSUPPORTED",
    });
  });

  it("refuses typed: credential scope, effect mismatch, tenant, contract and missing exact use", async () => {
    const calls: unknown[] = [];
    const { svc, key } = service({
      apply: async () => null,
      preview: async (intent) => {
        calls.push(intent);
        return PREVIEW;
      },
    });
    // A credential that grants only knowledge.apply does not grant the preview; a preview credential carries no effect.
    expect(
      await preview(svc, key, previewIntent("effect-r1"), { operations: ["knowledge.apply"], effectGrant: true }),
    ).toMatchObject({ code: "SCOPE_DENIED" });
    expect(await preview(svc, key, previewIntent("effect-r2"), { effectGrant: true })).toMatchObject({
      code: "SCOPE_DENIED",
    });
    // The intent names another effect key or originating origin than the envelope's effect.
    expect(await preview(svc, key, previewIntent("effect-other"), { effectKey: "effect-r3" })).toMatchObject({
      code: "EFFECT_CONFLICT",
    });
    expect(
      await preview(
        svc,
        key,
        previewIntent("effect-r4", TENANT, { originatingOrigin: liveOrigin(TENANT, { attempt: 7 }) }),
        { effectKey: "effect-r4" },
      ),
    ).toMatchObject({ code: "EFFECT_CONFLICT" });
    expect(
      await preview(svc, key, previewIntent("effect-r5", "00000000-0000-7000-8000-0000000000bb"), {
        effectKey: "effect-r5",
        withoutEffect: true,
      }),
    ).toMatchObject({ code: "SCOPE_DENIED" });
    expect(
      await preview(svc, key, previewIntent("effect-r6"), {
        effectKey: "effect-r6",
        nativeContract: { name: "research-report", version: "v2" },
      }),
    ).toMatchObject({ code: "SCHEMA_UNSUPPORTED" });
    const bare = { ...(previewIntent("effect-r7") as Record<string, unknown>) };
    delete bare.exactUse;
    expect(await preview(svc, key, bare as JsonValue, { effectKey: "effect-r7", withoutEffect: true })).toMatchObject({
      code: "SCHEMA_UNSUPPORTED",
    });
    // The intent declares a use, the envelope another.
    expect(
      await preview(
        svc,
        key,
        { ...(previewIntent("effect-r8") as Record<string, unknown>), declaredUse: { use: "a", audience: "b" } },
        { effectKey: "effect-r8", declaredUse: { use: "c", audience: "d" } },
      ),
    ).toMatchObject({ code: "SCHEMA_UNSUPPORTED" });
    expect(calls).toEqual([]);
  });

  it("maps native planner failures to typed refusals and refuses a malformed answer", async () => {
    let failure: unknown = null;
    let answer: unknown = PREVIEW;
    const { svc, key } = service({
      apply: async () => null,
      preview: async () => {
        if (failure !== null) throw failure;
        return answer;
      },
    });
    failure = new KnowledgeError("INTENT_SCHEMA_INVALID", "bad intent", 1);
    expect(await preview(svc, key, previewIntent("effect-n1"), { effectKey: "effect-n1" })).toMatchObject({
      code: "SCHEMA_UNSUPPORTED",
    });
    failure = new KnowledgeError("DB_UNAVAILABLE", "down", 2);
    expect(await preview(svc, key, previewIntent("effect-n2"), { effectKey: "effect-n2" })).toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
    });
    failure = null;
    answer = { ...PREVIEW, boundEffectDigest: "not-a-digest" };
    expect(await preview(svc, key, previewIntent("effect-n3"), { effectKey: "effect-n3" })).toMatchObject({
      code: "INTERNAL",
    });
  });
});

describe("knowledge.plan_preview envelope rules (K01)", () => {
  it("answers a synchronous HTTP document and requires a fresh credential for each preview", async () => {
    let planned = 0;
    const { svc, key } = service({
      apply: async () => {
        throw new Error("preview must not apply");
      },
      preview: async () => {
        planned += 1;
        return PREVIEW;
      },
    });
    const server = createServer((request, response) => {
      void handleKnowledgeOperation(request, response, new URL(request.url ?? "/", "http://localhost"), svc);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/knowledge-operation/v2/invoke`;
      const request = () => {
        const envelope = envelopeFor({
          operation: "knowledge.plan_preview",
          origin,
          payload: previewIntent("effect-http"),
          withoutEffect: true,
        });
        const token = signCredential(
          key,
          claimsFor({ origin, operations: ["knowledge.plan_preview"], dispatchId: envelope.dispatchId }),
        );
        return {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(envelope),
        };
      };
      const firstRequest = request();
      const first = await fetch(url, firstRequest);
      expect(first.status).toBe(200);
      expect(KnowledgePlanPreviewSchema.parse(await first.json())).toEqual(PREVIEW);
      const replay = await fetch(url, firstRequest);
      expect(replay.status).toBe(401);
      const fresh = await fetch(url, request());
      expect(fresh.status).toBe(200);
      expect(KnowledgePlanPreviewSchema.parse(await fresh.json())).toEqual(PREVIEW);
      expect(planned).toBe(2);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("may carry the apply's effect binding and declared use; other non-effect operations still may not", () => {
    const withUse = envelopeFor({
      operation: "knowledge.plan_preview",
      origin,
      payload: previewIntent("effect-e1"),
      effectKey: "effect-e1",
      declaredUse: { use: "knowledge_ingestion.apply", audience: "official" },
    });
    expect(OperationEnvelopeSchema.safeParse(withUse).success).toBe(true);
    expect(OperationEnvelopeSchema.safeParse({ ...withUse, effect: null }).success).toBe(true);
    expect(OperationEnvelopeSchema.safeParse({ ...withUse, operation: "knowledge.read" }).success).toBe(false);
  });
});

describe("knowledge.plan_preview normalized values (no values presented)", () => {
  /**
   * Integrator review (a): with no `normalizedValuesDigest` in the intent, the preview's echo must be exactly the digest
   * an empty-values decision stores and the admission compares: the binding's `recordDecision` stores
   * `normalizedValuesDigest(decision.normalizedValues)` (research-core; research-binding.ts) and `admit_exact_use`
   * compares the native write's digest with that column. The AIDB integration test admits an apply on it end to end.
   */
  it("echoes research-core normalizedValuesDigest({}) through the real executor and port", async () => {
    const untouchable = new Proxy(
      {},
      {
        get: () => {
          throw new Error("must not be touched");
        },
      },
    );
    const ingestion = new IngestionExecutor({
      db: {
        transaction: async (_scope: unknown, work: (client: unknown) => Promise<unknown>) =>
          work({ query: async () => ({ rows: [{ epoch: "2" }] }) }),
      },
      workspace: { migrationHead: "20261031010000" },
      artifacts: untouchable,
      executorVersion: "knowledge-executor/test",
      evidence: () => untouchable,
    } as unknown as IngestionExecutorConfig);
    // The database planner is replaced by a minimal applicable plan; the values digest does not depend on it.
    Object.assign(ingestion, {
      planWithContext: async (intent: unknown) => ({
        intent,
        plan: {
          planId: PREVIEW.planId,
          errors: [],
          proposals: [{ outcome: "admitted" }],
          effect: {
            schemaVersion: "knowledge-ingestion-effect.v1",
            effectKey: "effect-nv-1",
            semanticPayloadDigest: PREVIEW.semanticPayloadDigest,
            boundEffectDigest: PREVIEW.boundEffectDigest,
          },
        },
        vocabulary: null,
      }),
    });
    const intent: Record<string, unknown> = {
      ...(previewIntent("effect-nv-1") as Record<string, unknown>),
      proposals: [
        {
          proposalId: "p-01",
          kind: "candidate.stage",
          entityKind: "organization",
          displayName: "Preview Org",
          reason: "needs_human",
        },
      ],
    };
    const { svc, key } = service({ apply: async () => null, preview: (value) => ingestion.preview(value) });
    const answered = KnowledgePlanPreviewSchema.parse(
      await preview(svc, key, intent as unknown as JsonValue, { effectKey: "effect-nv-1" }),
    );
    const empty = normalizedValuesDigest({});
    expect(answered.normalizedValuesDigest).toBe(empty);
    // The K01 canonical digest of `{}` is what the component compares (the same canonicalization on both sides).
    expect(empty).toBe(digestCanonical({}));
    // A presented digest is echoed unchanged (the decision must carry what the native write presents).
    const values = normalizedValuesDigest({ parameters: "7000000000" });
    const presented = KnowledgePlanPreviewSchema.parse(
      await preview(
        svc,
        key,
        {
          ...intent,
          exactUse: { ...(intent.exactUse as Record<string, unknown>), normalizedValuesDigest: values },
        } as unknown as JsonValue,
        { effectKey: "effect-nv-1" },
      ),
    );
    expect(presented.normalizedValuesDigest).toBe(values);
  });
});
