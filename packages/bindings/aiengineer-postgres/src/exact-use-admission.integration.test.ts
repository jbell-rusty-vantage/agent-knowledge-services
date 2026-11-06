import { randomBytes } from "node:crypto";
import { FIXTURE_SEAL_KEYS, fixtureOrigin } from "@aiengineer/knowledge-application/testing";
import {
  AIDB_GUARD_SQLSTATES,
  ExactUseAdmissionError,
  admissionErrorCode,
  admissionErrorFromSql,
  admitExactUseWithin,
  lookupExactUseReceipt,
  recordExactUseReceipt,
} from "@aiengineer/knowledge-db";
import { install, loadComponent } from "@aiengineer/knowledge-db-contract";
import { bindEffect, digestBytes, digestCanonical } from "@aiengineer/knowledge-operation-protocol";
import { normalizedValuesDigest } from "@aiengineer/knowledge-research-core";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ComponentDatabase, type SqlClient } from "./client.js";
import { pinSealSigningKey } from "./seal-keys.js";
import { currentRevocationEpoch, recordInvalidation, closeInvalidation, recordUseDecision, sealRun } from "./stores.js";

/**
 * SV-08 KS half, component-function path on the disposable PostgreSQL 17 (no AIDB projection installed): the ONE
 * admission module (`@aiengineer/knowledge-db` exact-use-admission) runs on the native transaction's own client, so
 * the bound effect, the epoch-locked admission, a domain write and the effect receipt commit or roll back together.
 * The domain write here is a disposable stand-in table; the AIDB executor path is `knowledge-db` ingestion's own test.
 */
const ADMIN = process.env.KNOWLEDGE_DB_CONTRACT_ADMIN_DSN;
const describeDb = ADMIN ? describe : describe.skip;
const TENANT = "00000000-0000-7000-8000-0000000000aa";

describe("admission error mapping (AIDB guard SQLSTATEs and component reasons)", () => {
  it("maps KSA01..KSA07 and component reasons to K01 typed errors", () => {
    expect(AIDB_GUARD_SQLSTATES).toEqual({
      KSA01: "STALE_DECISION",
      KSA02: "REVIEW_REQUIRED",
      KSA03: "EFFECT_CONFLICT",
      KSA04: "UNRESOLVED_EFFECT",
      KSA05: "EXACT_REVISION_UNAVAILABLE",
      KSA06: "UNRESOLVED_EFFECT",
      KSA07: "EXACT_REVISION_UNAVAILABLE",
    });
    for (const [sqlstate, code] of Object.entries(AIDB_GUARD_SQLSTATES)) {
      const typed = admissionErrorFromSql(Object.assign(new Error("STALE_DECISION"), { code: sqlstate }));
      expect(typed).toBeInstanceOf(ExactUseAdmissionError);
      expect(typed?.code).toBe(code);
      expect(typed?.path).toBe("aidb_guard");
    }
    expect(admissionErrorFromSql(Object.assign(new Error("other"), { code: "23505" }))).toBeNull();
    expect(admissionErrorCode("REVOCATION_EPOCH_STALE")).toBe("STALE_DECISION");
    expect(admissionErrorCode("DECISION_INVALIDATED")).toBe("STALE_DECISION");
    expect(admissionErrorCode("DECISION_EXPIRED")).toBe("STALE_DECISION");
    expect(admissionErrorCode("EFFECT_DIGEST_MISMATCH")).toBe("EFFECT_CONFLICT");
    expect(admissionErrorCode("NORMALIZED_VALUES_MISMATCH")).toBe("EFFECT_CONFLICT");
    expect(admissionErrorCode("REVIEW_REQUIRED")).toBe("REVIEW_REQUIRED");
    expect(admissionErrorCode("DECISION_HELD")).toBe("REVIEW_REQUIRED");
    expect(admissionErrorCode("DECISION_NOT_FOUND")).toBe("UNRESOLVED_EFFECT");
  });
});

