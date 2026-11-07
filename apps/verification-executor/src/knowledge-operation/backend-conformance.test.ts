import { randomBytes, randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ReportKindCatalog } from "@aiengineer/knowledge-application";
import { FIXTURE_SEAL_KEYS } from "@aiengineer/knowledge-application/testing";
import {
  ComponentDatabase,
  closeInvalidation,
  createIngestionApplyPort,
  pinSealSigningKey,
  recordInvalidation,
} from "@aiengineer/knowledge-binding-aiengineer-postgres";
import {
  BIOTECH_SCHEMA_RELEASE_V2_2_0,
  BiotechGraphAdmission,
  type FrozenReportBinding,
  biotechEffect,
  biotechReportKind,
  reportPublishFields,
} from "@aiengineer/knowledge-binding-biotech-graph";
import {
  ExactUseAdmissionError,
  admissionErrorCode,
  bindExactEffect,
  evaluateExactUse,
  lookupExactUseReceipt,
  recordEffectCommit,
  recordExactUseReceipt,
} from "@aiengineer/knowledge-db";
import { install, loadComponent } from "@aiengineer/knowledge-db-contract";
import {
  type BackendConformance,
  defineBackendConformance,
} from "@aiengineer/knowledge-host/knowledge-operation/conformance";
import type { BackendRegistration, KnowledgeReadIntentPort } from "@aiengineer/knowledge-host/knowledge-operation";
import {
  type JsonValue,
  type Origin,
  READ_INTENT_CONTRACT,
  boundEffectDigest,
  readIntentContentDigest,
  readIntentSnapshotDigest,
  canonicalJson,
  digestBytes,
} from "@aiengineer/knowledge-operation-protocol";
import type { AuthScope } from "@aiengineer/knowledge-research-core";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KNOWLEDGE_BACKENDS } from "../serve.js";

/**
 * Sprint OC R5 (OVE-199): the backend conformance suite (host `knowledge-operation/conformance`) against every
 * registration this executable composes (`KNOWLEDGE_BACKENDS`), each on its own disposable store: a fresh database
 * with the component installed on the disposable PostgreSQL 17 (`KS_AIENG_DB_ADMIN_DSN`, container
 * `sprint-v-pg17`) for both PostgreSQL bindings. Without that DSN the store-backed checks of both PostgreSQL bindings
 * are visible skips naming the variable; with `CI` or `KS_REQUIRE_CONFORMANCE_STORE=1` set they fail instead.
 *
 * Evidence limit: the AI Engineer `knowledge.apply` checks run the binding's real ingestion apply port over a
 * stand-in ingestion executor (one component-path native transaction on pg17, below); the real AIDB
 * `IngestionExecutor` ledger path is exercised only by `aidb-apply.integration.test.ts`, which needs a local
 * Supabase project and was not run for R5. Engineering fixtures only; no model or network calls.
 */
const ADMIN = process.env.KS_AIENG_DB_ADMIN_DSN;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const KINDS = ReportKindCatalog.fromDirectory(resolve(ROOT, "catalog/research/report-kinds"));
const DSN_VARIABLE = "KS_AIENG_DB_COMPONENT_DSN";
const BIOTECH_DSN_VARIABLE = "KS_BIOTECH_DB_COMPONENT_DSN";
const WRITER = { role: "knowledge_verification_writer" as const };

/** Without the disposable PostgreSQL the store-backed checks are visible skips (failures where the store is required). */
const STORE_UNAVAILABLE: BackendConformance["storeUnavailable"] = ADMIN
  ? undefined
  : {
      reason: "skipped: KS_AIENG_DB_ADMIN_DSN is unset (disposable PostgreSQL 17, container sprint-v-pg17)",
      required: Boolean(process.env.CI) || process.env.KS_REQUIRE_CONFORMANCE_STORE === "1",
    };

function registration(id: string): BackendRegistration {
  return KNOWLEDGE_BACKENDS.get(id);
}

/** Drop one disposable database (forcing its connections closed). */
async function dropDatabase(database: string): Promise<void> {
  const cleanup = new Client({ connectionString: ADMIN });
  await cleanup.connect();
  try {
    await cleanup.query(`drop database if exists ${database} with (force)`);
  } finally {
    await cleanup.end();
  }
}

