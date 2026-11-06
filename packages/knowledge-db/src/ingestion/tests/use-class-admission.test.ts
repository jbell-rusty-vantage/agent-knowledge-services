import { digestBytes } from "@aiengineer/knowledge-operation-protocol";
import { describe, expect, it } from "vitest";
import type { KnowledgeError } from "../../schema-workspace/errors.js";
import {
  IngestionExecutor,
  type IngestionExecutorConfig,
  type UseClassPolicy,
  assertUseAdmissible,
} from "../executor.js";
import { IngestionIntentSchema } from "../intent.js";
import { priceIntent } from "./test-fixtures.js";

/**
 * R1 F9: exact-use admission is not opt-in for official or consequential uses. The use-class policy is the K08
 * registry served through research-core's `useClassPolicy` (the binding suite runs the real registry); this unit
 * suite drives the executor's rule with a structural stand-in so knowledge-db keeps no copy of the registry's rules.
 */
const policy: UseClassPolicy = {
  registry: { id: "use-classes", version: "1.0.0", digest: digestBytes("registry") },
  classOf: (declared) =>
    declared === null
      ? "internal"
      : declared.audience === "official"
        ? "official"
        : declared.use.startsWith("knowledge_ingestion.")
          ? "consequential"
          : "internal",
};
const exactUse = {
  useDecisionId: "ud-1",
  boundEffectDigest: digestBytes("effect"),
  processedEpoch: 0,
  normalizedValuesDigest: digestBytes("values"),
  effectKey: "effect-1",
  originatingOrigin: {
    kind: "standalone" as const,
    installationId: "install-1",
    applicationId: "ai-engineer",
    tenantId: "00000000-0000-7000-8000-000000000001",
    issuer: "mission-control",
    subject: "runtime",
    mission: null,
    recoveryAuthorityRef: null,
    invocationId: "inv-1",
    authenticatedAt: "2026-10-25T00:00:00Z",
  },
};
const intent = (extra: Record<string, unknown> = {}) => IngestionIntentSchema.parse({ ...priceIntent(), ...extra });
const code = (run: () => unknown): string | null => {
  try {
    run();
    return null;
  } catch (error) {
    return (error as KnowledgeError).code;
  }
};

describe("use-class admission policy (R1 F9)", () => {
  it("refuses an official or consequential use without an exact-use binding, REVIEW_REQUIRED", () => {
    const official = intent({ declaredUse: { use: "report_publication", audience: "official" } });
    expect(code(() => assertUseAdmissible(official, policy))).toBe("REVIEW_REQUIRED");
    const consequential = intent({ declaredUse: { use: "knowledge_ingestion.fact_assert_state", audience: "team" } });
    expect(code(() => assertUseAdmissible(consequential, policy))).toBe("REVIEW_REQUIRED");
    // With the binding, the policy passes and the in-transaction admission decides.
    expect(code(() => assertUseAdmissible(intent({ ...official, exactUse }), policy))).toBeNull();
    // Internal uses and undeclared intents (registry default class) keep the plain ingestion path.
    expect(code(() => assertUseAdmissible(intent({ declaredUse: { use: "notes", audience: "team" } }), policy))).toBe(
      null,
    );
    expect(code(() => assertUseAdmissible(intent(), policy))).toBeNull();
  });

  it("refuses a declared use the executor cannot classify, SCHEMA_UNSUPPORTED", () => {
    const declared = intent({ declaredUse: { use: "report_publication", audience: "official" } });
    expect(code(() => assertUseAdmissible(declared, undefined))).toBe("SCHEMA_UNSUPPORTED");
    expect(code(() => assertUseAdmissible(intent(), undefined))).toBeNull();
  });

  it("the executor refuses before any read or write", async () => {
    const untouchable = new Proxy(
      {},
      {
        get: () => {
          throw new Error("the database must not be touched");
        },
      },
    );
    const executor = new IngestionExecutor({
      db: untouchable,
      workspace: { migrationHead: "20260912020000" },
      artifacts: untouchable,
      executorVersion: "knowledge-executor/test",
      evidence: () => untouchable,
      useClasses: policy,
    } as unknown as IngestionExecutorConfig);
    await expect(
      executor.apply({ ...priceIntent(), declaredUse: { use: "report_publication", audience: "official" } }),
    ).rejects.toMatchObject({ code: "REVIEW_REQUIRED", exit: 1 });
  });
});