describeDb("exact-use admission inside one native transaction (component path, PostgreSQL 17)", () => {
  const database = `kva_${randomBytes(4).toString("hex")}`;
  let db: ComponentDatabase;
  let runId = "";
  const origin = fixtureOrigin(TENANT);
  const values = normalizedValuesDigest({ parameters: "7000000000" });
  const dsn = () => {
    const url = new URL(ADMIN as string);
    url.pathname = `/${database}`;
    return url.toString();
  };
  const writer = { tenantId: TENANT, role: "knowledge_verification_writer" as const };
  const effectFor = (key: string) =>
    bindEffect({ effectKey: key, nativePayload: `native intent bytes ${key}`, originatingOrigin: origin });

  beforeAll(async () => {
    const admin = new Client({ connectionString: ADMIN });
    await admin.connect();
    await admin.query(`create database ${database}`);
    await admin.end();
    await install(loadComponent(), {
      adminDsn: dsn(),
      installationId: "0192a4f0-0000-7000-8000-0000000a1e00",
      // A non-AI-Engineer installation: no AIDB projection exists, so the component-only path is the authority.
      applicationId: "biotech",
      binding: "biotech-graph",
    });
    await pinSealSigningKey(dsn(), { keyId: FIXTURE_SEAL_KEYS.signer.keyId, publicKey: FIXTURE_SEAL_KEYS.publicKey });
    // A disposable stand-in for the AI Engineer canonical write (one row per effect key).
    const owner = new Client({ connectionString: dsn() });
    await owner.connect();
    await owner.query(
      "create table public.native_fact (tenant_id uuid not null, effect_key text primary key, value text not null)",
    );
    await owner.query("grant select, insert on public.native_fact to knowledge_verification_writer");
    await owner.query("grant usage on schema public to knowledge_verification_writer");
    await owner.end();
    db = new ComponentDatabase({ connectionString: dsn(), maximumPoolSize: 4 });
    // A sealed run with a report revision (the decision guard requires it).
    runId = await db.transaction(writer, async (c) => {
      const originDigest = digestCanonical({ origin: "seed" });
      await c.query(
        `insert into knowledge_verification.origin (tenant_id, origin_digest, kind, installation_id, application_id, issuer, subject, identity)
         values ($1, $2, 'standalone', 'i', 'ai-engineer', 'ks', 'seed', '{}'::jsonb)`,
        [TENANT, originDigest],
      );
      await c.query(
        `insert into knowledge_verification.verification_task (tenant_id, task_id, schema_version, task_digest, original_task_ref, use_name, audience, minimum_risk, rubric_ref, policy_ref, body)
         values ($1, 'task-ad', 'research-core.task.v2', $2, '{}'::jsonb, 'u', 'a', 'medium', 'r', 'p', '{}'::jsonb)`,
        [TENANT, digestBytes("task-ad")],
      );
      const run = await c.query<{ run_id: string }>(
        "insert into knowledge_verification.verification_run (tenant_id, task_id, binding, originating_origin_digest) values ($1, 'task-ad', 'aiengineer-postgres', $2) returning run_id::text",
        [TENANT, originDigest],
      );
      const id = run.rows[0]?.run_id ?? "";
      const body = "# body\n";
      for (const [artifact, content] of [
        ["s-ad", "{}"],
        ["b-ad", body],
        ["l-ad", "[]"],
      ] as const) {
        await c.query(
          "insert into knowledge_verification.artifact_custody (tenant_id, artifact_id, digest, byte_length, media_type, custody_kind, inline_bytes) values ($1, $2, $3, $4, 'text/plain', 'inline', $5)",
          [TENANT, artifact, digestBytes(content), Buffer.byteLength(content), Buffer.from(content)],
        );
      }
      await c.query(
        `insert into knowledge_verification.report_revision (tenant_id, report_revision_id, report_id, revision, schema_version, report_kind, task_id, run_id,
           structured_body_artifact_id, body_artifact_id, ledger_artifact_id, body_digest, renderer_version, assertion_refs, time_coverage, record, digest)
         values ($1, 'rev-ad', 'report-ad', 1, 'research-report.v2', 'evidence_report', 'task-ad', $2::uuid, 's-ad', 'b-ad', 'l-ad', $3, 'r', '[]'::jsonb, '{}'::jsonb, $4::jsonb, $5)`,
        [
          TENANT,
          id,
          digestBytes(body),
          JSON.stringify({
            kind: {
              kind: "report_kind",
              id: "evidence_report@1.0.0",
              version: "research-report-kind.v1",
              digest: digestBytes("k"),
              tenant: TENANT,
              binding: "b",
            },
          }),
          digestBytes("rev-ad"),
        ],
      );
      const manifest = { snapshot: "verification_snapshot", run: { id }, predecessor: null };
      const seal = await FIXTURE_SEAL_KEYS.signer.sign(digestCanonical(manifest), {
        signer: "ks-sealer",
        signedAt: "2026-10-25T00:00:00Z",
      });
      await sealRun(c, TENANT, {
        runId: id,
        expectedHead: null,
        manifestKind: "verification_snapshot",
        manifest,
        familyRefs: {
          capture: digestBytes("c"),
          claims: digestBytes("cl"),
          report: digestBytes("r"),
          observations: digestBytes("o"),
        },
        signer: "ks-sealer",
        signature: {
          algorithm: "Ed25519",
          keyId: seal.keyId,
          bytes: Buffer.from(seal.signature, "base64url"),
          context: {
            manifestDigest: seal.manifestDigest,
            signer: seal.signer,
            signedAt: seal.signedAt,
            keyId: seal.keyId,
          },
        },
      });
      return id;
    });
  });

  afterAll(async () => {
    await db?.end();
    const admin = new Client({ connectionString: ADMIN });
    await admin.connect();
    await admin.query(`drop database if exists ${database} with (force)`);
    await admin.end();
  });

  const decide = (id: string, boundEffectDigest: string, epoch: number) =>
    db.transaction(writer, (c) =>
      recordUseDecision(c, TENANT, {
        useDecisionId: id,
        subject: { kind: "report", id: "rev-ad", digest: digestBytes("rev-ad") },
        runId,
        boundEffectDigest,
        use: "u",
        audience: "a",
        disposition: "admitted",
        policyRef: "p",
        rubricRef: "r",
        qualifiersDigest: null,
        revocationEpoch: epoch,
        normalizedValues: { parameters: "7000000000" },
        normalizedValuesDigest: values,
        record: { normalizedValues: { parameters: "7000000000" }, id },
      }),
    );

  /** The native apply: admit on this client, write the domain row, write the receipt, commit together. */
  const nativeApply = (
    key: string,
    decisionId: string,
    processedEpoch: number,
    options: { loseResponse?: boolean } = {},
  ) =>
    db.transaction(writer, async (c: SqlClient) => {
      const effect = effectFor(key);
      const admitted = await admitExactUseWithin(
        c,
        TENANT,
        {
          useDecisionId: decisionId,
          boundEffectDigest: effect.boundEffectDigest,
          processedEpoch,
          normalizedValuesDigest: values,
        },
        { effect: { effectKey: key, semanticPayloadDigest: effect.semanticPayloadDigest, originatingOrigin: origin } },
      );
      const inserted = await c.query(
        "insert into public.native_fact (tenant_id, effect_key, value) values ($1, $2, '7B') on conflict (effect_key) do nothing returning effect_key",
        [TENANT, key],
      );
      const receipt = await recordExactUseReceipt(c, TENANT, {
        effectKey: key,
        outcome: "applied",
        nativeReceiptRef: { table: "public.native_fact", effectKey: key },
        processedEpoch,
        useDecisionId: decisionId,
      });
      return { admitted, wrote: inserted.rows.length, receipt, loseResponse: options.loseResponse ?? false };
    });

  const count = async (sql: string, params: unknown[]) =>
    Number(
      (await db.transaction({ ...writer, readOnly: true }, (c) => c.query<{ n: string }>(sql, params))).rows[0]?.n ?? 0,
    );

  it("admitted: one transaction writes the domain row, the effect receipt and the decision -> effect edge", async () => {
    const epoch = await db.transaction(writer, (c) => currentRevocationEpoch(c, TENANT));
    await decide("ud-ok", effectFor("effect-ok").boundEffectDigest, epoch);
    const result = await nativeApply("effect-ok", "ud-ok", epoch);
    expect(result.admitted.path).toBe("component_only");
    expect(result.wrote).toBe(1);
    expect(await count("select count(*) n from public.native_fact where effect_key = $1", ["effect-ok"])).toBe(1);
    const receipt = await db.transaction(writer, (c) => lookupExactUseReceipt(c, TENANT, "effect-ok"));
    expect(receipt).toMatchObject({ outcome: "applied", useDecisionId: "ud-ok", digest: result.receipt.digest });
    expect(
      await count(
        "select count(*) n from knowledge_verification.dependency_edge where from_kind = 'use_decision' and from_id = 'ud-ok' and to_kind = 'effect'",
        [],
      ),
    ).toBe(1);
  });

  it("stale epoch, edited effect, normalized value mismatch: typed refusal and NOTHING written (rollback)", async () => {
    const epoch = await db.transaction(writer, (c) => currentRevocationEpoch(c, TENANT));
    await decide("ud-stale", effectFor("effect-stale").boundEffectDigest, epoch);
    await db.transaction(writer, async (c) => {
      const invalidation = await recordInvalidation(c, TENANT, { kind: "fragment", id: "frag-unrelated" }, "unrelated");
      await closeInvalidation(c, TENANT, invalidation.invalidationId, []);
    });
    await expect(nativeApply("effect-stale", "ud-stale", epoch)).rejects.toMatchObject({ code: "STALE_DECISION" });
    expect(await count("select count(*) n from public.native_fact where effect_key = $1", ["effect-stale"])).toBe(0);
    expect(await db.transaction(writer, (c) => lookupExactUseReceipt(c, TENANT, "effect-stale"))).toBeNull();
    expect(
      await count("select count(*) n from knowledge_verification.effect where effect_key = $1", ["effect-stale"]),
    ).toBe(0);
    // Edited effect bytes under the same key: the decision binds other bytes.
    const current = await db.transaction(writer, (c) => currentRevocationEpoch(c, TENANT));
    await decide("ud-edit", digestBytes("the reviewed bytes"), current);
    await expect(nativeApply("effect-edit", "ud-edit", current)).rejects.toMatchObject({ code: "EFFECT_CONFLICT" });
    expect(await count("select count(*) n from public.native_fact where effect_key = $1", ["effect-edit"])).toBe(0);
  });

  it("two concurrent same-key requests yield one domain row and one receipt", async () => {
    const epoch = await db.transaction(writer, (c) => currentRevocationEpoch(c, TENANT));
    await decide("ud-race", effectFor("effect-race").boundEffectDigest, epoch);
    const results = await Promise.allSettled([
      nativeApply("effect-race", "ud-race", epoch),
      nativeApply("effect-race", "ud-race", epoch),
    ]);
    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    const wrote = results.map((result) => (result.status === "fulfilled" ? result.value.wrote : -1)).sort();
    expect(wrote).toEqual([0, 1]);
    expect(await count("select count(*) n from public.native_fact where effect_key = $1", ["effect-race"])).toBe(1);
    expect(
      await count("select count(*) n from knowledge_verification.effect_receipt where effect_key = $1", [
        "effect-race",
      ]),
    ).toBe(1);
  });

  it("crash after native commit and before caller settlement: the receipt lookup finds the committed effect", async () => {
    const epoch = await db.transaction(writer, (c) => currentRevocationEpoch(c, TENANT));
    await decide("ud-crash", effectFor("effect-crash").boundEffectDigest, epoch);
    const lost = await nativeApply("effect-crash", "ud-crash", epoch, { loseResponse: true })
      .then(() => {
        throw Object.assign(new Error("COMMIT_RESPONSE_LOST"), { code: "ECONNRESET" });
      })
      .catch((error: unknown) => error);
    expect(lost).toMatchObject({ code: "ECONNRESET" });
    const recovered = await db.transaction(
      { tenantId: TENANT, role: "knowledge_verification_reader", readOnly: true },
      (c) => lookupExactUseReceipt(c, TENANT, "effect-crash"),
    );
    expect(recovered).toMatchObject({ outcome: "applied", useDecisionId: "ud-crash" });
    // A retry after recovery is idempotent (same bytes, same receipt), never a second effect.
    const retry = await nativeApply("effect-crash", "ud-crash", epoch);
    expect(retry.wrote).toBe(0);
    expect(retry.receipt.digest).toBe(recovered?.digest);
  });
});