/**
 * A fresh database with the component installed for one (application, binding), the fixture seal key pinned and
 * `setup` run as the database owner; dropped again if any of that fails.
 */
/** A read port answering every operation as an empty schema search (no knowledge database). */
function standInReadIntent(): KnowledgeReadIntentPort {
  return {
    nativeContract: { ...READ_INTENT_CONTRACT },
    run: async (_scope, { request }) => {
      const operations = request.operations.map((operation) => ({
        opId: operation.opId,
        kind: operation.kind,
        status: "empty" as const,
        rowCount: 0,
        truncated: false,
        contentDigest: readIntentContentDigest({ hits: [] }),
        bodyWithheld: false as const,
        value: { hits: [] },
      }));
      return {
        snapshotId: "conformance-snapshot",
        snapshotDigest: readIntentSnapshotDigest(0, operations),
        knowledgeHead: { knowledgeSeq: 0, updatedAt: "2026-10-31T00:00:00Z" },
        atKnowledgeSeq: 0,
        contract: { migrationHead: "conformance" },
        operations,
      };
    },
  };
}

async function componentDatabase(
  application: string,
  binding: string,
  installationId: string,
  setup: (owner: Client) => Promise<void> = async () => undefined,
) {
  const database = `kvconf_${randomBytes(4).toString("hex")}`;
  const url = new URL(ADMIN as string);
  url.pathname = `/${database}`;
  const dsn = url.toString();
  const admin = new Client({ connectionString: ADMIN });
  await admin.connect();
  try {
    await admin.query(`create database ${database}`);
  } finally {
    await admin.end();
  }
  try {
    await install(loadComponent(), { adminDsn: dsn, installationId, applicationId: application, binding });
    await pinSealSigningKey(dsn, { keyId: FIXTURE_SEAL_KEYS.signer.keyId, publicKey: FIXTURE_SEAL_KEYS.publicKey });
    const owner = new Client({ connectionString: dsn });
    await owner.connect();
    try {
      await setup(owner);
    } finally {
      await owner.end();
    }
  } catch (error) {
    await dropDatabase(database).catch(() => undefined);
    throw error;
  }
  const db = new ComponentDatabase({ connectionString: dsn, maximumPoolSize: 3 });
  return {
    dsn,
    db,
    drop: async () => {
      await db.end().catch(() => undefined);
      await dropDatabase(database);
    },
  };
}

/** An invalidation of an unrelated record advances the tenant's authoritative epoch (a reviewer correction). */
async function revoke(db: ComponentDatabase, scope: AuthScope): Promise<void> {
  await db.transaction({ tenantId: scope.tenant, ...WRITER }, async (c) => {
    const recorded = await recordInvalidation(
      c,
      scope.tenant,
      { kind: "fragment", id: `frag-unrelated-${randomUUID().slice(0, 8)}` },
      "conformance revocation before dispatch",
    );
    await closeInvalidation(c, scope.tenant, recorded.invalidationId, []);
  });
}

async function count(db: ComponentDatabase, scope: AuthScope, sql: string, effectKey: string): Promise<number> {
  const rows = await db.transaction({ tenantId: scope.tenant, ...WRITER, readOnly: true }, (c) =>
    c.query<{ n: number }>(sql, [scope.tenant, effectKey]),
  );
  return Number(rows.rows[0]?.n ?? 0);
}

// ------------------------------------------------------------------------------------------------ in-memory

const IN_MEMORY: BackendConformance = {
  registration: registration("in-memory"),
  openDisposable: async () => ({
    config: { application: "ai-engineer", binding: "in-memory", installationId: "conformance-in-memory" },
    // The fixture K07 seal key: the trusted assessment check seals through `report.seal` (WI-03).
    injection: { seal: FIXTURE_SEAL_KEYS },
    close: async () => undefined,
  }),
  exceptions: [],
};

// ------------------------------------------------------------------------------------------------ aiengineer-postgres

