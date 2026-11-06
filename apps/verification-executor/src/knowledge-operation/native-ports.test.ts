import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ReportKindCatalog, loadUseClassesFile } from "@aiengineer/knowledge-application";
import { ExactUseAdmissionError, type UseClassPolicy } from "@aiengineer/knowledge-db";
import { useClassPolicy } from "@aiengineer/knowledge-research-core";
import { type JsonValue, OperationReceiptSchema } from "@aiengineer/knowledge-operation-protocol";
import { describe, expect, it } from "vitest";
import {
  DispatchRegistry,
  JwksCache,
  KnowledgeCredentialVerifier,
  staticJwksSource,
} from "@aiengineer/knowledge-host/knowledge-operation";
import { createInMemoryBackend } from "@aiengineer/knowledge-host/knowledge-operation";
import { ProtocolRefusal } from "@aiengineer/knowledge-host/knowledge-operation";
import { createIngestionApplyPort } from "@aiengineer/knowledge-binding-aiengineer-postgres";
import { KnowledgeOperationService } from "@aiengineer/knowledge-host/knowledge-operation";
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
 * The native ports behind the K01 envelope with fake native executors (the real exact-use ingestion transaction needs
 * the AI Engineer database, which this unit test does not start): exact-use binding checks, typed admission refusals,
 * the receipt mapping, and the K08 use-class gate (R1 F9) at the K01 boundary.
 */
const KINDS = ReportKindCatalog.fromDirectory(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../../../catalog/research/report-kinds"),
);
const TENANT = "00000000-0000-7000-8000-0000000000aa";