interface NativeFactIntent {
  readonly context: { readonly tenantId: string };
  readonly fact: JsonValue;
  readonly exactUse: {
    readonly effectKey: string;
    readonly boundEffectDigest: string;
    readonly originatingOrigin: Origin;
    readonly useDecisionId: string;
    readonly processedEpoch: number;
    readonly normalizedValuesDigest: string;
  };
}

/**
 * Stand-in for the knowledge-db `IngestionExecutor` (the AI Engineer knowledge database is a local Supabase stack this
 * suite does not start): ONE native transaction on the component installation that recomputes the plan-level bound
 * digest, binds the effect, admits the exact use (component rule), writes the domain row and the effect receipt, and
 * answers a resubmission with the stored receipt (`duplicateOf`), as the executor's idempotency ledger does. Like the
 * executor (WI-05) it stamps its native commit with the journaled K01 dispatch inside that transaction and reads the
 * committed receipt back (`committedExactUseReceipt`) without applying.
 */
function standInIngestion(db: ComponentDatabase) {
  return {
    async committedExactUseReceipt(input: { tenantId: string; effectKey: string; receiptId: string }) {
      return db.transaction({ tenantId: input.tenantId, ...WRITER }, async (c) => {
        const row = (
          await c.query<{ receipt: Record<string, unknown> }>(
            "select receipt from public.native_fact where tenant_id = $1 and effect_key = $2",
            [input.tenantId, input.effectKey],
          )
        ).rows[0];
        const stored = await lookupExactUseReceipt(c, input.tenantId, input.effectKey);
        const receipt = row?.receipt as
          | { receiptId?: string; admission?: { effectReceiptDigest?: string } }
          | undefined;
        if (
          !receipt ||
          receipt.receiptId !== input.receiptId ||
          receipt.admission?.effectReceiptDigest !== stored?.digest
        ) {
          throw new Error("RECEIPT_NOT_FOUND");
        }
        return { ...receipt, duplicateOf: null };
      });
    },
    async apply(intent: unknown, options: { effectDispatchId?: string } = {}) {
      const doc = intent as NativeFactIntent;
      const tenant = doc.context.tenantId;
      const use = doc.exactUse;
      return db.transaction({ tenantId: tenant, ...WRITER }, async (c) => {
        const prior = await c.query<{ receipt: Record<string, unknown> }>(
          "select receipt from public.native_fact where tenant_id = $1 and effect_key = $2",
          [tenant, use.effectKey],
        );
        if (prior.rows[0]) return { ...prior.rows[0].receipt, duplicateOf: prior.rows[0].receipt.receiptId };
        const native = Buffer.from(canonicalJson(doc.fact), "utf8");
        if (boundEffectDigest(native, use.originatingOrigin) !== use.boundEffectDigest) {
          throw new ExactUseAdmissionError("EFFECT_CONFLICT", {
            outcome: "rejected",
            reason: "EFFECT_DIGEST_MISMATCH",
            path: "component_only",
          });
        }
        await bindExactEffect(
          c,
          tenant,
          {
            effectKey: use.effectKey,
            semanticPayloadDigest: digestBytes(native),
            originatingOrigin: use.originatingOrigin,
          },
          use.boundEffectDigest,
        );
        const admitted = await evaluateExactUse(c, tenant, use);
        if (admitted.outcome !== "admitted") {
          throw new ExactUseAdmissionError(admissionErrorCode(admitted.reason), {
            ...admitted,
            path: "component_only",
          });
        }
        const receiptId = randomUUID();
        const effectReceipt = await recordExactUseReceipt(c, tenant, {
          effectKey: use.effectKey,
          outcome: "applied",
          nativeReceiptRef: { schemaVersion: "knowledge-ingestion-receipt.v1", receiptId },
          processedEpoch: use.processedEpoch,
          useDecisionId: use.useDecisionId,
        });
        const receipt = {
          receiptId,
          outcome: "applied",
          head: { before: 0, after: 1 },
          duplicateOf: null,
          admission: {
            path: "component_only",
            useDecisionId: use.useDecisionId,
            boundEffectDigest: use.boundEffectDigest,
            effectKey: use.effectKey,
            authoritativeEpoch: admitted.authoritativeEpoch,
            effectReceiptDigest: effectReceipt.digest,
          },
        };
        await c.query("insert into public.native_fact (tenant_id, effect_key, receipt) values ($1, $2, $3::jsonb)", [
          tenant,
          use.effectKey,
          JSON.stringify(receipt),
        ]);
        if (options.effectDispatchId !== undefined) {
          await recordEffectCommit(c, tenant, {
            effectKey: use.effectKey,
            dispatchId: options.effectDispatchId,
            nativeRef: { schemaVersion: "knowledge-ingestion-receipt.v1", receiptId },
          });
        }
        return receipt;
      });
    },
  };
}

const AIENGINEER_POSTGRES: BackendConformance = {
  registration: registration("aiengineer-postgres"),
  openDisposable: async () => {
    const installationId = randomUUID();
    // The stand-in domain table (one row per effect key), owned by the database owner like an AIDB table.
    const store = await componentDatabase("ai-engineer", "aiengineer-postgres", installationId, async (owner) => {
      await owner.query(
        "create table public.native_fact (tenant_id uuid not null, effect_key text not null, receipt jsonb not null, primary key (tenant_id, effect_key))",
      );
      await owner.query("grant usage on schema public to knowledge_verification_writer");
      await owner.query("grant select, insert on public.native_fact to knowledge_verification_writer");
    });
    return {
      config: {
        application: "ai-engineer",
        binding: "aiengineer-postgres",
        installationId,
        databaseUrlEnv: DSN_VARIABLE,
      },
      env: { [DSN_VARIABLE]: store.dsn },
      injection: {
        seal: FIXTURE_SEAL_KEYS,
        apply: createIngestionApplyPort(standInIngestion(store.db) as never),
        // OVE-204: the conditional `read_intent` capability is described and served only with an injected read port
        // (describe_honesty creates the backend with and without it). This stand-in answers without the AIDB (the real
        // AIDB port is read-intent-port.test.ts / read-intent.test.ts); read_intent_recorded proves the operation row
        // on the component store.
        readIntent: standInReadIntent(),
      },
      apply: {
        plan: ({ scope, runId, suffix }) => {
          const fact = { schemaVersion: "conformance-native-fact.v1", runId, suffix } as JsonValue;
          return {
            // The plan-level digest over the native bytes and the originating origin (the stand-in recomputes it).
            boundEffectDigest: boundEffectDigest(Buffer.from(canonicalJson(fact), "utf8"), scope.origin),
            targetSchema: "knowledge-ingestion-intent.v1",
            normalizedValues: { parameters: "7000000000" },
            state: fact,
          };
        },
        payload: (plan, exactUse) =>
          ({
            schemaVersion: "knowledge-ingestion-intent.v1",
            context: { tenantId: exactUse.scope.tenant },
            fact: plan.state,
            exactUse: {
              effectKey: exactUse.effectKey,
              boundEffectDigest: plan.boundEffectDigest,
              originatingOrigin: exactUse.scope.origin,
              useDecisionId: exactUse.useDecisionId,
              processedEpoch: exactUse.processedEpoch,
              normalizedValuesDigest: exactUse.normalizedValuesDigest,
            },
          }) as unknown as JsonValue,
        nativeWrites: (scope, effectKey) =>
          count(
            store.db,
            scope,
            "select count(*)::int as n from public.native_fact where tenant_id = $1 and effect_key = $2",
            effectKey,
          ),
        revoke: (scope) => revoke(store.db, scope),
      },
      close: store.drop,
    };
  },
  exceptions: [],
  storeUnavailable: STORE_UNAVAILABLE,
};

// ------------------------------------------------------------------------------------------------ biotech-graph

function frozenOf(revision: unknown): FrozenReportBinding {
  const r = revision as {
    id: string;
    kind: { id: string };
    schemaVersion: string;
    bodyDigest: string;
    ledger: { digest: string };
    structuredBody: { digest: string };
  };
  return {
    reportRevisionId: r.id,
    reportKind: biotechReportKind(r.kind.id),
    reportKindRef: r.kind.id,
    reportSchema: r.schemaVersion,
    bodyDigest: r.bodyDigest,
    ledgerDigest: r.ledger.digest,
    structuredBodyDigest: r.structuredBody.digest,
  };
}