function service(ingestion: { apply(intent: unknown): Promise<unknown> }, useClasses?: UseClassPolicy) {
  const key = generateIssuerKey("mc-apply");
  const backend = createInMemoryBackend({
    application: "ai-engineer",
    binding: "in-memory",
    kinds: KINDS,
    auditor: null,
    apply: createIngestionApplyPort(ingestion as never, useClasses),
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
  return { svc, key };
}

function intentFor(origin: ReturnType<typeof liveOrigin>, effectKey: string, tenant = TENANT): JsonValue {
  return {
    schemaVersion: "knowledge-ingestion-intent.v1",
    intentId: "intent-sv16",
    context: { tenantId: tenant },
    exactUse: {
      useDecisionId: "decision-1",
      boundEffectDigest: `sha256:${"a".repeat(64)}`,
      processedEpoch: 0,
      normalizedValuesDigest: `sha256:${"b".repeat(64)}`,
      effectKey,
      originatingOrigin: origin,
    },
  } as unknown as JsonValue;
}

async function invoke(
  svc: KnowledgeOperationService,
  key: ReturnType<typeof generateIssuerKey>,
  intent: JsonValue,
  effectKey: string,
  declaredUse?: { use: string; audience: string },
) {
  const origin = liveOrigin(TENANT, { invocation: "inv-apply" });
  const envelope = envelopeFor({
    operation: "knowledge.apply",
    origin,
    payload: intent,
    effectKey,
    ...(declaredUse ? { declaredUse } : {}),
    // Integrator decision: the envelope carries the plan-level bound digest the intent's exact use names.
    boundEffectDigest:
      (intent as { exactUse?: { boundEffectDigest: string } }).exactUse?.boundEffectDigest ??
      `sha256:${"a".repeat(64)}`,
  });
  const token = signCredential(
    key,
    claimsFor({
      origin,
      operations: ["knowledge.apply"],
      dispatchId: envelope.dispatchId,
      effect: { effectKey, boundEffectDigest: envelope.effect?.boundEffectDigest as string },
    }),
  );
  return svc.invoke(token, envelope).catch((error: unknown) => {
    if (error instanceof ProtocolRefusal) return error.error;
    throw error;
  });
}

describe("knowledge.apply through the native exact-use ingestion port", () => {
  const origin = liveOrigin(TENANT, { invocation: "inv-apply" });

  it("maps the native exact-use receipt to an operation-receipt.v2", async () => {
    const calls: unknown[] = [];
    const { svc, key } = service({
      apply: async (intent) => {
        calls.push(intent);
        return {
          receiptId: "rcpt-1",
          outcome: "applied",
          head: { before: 4, after: 5, rebased: false },
          duplicateOf: null,
          admission: {
            path: "component",
            useDecisionId: "decision-1",
            boundEffectDigest: `sha256:${"a".repeat(64)}`,
            effectKey: "effect-apply-1",
            authoritativeEpoch: 3,
            effectReceiptDigest: `sha256:${"c".repeat(64)}`,
          },
        };
      },
    });
    const result = OperationReceiptSchema.parse(
      await invoke(svc, key, intentFor(origin, "effect-apply-1"), "effect-apply-1"),
    );
    expect(calls).toHaveLength(1);
    expect(result).toMatchObject({
      outcome: "applied",
      processedRevocationEpoch: 3,
      concurrencyToken: { before: "4", after: "5" },
      nativeReceiptRef: { kind: "receipt", id: "rcpt-1", digest: `sha256:${"c".repeat(64)}` },
    });
  });

  it("refuses an intent bound to another effect key, origin or tenant, and maps admission refusals", async () => {
    const { svc, key } = service({
      apply: async () => {
        throw new ExactUseAdmissionError("STALE_DECISION", {
          outcome: "refused",
          reason: "superseded",
          path: "component" as never,
        });
      },
    });
    expect(await invoke(svc, key, intentFor(origin, "effect-other"), "effect-apply-2")).toMatchObject({
      code: "EFFECT_CONFLICT",
    });
    expect(
      await invoke(svc, key, intentFor(liveOrigin(TENANT, { attempt: 9 }), "effect-apply-3"), "effect-apply-3"),
    ).toMatchObject({ code: "EFFECT_CONFLICT" });
    expect(
      await invoke(
        svc,
        key,
        intentFor(origin, "effect-apply-4", "00000000-0000-7000-8000-0000000000bb"),
        "effect-apply-4",
      ),
    ).toMatchObject({ code: "SCOPE_DENIED" });
    expect(await invoke(svc, key, intentFor(origin, "effect-apply-5"), "effect-apply-5")).toMatchObject({
      code: "STALE_DECISION",
      domainOutcome: true,
    });
  });
});

describe("knowledge.apply K08 use-class gate (R1 F9, component 2.4.0)", () => {
  const origin = liveOrigin(TENANT, { invocation: "inv-apply" });
  const policy = useClassPolicy(
    loadUseClassesFile(
      resolve(dirname(fileURLToPath(import.meta.url)), "../../../../catalog/research/use-classes.json"),
    ),
  );
  const withoutExactUse = (declaredUse?: { use: string; audience: string }) => {
    const intent = { ...(intentFor(origin, "effect-use-1") as Record<string, unknown>) };
    delete intent.exactUse;
    return { ...intent, ...(declaredUse ? { declaredUse } : {}) } as unknown as JsonValue;
  };

  it("refuses an official use without exactUse REVIEW_REQUIRED before the native executor runs", async () => {
    const calls: unknown[] = [];
    const { svc, key } = service({ apply: async (intent) => calls.push(intent) }, policy);
    const official = await invoke(
      svc,
      key,
      withoutExactUse({ use: "report_publication", audience: "official" }),
      "effect-use-1",
    );
    expect(official).toMatchObject({ code: "REVIEW_REQUIRED" });
    // Through the K01 envelope (use/audience fields), with an intent that declares nothing: also REVIEW_REQUIRED.
    expect(
      await invoke(svc, key, withoutExactUse(), "effect-use-1", {
        use: "knowledge_ingestion.apply",
        audience: "official",
      }),
    ).toMatchObject({ code: "REVIEW_REQUIRED" });
    // No declared use anywhere: refused, never a silent default.
    expect(await invoke(svc, key, withoutExactUse(), "effect-use-1")).toMatchObject({
      code: "SCHEMA_UNSUPPORTED",
      details: { useClassRegistry: "use-classes" },
    });
    // Envelope and intent declaring different uses: refused.
    expect(
      await invoke(svc, key, withoutExactUse({ use: "notes", audience: "team" }), "effect-use-1", {
        use: "knowledge_ingestion.apply",
        audience: "official",
      }),
    ).toMatchObject({ code: "SCHEMA_UNSUPPORTED" });
    // An internal use still needs the exact-use intent shape over K01.
    expect(await invoke(svc, key, withoutExactUse({ use: "notes", audience: "team" }), "effect-use-1")).toMatchObject({
      code: "SCHEMA_UNSUPPORTED",
    });
    expect(calls).toHaveLength(0);
  });
});