/** A `biotech-knowledge-intent.v2` that publishes the frozen report revision (the shape the BKS consumer applies). */
function biotechIntent(frozen: FrozenReportBinding, runId: string, suffix: string): Record<string, unknown> {
  return {
    schemaVersion: "biotech-knowledge-intent.v2",
    intentId: `conformance-${suffix}`,
    pins: { schemaReleaseDigest: BIOTECH_SCHEMA_RELEASE_V2_2_0, policyVersion: "bks-admission-policy/v1" },
    context: {
      actor: { kind: "agent", id: "ks-backend-conformance", model: "synthetic" },
      run: { system: "ks-verification", runId: `${runId}/${suffix}`, operationId: `op-${suffix}` },
      activityKind: "EVIDENCE_MISSION",
    },
    basis: { creationOnly: { reason: "backend conformance synthetic dispatch" } },
    sources: [],
    subjects: [
      {
        ref: "claim",
        mode: "new",
        nodeType: "Claim",
        name: `Conformance claim ${suffix}`,
        properties: { proposition: `Conformance proposition ${suffix}`, claimType: "RELATIONSHIP" },
        onMatch: "use_existing",
      },
    ],
    proposals: [
      {
        proposalId: "report",
        kind: "report.publish",
        name: `Conformance evidence report ${suffix}`,
        policyVersion: "bks-admission-policy/v1",
        ...reportPublishFields(frozen),
        verdict: "NOT_SUPPORTED",
        about: ["claim"],
      },
    ],
  };
}

const BIOTECH_GRAPH: BackendConformance = {
  registration: registration("biotech-graph"),
  openDisposable: async () => {
    const installationId = randomUUID();
    const store = await componentDatabase("biotech", "biotech-graph", installationId);
    const admission = new BiotechGraphAdmission(store.db, { installationId, applicationId: "biotech" });
    return {
      config: { application: "biotech", binding: "biotech-graph", installationId, databaseUrlEnv: BIOTECH_DSN_VARIABLE },
      env: { [BIOTECH_DSN_VARIABLE]: store.dsn },
      injection: { seal: FIXTURE_SEAL_KEYS },
      apply: {
        plan: ({ scope, runId, revision, suffix }) => {
          const intent = biotechIntent(frozenOf(revision), runId, suffix);
          return {
            boundEffectDigest: biotechEffect(intent, scope.origin).boundEffectDigest,
            targetSchema: "biotech-knowledge-intent.v2",
            normalizedValues: {},
            state: intent as JsonValue,
          };
        },
        payload: (plan, exactUse) => ({
          schemaVersion: "biotech-knowledge-apply.v1",
          intent: plan.state,
          exactUse: {
            useDecisionId: exactUse.useDecisionId,
            processedEpoch: exactUse.processedEpoch,
            normalizedValuesDigest: exactUse.normalizedValuesDigest,
          },
        }),
        // The native write of this binding is the outbox row (the graph write is the BKS consumer's, downstream).
        nativeWrites: (scope, effectKey) =>
          count(
            store.db,
            scope,
            "select count(*)::int as n from knowledge_verification.dispatch_outbox where tenant_id = $1 and effect_key = $2",
            effectKey,
          ),
        revoke: (scope) => revoke(store.db, scope),
        stopDispatch: async (scope, effectKey) => {
          expect(await admission.stopDispatch(scope, effectKey)).toBe(1);
        },
      },
      close: store.drop,
    };
  },
  exceptions: [],
  storeUnavailable: STORE_UNAVAILABLE,
};

describe("the executor composes exactly the registrations it tests", () => {
  it("KNOWLEDGE_BACKENDS lists aiengineer-postgres, biotech-graph and in-memory", () => {
    expect(KNOWLEDGE_BACKENDS.ids()).toEqual(["aiengineer-postgres", "biotech-graph", "in-memory"]);
  });
});

defineBackendConformance({ describe, it, beforeAll, afterAll }, [IN_MEMORY, AIENGINEER_POSTGRES, BIOTECH_GRAPH], {
  kinds: KINDS,
});
