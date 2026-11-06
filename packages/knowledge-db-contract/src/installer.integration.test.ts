import { randomBytes, createHash } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadComponent } from "./component.js";
import { InstallRefused, inspect, install } from "./installer.js";

/**
 * Two disposable app-local installs (ai-engineer, biotech) plus the component's seam proofs. Needs a loopback
 * PostgreSQL 17 administrator DSN in `KNOWLEDGE_DB_CONTRACT_ADMIN_DSN`; skips (never fakes) without it.
 */
const ADMIN = process.env.KNOWLEDGE_DB_CONTRACT_ADMIN_DSN;
const describeDb = ADMIN ? describe : describe.skip;

const TENANT_A = "00000000-0000-7000-8000-0000000000aa";
const TENANT_B = "00000000-0000-7000-8000-0000000000bb";
const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const suffix = randomBytes(4).toString("hex");

function databaseDsn(admin: string, database: string): string {
  const url = new URL(admin);
  if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) throw new Error("LOOPBACK_REQUIRED");
  url.pathname = `/${database}`;
  return url.toString();
}

async function admin<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: ADMIN });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** A tenant-scoped transaction as one capability role (admin can SET ROLE to any NOLOGIN role). */
async function asRole<T>(
  dsn: string,
  role: string,
  tenant: string | null,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString: dsn });
  await client.connect();
  try {
    await client.query("begin");
    if (tenant) await client.query("select set_config('app.tenant_id', $1, true)", [tenant]);
    await client.query(`set local role ${role}`);
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

/** Expect a statement to fail inside an open transaction without aborting it (savepoint + rollback to it). */
async function failing(client: Client, run: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  await client.query("savepoint expected_failure");
  let message = "";
  try {
    await run();
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  await client.query("rollback to savepoint expected_failure");
  expect(message).toMatch(pattern);
}

async function seedRun(client: Client, tenant: string, runSuffix: string) {
  const originDigest = digest(`origin-${runSuffix}`);
  await client.query(
    `insert into knowledge_verification.origin (tenant_id, origin_digest, kind, installation_id, application_id, issuer, subject,
       mission_id, mission_run_id, activation_id, operation_id, operation_attempt, execution_generation, lane, identity)
     values ($1, $2, 'mission_invocation', 'inst-1', 'ai-engineer', 'mission-control', 'runtime', 'm-1', 'r-1', null, 'op-1', 1, 1, 'deep_agents', '{}'::jsonb)
     on conflict do nothing`,
    [tenant, originDigest],
  );
  const taskId = `task-${runSuffix}`;
  await client.query(
    `insert into knowledge_verification.verification_task (tenant_id, task_id, schema_version, task_digest, original_task_ref, use_name, audience, minimum_risk, rubric_ref, policy_ref, body)
     values ($1, $2, 'research-core.task.v2', $3, '{}'::jsonb, 'internal_research', 'engineer', 'medium', 'rubric.v2', 'policy.v2', '{}'::jsonb)`,
    [tenant, taskId, digest(`task-${runSuffix}`)],
  );
  const run = await client.query<{ run_id: string }>(
    `insert into knowledge_verification.verification_run (tenant_id, task_id, binding, originating_origin_digest, mission_id, mission_run_id, operation_id, operation_attempt, execution_generation)
     values ($1, $2, 'aiengineer-postgres', $3, 'm-1', 'r-1', 'op-1', 1, 1) returning run_id::text`,
    [tenant, taskId, originDigest],
  );
  const runId = run.rows[0]?.run_id ?? "";
  const body = `# Report ${runSuffix}\n`;
  const bodyDigest = digest(body);
  for (const [artifactId, content] of [
    [`structured-${runSuffix}`, `{"sections":[],"run":"${runSuffix}"}`],
    [`body-${runSuffix}`, body],
    [`ledger-${runSuffix}`, `{"occurrences":[],"run":"${runSuffix}"}`],
  ] as const) {
    await client.query(
      `insert into knowledge_verification.artifact_custody (tenant_id, artifact_id, digest, byte_length, media_type, custody_kind, inline_bytes)
       values ($1, $2, $3, $4, 'text/plain', 'inline', $5)`,
      [tenant, artifactId, digest(content), Buffer.byteLength(content), Buffer.from(content)],
    );
  }
  await client.query(
    `insert into knowledge_verification.report_revision (tenant_id, report_revision_id, report_id, revision, schema_version, report_kind, task_id, run_id,
       structured_body_artifact_id, body_artifact_id, ledger_artifact_id, body_digest, renderer_version, assertion_refs, time_coverage, record, digest)
     values ($1, $2, $3, 1, 'research-report.v2', 'evidence_report', $4, $5::uuid, $6, $7, $8, $9, 'research-report-renderer.v2', '[]'::jsonb, '{}'::jsonb, $11::jsonb, $10)`,
    [
      tenant,
      `rev-${runSuffix}`,
      `report-${runSuffix}`,
      taskId,
      runId,
      `structured-${runSuffix}`,
      `body-${runSuffix}`,
      `ledger-${runSuffix}`,
      bodyDigest,
      digest(`rev-${runSuffix}`),
      JSON.stringify({ kind: KIND_REF }),
    ],
  );
  return { runId, originDigest, taskId, bodyDigest };
}

/** The pinned report kind every revision binds since 2.1.0 (0004 derives the kind columns from record.kind). */
const KIND_REF = {
  kind: "report_kind",
  id: "evidence_report@1.0.0",
  version: "research-report-kind.v1",
  digest: digest("evidence_report@1.0.0"),
  tenant: TENANT_A,
  binding: "aiengineer-postgres",
};

const families = {
  capture: digest("capture"),
  claims: digest("claims"),
  report: digest("report"),
  observations: digest("observations"),
};

/** 2.2.0: seals name a pinned key; the SQL checks registration/status/length (Ed25519 itself is verified in TS). */
const KEY_ID = "ks-installer-test-key";
async function pinKey(dsn: string): Promise<void> {
  const client = new Client({ connectionString: dsn });
  await client.connect();
  try {
    await client.query(
      "insert into knowledge_verification.seal_signing_key (key_id, algorithm, public_key, issuer) values ($1, 'Ed25519', $2, 'knowledge-services') on conflict do nothing",
      [KEY_ID, randomBytes(32)],
    );
  } finally {
    await client.end();
  }
}

/** seal_run (2.2.0) with a manifest that names its run, kind and predecessor, and a 64-byte detached signature. */
function sealCall(
  client: Client,
  tenant: string,
  input: {
    runId: string;
    expectedHead: string | null;
    kind?: string;
    body?: Record<string, unknown>;
    bodyDigest?: string;
    refs?: Record<string, string>;
    keyId?: string;
    signature?: Buffer;
  },
) {
  const kind = input.kind ?? "verification_snapshot";
  const body = input.body ?? {
    snapshot: kind,
    run: { id: input.runId },
    predecessor: input.expectedHead === null ? null : { digest: input.expectedHead },
  };
  const bodyDigest = input.bodyDigest ?? digest(JSON.stringify(body));
  const keyId = input.keyId ?? KEY_ID;
  return client.query<{ sequence: number; manifest_digest: string; predecessor_digest: string | null }>(
    "select sequence, manifest_digest, predecessor_digest from knowledge_verification.seal_run($1, $2::uuid, $3, $4, $5::jsonb, $6, $7::jsonb, 'ks-sealer', 'Ed25519', $8, $9, $10::jsonb)",
    [
      tenant,
      input.runId,
      input.expectedHead,
      kind,
      JSON.stringify(body),
      bodyDigest,
      JSON.stringify(input.refs ?? families),
      keyId,
      input.signature ?? randomBytes(64),
      JSON.stringify({ manifestDigest: bodyDigest, signer: "ks-sealer", signedAt: "2026-10-25T00:00:00Z", keyId }),
    ],
  );
}

/** A use decision row (2.2.0 shape: normalized values + digest; report subjects bind no qualifiers digest). */
function decisionCall(
  client: Client,
  tenant: string,
  input: {
    id: string;
    runId: string;
    effect: string;
    epoch?: number;
    adjudication?: string | null;
    supersedes?: string | null;
    conditions?: string[];
    disposition?: string;
    values?: Record<string, string>;
    subjectDigest?: string;
    reportId?: string;
  },
) {
  const values = input.values ?? { parameters: "7000000000" };
  return client.query(
    `insert into knowledge_verification.use_decision (tenant_id, use_decision_id, schema_version, subject_kind, subject_id, subject_digest, run_id, bound_effect_digest, use_name, audience, disposition, conditions, policy_ref, rubric_ref, qualifiers_digest, revocation_epoch, reviewer_adjudication_id, supersedes_use_decision_id, record, digest, normalized_values, normalized_values_digest)
     values ($1, $2, 'research-core.use_decision.v2', 'report', 'rev-admit', $3, $4::uuid, $5, 'knowledge_ingestion.fact_assert_state', 'official', $6, $7::jsonb, 'policy.v2', 'rubric.v2', null, $8, $9, $10, $11::jsonb, $12, $13::jsonb, $14)`,
    [
      tenant,
      input.id,
      input.subjectDigest ?? digest("rev-admit"),
      input.runId,
      input.effect,
      input.disposition ?? "admitted",
      JSON.stringify(input.conditions ?? []),
      input.epoch ?? 0,
      input.adjudication ?? null,
      input.supersedes ?? null,
      JSON.stringify({ normalizedValues: values, report: { id: input.reportId ?? "rev-admit" } }),
      digest(input.id),
      JSON.stringify(values),
      digest(JSON.stringify(values)),
    ],
  );
}

describeDb("knowledge_verification component on disposable PostgreSQL 17", () => {
  const component = loadComponent();
  const databases = {
    "ai-engineer": `kvc_ai_engineer_${suffix}`,
    biotech: `kvc_biotech_${suffix}`,
  } as const;
  const dsn = (app: keyof typeof databases) => databaseDsn(ADMIN as string, databases[app]);

  beforeAll(async () => {
    await admin(async (client) => {
      for (const name of Object.values(databases)) await client.query(`create database ${name}`);
    });
  });

  afterAll(async () => {
    await admin(async (client) => {
      for (const name of Object.values(databases)) await client.query(`drop database if exists ${name} with (force)`);
    });
  });

  it("installs fresh into two application databases, idempotently, and refuses a foreign installation", async () => {
    const first = await install(component, {
      adminDsn: dsn("ai-engineer"),
      installationId: "0192a4f0-0000-7000-8000-0000000a1e00",
      applicationId: "ai-engineer",
      binding: "aiengineer-postgres",
    });
    expect(first.applied).toEqual(component.migrations.map((m) => m.key));
    const again = await install(component, {
      adminDsn: dsn("ai-engineer"),
      installationId: "0192a4f0-0000-7000-8000-0000000a1e00",
      applicationId: "ai-engineer",
      binding: "aiengineer-postgres",
    });
    expect(again.applied).toEqual([]);
    expect(again.skipped).toHaveLength(component.migrations.length);
    await expect(
      install(component, {
        adminDsn: dsn("ai-engineer"),
        installationId: "0192a4f0-0000-7000-8000-00000000b10e",
        applicationId: "biotech",
        binding: "biotech-graph",
      }),
    ).rejects.toMatchObject({ code: "INSTALLATION_MISMATCH" });
    const biotech = await install(component, {
      adminDsn: dsn("biotech"),
      installationId: "0192a4f0-0000-7000-8000-00000000b10e",
      applicationId: "biotech",
      binding: "biotech-graph",
    });
    expect(biotech.applied).toHaveLength(component.migrations.length);
    const inspection = await inspect(component, dsn("biotech"));
    expect(inspection.complete).toBe(true);
    expect(inspection.installation?.application_id).toBe("biotech");
  });

  it("upgrades 2.0.0 by 0004..0007, 2.1.0 by 0005..0007 and 2.2.0 by 0006..0007, as new receipts", async () => {
    const legacy = `kvc_upgrade_${suffix}`;
    await admin((client) => client.query(`create database ${legacy}`));
    try {
      const target = {
        adminDsn: databaseDsn(ADMIN as string, legacy),
        installationId: "0192a4f0-0000-7000-8000-0000000a1e00",
        applicationId: "ai-engineer",
        binding: "aiengineer-postgres",
      };
      const v200 = { ...component, migrations: component.migrations.slice(0, 3) };
      expect((await install(v200, target)).applied).toHaveLength(3);
      const upgraded = await install(component, target);
      expect(upgraded.applied).toEqual([
        "0004_operations",
        "0005_signatures_review_and_outbox",
        "0006_credential_use_and_protocol_receipts",
        "0007_server_clock_and_required_values_digest",
        "0008_effect_dispatch_journal",
      ]);
      expect(upgraded.skipped).toHaveLength(3);
      expect(upgraded.componentVersion).toBe("2.5.0");
      expect((await install(component, target)).applied).toEqual([]);
      expect((await inspect(component, target.adminDsn)).complete).toBe(true);
    } finally {
      await admin((client) => client.query(`drop database if exists ${legacy} with (force)`));
    }
    const v210db = `kvc_upgrade210_${suffix}`;
    await admin((client) => client.query(`create database ${v210db}`));
    try {
      const target = {
        adminDsn: databaseDsn(ADMIN as string, v210db),
        installationId: "0192a4f0-0000-7000-8000-0000000a1e00",
        applicationId: "ai-engineer",
        binding: "aiengineer-postgres",
      };
      expect(
        (await install({ ...component, migrations: component.migrations.slice(0, 4) }, target)).applied,
      ).toHaveLength(4);
      expect((await install(component, target)).applied).toEqual([
        "0005_signatures_review_and_outbox",
        "0006_credential_use_and_protocol_receipts",
        "0007_server_clock_and_required_values_digest",
        "0008_effect_dispatch_journal",
      ]);
    } finally {
      await admin((client) => client.query(`drop database if exists ${v210db} with (force)`));
    }
    const v220db = `kvc_upgrade220_${suffix}`;
    await admin((client) => client.query(`create database ${v220db}`));
    try {
      const target = {
        adminDsn: databaseDsn(ADMIN as string, v220db),
        installationId: "0192a4f0-0000-7000-8000-0000000a1e00",
        applicationId: "ai-engineer",
        binding: "aiengineer-postgres",
      };
      const v220 = { ...component, migrations: component.migrations.slice(0, 5) };
      expect((await install(v220, target)).applied).toHaveLength(5);
      // A 2.2.0 row survives the upgrade untouched (receipts written before 0006 stay readable).
      await asRole(target.adminDsn, "knowledge_verification_writer", TENANT_A, async (c) => {
        const seeded = await seedRun(c, TENANT_A, "pre230");
        await c.query("select knowledge_verification.bind_effect($1, 'effect-pre230', $2, $3, $4)", [
          TENANT_A,
          digest("p"),
          seeded.originDigest,
          digest("b"),
        ]);
      });
      const upgraded = await install(component, target);
      expect(upgraded.applied).toEqual([
        "0006_credential_use_and_protocol_receipts",
        "0007_server_clock_and_required_values_digest",
        "0008_effect_dispatch_journal",
      ]);
      expect(upgraded.componentVersion).toBe("2.5.0");
      expect((await inspect(component, target.adminDsn)).complete).toBe(true);
      const kept = await asRole(target.adminDsn, "knowledge_verification_reader", TENANT_A, (c) =>
        c.query("select effect_key from knowledge_verification.effect where effect_key = 'effect-pre230'"),
      );
      expect(kept.rows).toHaveLength(1);
    } finally {
      await admin((client) => client.query(`drop database if exists ${v220db} with (force)`));
    }
  });

  it("2.4.0: credentials are single use durably (jti and dispatch id) at the server clock; purge removes only expired rows", async () => {
    // F15: the caller supplies no time. The 2.3.0 six-argument shape still resolves and ignores the time it passes.
    const consume = (c: Client, jti: string, dispatchId: string, expires: Date, tenant = TENANT_A) =>
      c
        .query<{ outcome: string }>(
          "select knowledge_verification.consume_credential($1, 'mission-control', $2, $3, $4) as outcome",
          [tenant, jti, dispatchId, expires],
        )
        .then((result) => result.rows[0]?.outcome);
    const legacyConsume = (c: Client, jti: string, dispatchId: string, expires: Date, callerNow: Date) =>
      c
        .query<{ outcome: string }>(
          "select knowledge_verification.consume_credential($1, 'mission-control', $2, $3, $4, $5) as outcome",
          [TENANT_A, jti, dispatchId, expires, callerNow],
        )
        .then((result) => result.rows[0]?.outcome);
    const expires = new Date(Date.now() + 10 * 60_000);
    const past = new Date(Date.now() - 60_000);
    await asRole(dsn("ai-engineer"), "knowledge_verification_writer", TENANT_A, async (c) => {
      expect(await consume(c, "jti-1", "dispatch-1", expires)).toBe("consumed");
      expect(await consume(c, "jti-1", "dispatch-1", expires)).toBe("replay");
      expect(await consume(c, "jti-1", "dispatch-2", expires)).toBe("replay");
      expect(await consume(c, "jti-2", "dispatch-1", expires)).toBe("dispatch_reused");
      expect(await consume(c, "jti-3", "dispatch-3", past)).toBe("expired");
      // A caller clock set far in the past cannot revive an expired credential, nor one set in the future expire a
      // live one: the legacy shape ignores it.
      expect(await legacyConsume(c, "jti-5", "dispatch-5", past, new Date("2000-01-01T00:00:00Z"))).toBe("expired");
      expect(await legacyConsume(c, "jti-6", "dispatch-6", expires, new Date("2099-01-01T00:00:00Z"))).toBe("consumed");
      const consumedAt = await c.query<{ skew: number }>(
        "select abs(extract(epoch from consumed_at - now()))::float8 as skew from knowledge_verification.credential_use where jti = 'jti-6'",
      );
      expect(consumedAt.rows[0]?.skew).toBeLessThan(60);
      await failing(c, () => consume(c, "jti-x", "dispatch-x", expires, TENANT_B), /TENANT/i);
    });
    // A row whose expiry has passed (written by the owner here; consume never inserts one).
    {
      const owner = new Client({ connectionString: dsn("ai-engineer") });
      await owner.connect();
      try {
        await owner.query(
          "insert into knowledge_verification.credential_use (tenant_id, issuer, jti, dispatch_id, expires_at, consumed_at) values ($1, 'mission-control', 'jti-old', 'dispatch-old', now() - interval '1 minute', now() - interval '10 minutes')",
          [TENANT_A],
        );
      } finally {
        await owner.end();
      }
    }
    // Another session (an executor restart) still sees the replay; purge removes only rows past their expiry, and a
    // caller clock in the future (legacy shape) cannot purge unexpired nonces.
    await asRole(dsn("ai-engineer"), "knowledge_verification_writer", TENANT_A, async (c) => {
      expect(await consume(c, "jti-1", "dispatch-9", expires)).toBe("replay");
      const legacyPurge = await c.query<{ n: number }>(
        "select knowledge_verification.purge_credential_use($1, $2) as n",
        [TENANT_A, new Date("2099-01-01T00:00:00Z")],
      );
      expect(legacyPurge.rows[0]?.n).toBe(1);
      const purged = await c.query<{ n: number }>("select knowledge_verification.purge_credential_use($1) as n", [
        TENANT_A,
      ]);
      expect(purged.rows[0]?.n).toBe(0);
      expect(await consume(c, "jti-1", "dispatch-9", expires)).toBe("replay");
      expect(await consume(c, "jti-6", "dispatch-9", expires)).toBe("replay");
      await failing(
        c,
        () =>
          c.query(
            "insert into knowledge_verification.credential_use (tenant_id, issuer, jti, dispatch_id, expires_at) values ($1, 'x', 'j', 'd', now())",
            [TENANT_A],
          ),
        /permission denied/,
      );
    });
    // Concurrent consumers of one jti: exactly one sees `consumed`.
    const racers = await Promise.all(
      [1, 2, 3].map((n) =>
        asRole(dsn("ai-engineer"), "knowledge_verification_writer", TENANT_A, (c) =>
          consume(c, "jti-race", `dispatch-race-${n}`, expires),
        ),
      ),
    );
    expect(racers.filter((outcome) => outcome === "consumed")).toHaveLength(1);
    expect(racers.filter((outcome) => outcome === "replay")).toHaveLength(2);
    const other = await asRole(dsn("ai-engineer"), "knowledge_verification_reader", TENANT_B, (c) =>
      c.query<{ n: number }>("select count(*)::int as n from knowledge_verification.credential_use"),
    );
    expect(other.rows[0]?.n).toBe(0);
  });

  it("upgrades 2.3.0 by 0007 only: server clock, required values digest, 2.3.0 rows and call shapes kept", async () => {
    const v230db = `kvc_upgrade230_${suffix}`;
    await admin((client) => client.query(`create database ${v230db}`));
    try {
      const target = {
        adminDsn: databaseDsn(ADMIN as string, v230db),
        installationId: "0192a4f0-0000-7000-8000-0000000a1e00",
        applicationId: "ai-engineer",
        binding: "aiengineer-postgres",
      };
      const v230 = { ...component, migrations: component.migrations.slice(0, 6) };
      expect((await install(v230, target)).applied).toHaveLength(6);
      const expires = new Date(Date.now() + 10 * 60_000);
      // Under 2.3.0 a writer's clock decides: a credential "consumed" in 2000 and purged as if it were 2099.
      await asRole(target.adminDsn, "knowledge_verification_writer", TENANT_A, async (c) => {
        const outcome = await c.query<{ outcome: string }>(
          "select knowledge_verification.consume_credential($1, 'mission-control', 'jti-230', 'dispatch-230', $2, $3) as outcome",
          [TENANT_A, expires, new Date("2000-01-01T00:00:00Z")],
        );
        expect(outcome.rows[0]?.outcome).toBe("consumed");
      });
      const upgraded = await install(component, target);
      expect(upgraded.applied).toEqual([
        "0007_server_clock_and_required_values_digest",
        "0008_effect_dispatch_journal",
      ]);
      expect(upgraded.skipped).toHaveLength(6);
      expect(upgraded.componentVersion).toBe("2.5.0");
      expect((await install(component, target)).applied).toEqual([]);
      expect((await inspect(component, target.adminDsn)).complete).toBe(true);
      await pinKey(target.adminDsn);
      await asRole(target.adminDsn, "knowledge_verification_writer", TENANT_A, async (c) => {
        // The 2.3.0 row survives, the legacy shapes still resolve, and the caller time no longer counts.
        const purged = await c.query<{ n: number }>("select knowledge_verification.purge_credential_use($1, $2) as n", [
          TENANT_A,
          new Date("2099-01-01T00:00:00Z"),
        ]);
        expect(purged.rows[0]?.n).toBe(0);
        const replay = await c.query<{ outcome: string }>(
          "select knowledge_verification.consume_credential($1, 'mission-control', 'jti-230', 'dispatch-x', $2) as outcome",
          [TENANT_A, expires],
        );
        expect(replay.rows[0]?.outcome).toBe("replay");
        // F2: a decision that binds normalized values is not admitted without their digest.
        const seeded = await seedRun(c, TENANT_A, "up240");
        await sealCall(c, TENANT_A, { runId: seeded.runId, expectedHead: null });
        await decisionCall(c, TENANT_A, { id: "ud-up240", runId: seeded.runId, effect: digest("bound-up240") });
        await failing(
          c,
          () =>
            c.query("select * from knowledge_verification.admit_exact_use($1, 'ud-up240', $2, 0)", [
              TENANT_A,
              digest("bound-up240"),
            ]),
          /NORMALIZED_VALUES_REQUIRED/,
        );
      });
    } finally {
      await admin((client) => client.query(`drop database if exists ${v230db} with (force)`));
    }
  });

  it("2.3.0: protocol receipts bind the component effect digest, first writer wins, immutable", async () => {
    const receiptFor = (effectKey: string, bound: string, dispatchId: string, tenant = TENANT_A) => ({
      handle: { tenant, operationId: "op-1" },
      effect: {
        effectKey,
        boundEffectDigest: bound,
        semanticPayloadDigest: digest("diagnostic"),
        dispatchId,
        envelopeDigest: digest(dispatchId),
      },
      outcome: "applied",
      digest: digest(`receipt-${dispatchId}`),
    });
    await asRole(dsn("ai-engineer"), "knowledge_verification_writer", TENANT_A, async (c) => {
      const seeded = await seedRun(c, TENANT_A, "protocol");
      await c.query("select knowledge_verification.bind_effect($1, 'effect-proto', $2, $3, $4)", [
        TENANT_A,
        digest("payload"),
        seeded.originDigest,
        digest("bound-proto"),
      ]);
      const record = (receipt: object, key = "effect-proto") =>
        c.query<{ dispatch_id: string; outcome: string }>(
          "select dispatch_id, outcome from knowledge_verification.record_protocol_receipt($1, $2, $3::jsonb)",
          [TENANT_A, key, JSON.stringify(receipt)],
        );
      const first = await record(receiptFor("effect-proto", digest("bound-proto"), "dispatch-a"));
      expect(first.rows[0]).toMatchObject({ dispatch_id: "dispatch-a", outcome: "applied" });
      const second = await record(receiptFor("effect-proto", digest("bound-proto"), "dispatch-b"));
      expect(second.rows[0]?.dispatch_id).toBe("dispatch-a");
      await failing(
        c,
        () => record(receiptFor("effect-proto", digest("other-bytes"), "dispatch-c")),
        /EFFECT_CONFLICT/,
      );
      await failing(
        c,
        () => record(receiptFor("effect-proto", digest("bound-proto"), "dispatch-d", TENANT_B)),
        /RECEIPT_SCOPE_MISMATCH/,
      );
      await failing(
        c,
        () => record(receiptFor("effect-unbound", digest("bound-proto"), "dispatch-e"), "effect-unbound"),
        /EFFECT_NOT_BOUND/,
      );
    });
    await expect(
      asRole(dsn("ai-engineer"), "knowledge_verification_writer", TENANT_A, (c) =>
        c.query(
          "update knowledge_verification.protocol_receipt set outcome = 'noop' where effect_key = 'effect-proto'",
        ),
      ),
    ).rejects.toThrow(/permission denied|IMMUTABLE_RECORD/);
  });

  it("refuses edited migration bytes and a schema without receipts", async () => {
    const edited = {
      ...component,
      migrations: component.migrations.map((m, i) =>
        i === 1 ? { ...m, sql: `${m.sql}\n-- edited`, sha256: "0".repeat(64) } : m,
      ),
    };
    await expect(
      install(edited, {
        adminDsn: dsn("ai-engineer"),
        installationId: "0192a4f0-0000-7000-8000-0000000a1e00",
        applicationId: "ai-engineer",
        binding: "aiengineer-postgres",
      }),
    ).rejects.toMatchObject({ code: "MIGRATION_BYTES_DIFFER" });
    const orphan = `kvc_orphan_${suffix}`;
    await admin((client) => client.query(`create database ${orphan}`));
    try {
      const client = new Client({ connectionString: databaseDsn(ADMIN as string, orphan) });
      await client.connect();
      await client.query("create schema knowledge_verification");
      await client.end();
      await expect(
        install(component, {
          adminDsn: databaseDsn(ADMIN as string, orphan),
          installationId: "0192a4f0-0000-7000-8000-0000000a1e00",
          applicationId: "ai-engineer",
          binding: "aiengineer-postgres",
        }),
      ).rejects.toBeInstanceOf(InstallRefused);
    } finally {
      await admin((client) => client.query(`drop database if exists ${orphan} with (force)`));
    }
  });

  it("fails closed without tenant context and isolates tenants under forced RLS", async () => {
    await expect(
      asRole(dsn("ai-engineer"), "knowledge_verification_reader", null, (c) =>
        c.query("select count(*) from knowledge_verification.origin"),
      ),
    ).rejects.toThrow(/TENANT_CONTEXT_REQUIRED/);
    await asRole(dsn("ai-engineer"), "knowledge_verification_writer", TENANT_A, (c) => seedRun(c, TENANT_A, "rls"));
    const seenByB = await asRole(dsn("ai-engineer"), "knowledge_verification_reader", TENANT_B, (c) =>
      c.query("select count(*)::int as n from knowledge_verification.verification_run"),
    );
    expect(seenByB.rows[0]?.n).toBe(0);
    await expect(
      asRole(dsn("ai-engineer"), "knowledge_verification_writer", TENANT_B, (c) =>
        c.query(
          "insert into knowledge_verification.origin (tenant_id, origin_digest, kind, installation_id, application_id, issuer, subject, identity) values ($1, $2, 'standalone', 'i', 'ai-engineer', 'ks', 'cli', '{}'::jsonb)",
          [TENANT_A, digest("cross-tenant")],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("binds effects once: identical retry is idempotent, different bytes or origin conflict", async () => {
    const result = await asRole(dsn("ai-engineer"), "knowledge_verification_writer", TENANT_A, async (c) => {
      const seeded = await seedRun(c, TENANT_A, "effect");
      const args = [TENANT_A, "effect-1", digest("payload"), seeded.originDigest, digest("bound-1")];
      const first = await c.query("select * from knowledge_verification.bind_effect($1, $2, $3, $4, $5)", args);
      const retry = await c.query("select * from knowledge_verification.bind_effect($1, $2, $3, $4, $5)", args);
      expect(retry.rows[0]?.created_at).toEqual(first.rows[0]?.created_at);
      await failing(
        c,
        () =>
          c.query("select * from knowledge_verification.bind_effect($1, $2, $3, $4, $5)", [
            TENANT_A,
            "effect-1",
            digest("payload"),
            seeded.originDigest,
            digest("bound-2"),
          ]),
        /EFFECT_CONFLICT/,
      );
      return seeded;
    });
    expect(result.runId).toBeTruthy();
    await expect(
      asRole(dsn("ai-engineer"), "knowledge_verification_writer", TENANT_A, (c) =>
        c.query("update knowledge_verification.effect set bound_effect_digest = $1 where effect_key = 'effect-1'", [
          digest("x"),
        ]),
      ),
    ).rejects.toThrow(/permission denied|IMMUTABLE_RECORD/);
  });

  it("seals a run by compare-and-set and refuses tampered or incomplete manifests", async () => {
    await pinKey(dsn("ai-engineer"));
    const seeded = await asRole(dsn("ai-engineer"), "knowledge_verification_writer", TENANT_A, (c) =>
      seedRun(c, TENANT_A, "seal"),
    );
    const manifest = { snapshot: "verification_snapshot", run: { id: seeded.runId }, predecessor: null, families };
    const manifestDigest = digest(JSON.stringify(manifest));
    const seal = (
      expectedHead: string | null,
      refs: Record<string, string>,
      body: Record<string, unknown> = manifest,
      bodyDigest = manifestDigest,
      extra: { keyId?: string; signature?: Buffer } = {},
    ) =>
      asRole(dsn("ai-engineer"), "knowledge_verification_writer", TENANT_A, (c) =>
        sealCall(c, TENANT_A, { runId: seeded.runId, expectedHead, body, bodyDigest, refs, ...extra }),
      );
    await expect(seal(null, { capture: families.capture })).rejects.toThrow(/FAMILY_REFS_INCOMPLETE/);
    // 2.2.0: the observations family is mandatory for a verification snapshot.
    const { observations: _observations, ...noObservations } = families;
    await expect(seal(null, noObservations)).rejects.toThrow(/FAMILY_REFS_INCOMPLETE/);
    await expect(seal(null, families, { ...manifest, self: manifestDigest })).rejects.toThrow(
      /MANIFEST_SELF_REFERENCE/,
    );
    // Unknown key, malformed signature, a manifest naming another run (importer replay into another run).
    await expect(seal(null, families, manifest, manifestDigest, { keyId: "ks-unknown" })).rejects.toThrow(
      /SEAL_INVALID/,
    );
    await expect(seal(null, families, manifest, manifestDigest, { signature: randomBytes(10) })).rejects.toThrow(
      /SEAL_INVALID/,
    );
    await expect(
      seal(null, families, { ...manifest, run: { id: "00000000-0000-7000-8000-000000000999" } }, digest("elsewhere")),
    ).rejects.toThrow(/RUN_LINK_MISMATCH/);
    const sealed = await seal(null, families);
    expect(sealed.rows[0]?.sequence).toBe(1);
    // A concurrent sealer that observed the empty head loses; replaying the sealed bytes refuses too.
    await expect(seal(null, families, { ...manifest, other: 1 }, digest("other"))).rejects.toThrow(/HEAD_MISMATCH/);
    await expect(seal(null, families)).rejects.toThrow(/HEAD_MISMATCH/);
    // Observations cannot be appended to a sealed run; the run cannot regress.
    await expect(
      asRole(dsn("ai-engineer"), "knowledge_verification_writer", TENANT_A, (c) =>
        c.query(
          `insert into knowledge_verification.observation (tenant_id, observation_id, schema_version, run_id, target_kind, target_id, target_digest, property, input_digest, method_ref, evaluator, evaluator_role, outcome, rationale, record, digest)
           values ($1, 'obs-late', 'research-core.observation.v2', $2::uuid, 'report', 'rev-seal', $3, 'census', $3, 'census.v2', '{}'::jsonb, 'auditor', '{}'::jsonb, 'late', '{}'::jsonb, $4)`,
          [TENANT_A, seeded.runId, digest("t"), digest("obs-late")],
        ),
      ),
    ).rejects.toThrow(/RUN_SEALED/);
    await expect(
      asRole(dsn("ai-engineer"), "knowledge_verification_writer", TENANT_A, (c) =>
        c.query("update knowledge_verification.verification_run set state = 'observing' where run_id = $1::uuid", [
          seeded.runId,
        ]),
      ),
    ).rejects.toThrow(/SEALED_RUN_IMMUTABLE/);
    // Decision snapshots follow the verification snapshot and chain by predecessor digest (and need their families).
    const successor = (refs: Record<string, string>, predecessor: string) =>
      asRole(dsn("ai-engineer"), "knowledge_verification_writer", TENANT_A, (c) =>
        sealCall(c, TENANT_A, {
          runId: seeded.runId,
          expectedHead: manifestDigest,
          kind: "decision_snapshot",
          body: {
            snapshot: "decision_snapshot",
            run: { id: seeded.runId },
            predecessor: { digest: predecessor },
            decision: 1,
          },
          refs,
        }),
      );
    await expect(successor({ verification: manifestDigest }, manifestDigest)).rejects.toThrow(/FAMILY_REFS_INCOMPLETE/);
    await expect(
      successor({ report: families.report, decisions: digest("d") }, digest("not-the-head")),
    ).rejects.toThrow(/LINEAGE_MISMATCH/);
    const decision = await successor({ report: families.report, decisions: digest("d") }, manifestDigest);
    expect(decision.rows[0]).toMatchObject({ sequence: 2, predecessor_digest: manifestDigest });
    // The registry is owner-written: capability roles cannot pin or edit keys; a revoked key never signs again.
    await expect(
      asRole(dsn("ai-engineer"), "knowledge_verification_writer", null, (c) =>
        c.query(
          "insert into knowledge_verification.seal_signing_key (key_id, algorithm, public_key, issuer) values ('k2', 'Ed25519', $1, 'x')",
          [randomBytes(32)],
        ),
      ),
    ).rejects.toThrow(/permission denied/);
    const owner = new Client({ connectionString: dsn("ai-engineer") });
    await owner.connect();
    try {
      await owner.query("update knowledge_verification.seal_signing_key set status = 'revoked' where key_id = $1", [
        KEY_ID,
      ]);
      await expect(
        owner.query("update knowledge_verification.seal_signing_key set status = 'active' where key_id = $1", [KEY_ID]),
      ).rejects.toThrow(/SIGNING_KEY_ONLY_RETIRES/);
    } finally {
      await owner.end();
    }
    const other = await asRole(dsn("ai-engineer"), "knowledge_verification_writer", TENANT_A, (c) =>
      seedRun(c, TENANT_A, "revoked-key"),
    );
    await expect(
      asRole(dsn("ai-engineer"), "knowledge_verification_writer", TENANT_A, (c) =>
        sealCall(c, TENANT_A, { runId: other.runId, expectedHead: null }),
      ),
    ).rejects.toThrow(/SEAL_INVALID/);
    const reactivate = new Client({ connectionString: dsn("ai-engineer") });
    await reactivate.connect();
    try {
      // Tests that follow seal with a fresh active key.
      await reactivate.query(
        "insert into knowledge_verification.seal_signing_key (key_id, algorithm, public_key, issuer) values ($1, 'Ed25519', $2, 'knowledge-services')",
        [`${KEY_ID}-2`, randomBytes(32)],
      );
    } finally {
      await reactivate.end();
    }
  });

  it("admits exact use only under a current epoch, exact digest, qualified review and complete closure", async () => {
    const seeded = await asRole(dsn("ai-engineer"), "knowledge_verification_writer", TENANT_A, async (c) => {
      const s = await seedRun(c, TENANT_A, "admit");
      await sealCall(c, TENANT_A, { runId: s.runId, expectedHead: null, keyId: `${KEY_ID}-2` });
      return s;
    });
    const bound = digest("bound-admit");
    // An unqualified reviewer cannot adjudicate; a granted one can.
    await expect(
      asRole(dsn("ai-engineer"), "knowledge_verification_reviewer", TENANT_A, (c) =>
        c.query(
          "insert into knowledge_verification.adjudication (tenant_id, adjudication_id, subject_kind, subject_id, subject_digest, bound_effect_digest, reviewer_id, decision, rationale, digest) values ($1, 'adj-0', 'effect', 'effect-admit', $2, $2, 'dr-nobody', 'approve', 'ok', $3)",
          [TENANT_A, bound, digest("adj-0")],
        ),
      ),
    ).rejects.toThrow(/REVIEWER_NOT_QUALIFIED/);
    await asRole(dsn("ai-engineer"), "knowledge_verification_reviewer", TENANT_A, async (c) => {
      await c.query(
        `insert into knowledge_verification.reviewer_grant (tenant_id, reviewer_id, scope, granted_by, granted_at)
         values ($1, 'dr-okafor', '{"uses": ["*"], "audiences": ["*"], "reportKinds": ["*"]}'::jsonb, 'owner', now() - interval '1 hour')`,
        [TENANT_A],
      );
      await c.query(
        "insert into knowledge_verification.adjudication (tenant_id, adjudication_id, subject_kind, subject_id, subject_digest, bound_effect_digest, reviewer_id, decision, rationale, digest) values ($1, 'adj-1', 'effect', 'effect-admit', $2, $2, 'dr-okafor', 'approve', 'exact bytes reviewed', $3)",
        [TENANT_A, bound, digest("adj-1")],
      );
    });
    const insertDecision = (id: string, effectDigest: string, adjudication: string | null, epoch: number) =>
      asRole(dsn("ai-engineer"), "knowledge_verification_writer", TENANT_A, (c) =>
        decisionCall(c, TENANT_A, { id, runId: seeded.runId, effect: effectDigest, adjudication, epoch }),
      );
    // A reviewer who signed a different effect digest cannot authorize this decision.
    await expect(insertDecision("ud-wrong", digest("other-bytes"), "adj-1", 0)).rejects.toThrow(
      /REVIEW_BINDING_MISMATCH/,
    );
    await insertDecision("ud-1", bound, "adj-1", 0);
    const admit = (decision: string, effectDigest: string, processedEpoch: number) =>
      asRole(dsn("ai-engineer"), "knowledge_verification_writer", TENANT_A, async (c) => {
        const r = await c.query<{ outcome: string; reason: string; authoritative_epoch: string }>(
          "select * from knowledge_verification.admit_exact_use($1, $2, $3, $4, now(), $5)",
          [TENANT_A, decision, effectDigest, processedEpoch, digest(JSON.stringify({ parameters: "7000000000" }))],
        );
        return r.rows[0];
      });
    expect(await admit("ud-1", bound, 0)).toMatchObject({ outcome: "admitted", reason: "OK" });
    expect(await admit("ud-1", digest("edited"), 0)).toMatchObject({
      outcome: "rejected",
      reason: "EFFECT_DIGEST_MISMATCH",
    });
    expect(await admit("ud-missing", bound, 0)).toMatchObject({ outcome: "rejected", reason: "DECISION_NOT_FOUND" });
    // A known correction advances the epoch: stale processors hold, and until closure is listed everything holds.
    const invalidation = await asRole(dsn("ai-engineer"), "knowledge_verification_writer", TENANT_A, (c) =>
      c.query<{ invalidation_id: string; epoch: string }>(
        "select invalidation_id::text, epoch::text from knowledge_verification.record_invalidation($1, 'fragment', 'frag-9', 'source retracted')",
        [TENANT_A],
      ),
    );
    expect(invalidation.rows[0]?.epoch).toBe("1");
    expect(await admit("ud-1", bound, 0)).toMatchObject({ outcome: "held", reason: "REVOCATION_EPOCH_STALE" });
    expect(await admit("ud-1", bound, 1)).toMatchObject({ outcome: "held", reason: "INVALIDATION_CLOSURE_INCOMPLETE" });
    await asRole(dsn("ai-engineer"), "knowledge_verification_writer", TENANT_A, async (c) => {
      await c.query(
        "insert into knowledge_verification.invalidation_affected (tenant_id, invalidation_id, affected_kind, affected_id) values ($1, $2::uuid, 'use_decision', 'ud-1')",
        [TENANT_A, invalidation.rows[0]?.invalidation_id],
      );
      await c.query(
        "update knowledge_verification.invalidation set closure_processed_at = now() where invalidation_id = $1::uuid",
        [invalidation.rows[0]?.invalidation_id],
      );
    });
    expect(await admit("ud-1", bound, 1)).toMatchObject({ outcome: "rejected", reason: "DECISION_INVALIDATED" });
    // A successor decision at the new epoch admits; the superseded one is stale.
    await asRole(dsn("ai-engineer"), "knowledge_verification_writer", TENANT_A, (c) =>
      decisionCall(c, TENANT_A, {
        id: "ud-2",
        runId: seeded.runId,
        effect: bound,
        epoch: 1,
        adjudication: "adj-1",
        supersedes: "ud-1",
      }),
    );
    expect(await admit("ud-2", bound, 1)).toMatchObject({ outcome: "admitted" });
    expect(await admit("ud-1", bound, 1)).toMatchObject({ outcome: "held", reason: "STALE_DECISION" });
    // 2.2.0: a normalized value mismatch rejects; the 2.1.0 four-argument call shape still resolves.
    const mismatch = await asRole(
      dsn("ai-engineer"),
      "knowledge_verification_writer",
      TENANT_A,
      async (c) =>
        (
          await c.query("select * from knowledge_verification.admit_exact_use($1, 'ud-2', $2, 1, now(), $3)", [
            TENANT_A,
            bound,
            digest("other values"),
          ])
        ).rows[0],
    );
    expect(mismatch).toMatchObject({ outcome: "rejected", reason: "NORMALIZED_VALUES_MISMATCH" });
    // 2.4.0 (R1 F2): the 2.1.0 four-argument shape presents no values digest; the decision binds one, so it raises.
    await expect(
      asRole(dsn("ai-engineer"), "knowledge_verification_writer", TENANT_A, (c) =>
        c.query("select * from knowledge_verification.admit_exact_use($1, 'ud-2', $2, 1)", [TENANT_A, bound]),
      ),
    ).rejects.toThrow(/NORMALIZED_VALUES_REQUIRED/);
    // The read path keeps no values: eligibility is still answered.
    const eligible = await asRole(
      dsn("ai-engineer"),
      "knowledge_verification_reader",
      TENANT_A,
      async (c) =>
        (await c.query("select * from knowledge_verification.check_use_eligibility($1, 'ud-2', $2)", [TENANT_A, bound]))
          .rows[0],
    );
    expect(eligible).toMatchObject({ state: "admitted" });
    // A report decision may not carry a qualifiers digest (no sentinel), and normalized values must match the record.
    await expect(
      asRole(dsn("ai-engineer"), "knowledge_verification_writer", TENANT_A, (c) =>
        c.query(
          "update knowledge_verification.use_decision set qualifiers_digest = $1 where use_decision_id = 'ud-2'",
          [digest("q")],
        ),
      ),
    ).rejects.toThrow(/permission denied|IMMUTABLE_RECORD/);
  });

  it("scopes reviewer grants, binds adjudications to the exact decision, and requires live review at admission", async () => {
    const seeded = await asRole(dsn("ai-engineer"), "knowledge_verification_writer", TENANT_A, async (c) => {
      const s = await seedRun(c, TENANT_A, "review");
      await sealCall(c, TENANT_A, { runId: s.runId, expectedHead: null, keyId: `${KEY_ID}-2` });
      return s;
    });
    const bound = digest("bound-review");
    const subjectDigest = digest("rev-admit");
    await asRole(dsn("ai-engineer"), "knowledge_verification_writer", TENANT_A, (c) =>
      decisionCall(c, TENANT_A, {
        id: "ud-r1",
        runId: seeded.runId,
        effect: bound,
        conditions: ["review_required"],
        subjectDigest,
        reportId: "rev-review",
      }),
    );
    const admit = (id: string) =>
      asRole(
        dsn("ai-engineer"),
        "knowledge_verification_writer",
        TENANT_A,
        async (c) =>
          (
            await c.query(
              "select * from knowledge_verification.admit_exact_use($1, $2, $3, knowledge_verification.current_revocation_epoch($1), now(), $4)",
              [TENANT_A, id, bound, digest(JSON.stringify({ parameters: "7000000000" }))],
            )
          ).rows[0],
      );
    expect(await admit("ud-r1")).toMatchObject({ outcome: "held", reason: "REVIEW_REQUIRED" });
    const adjudicate = (id: string, reviewer: string, extra: { subject?: string; effect?: string } = {}) =>
      asRole(dsn("ai-engineer"), "knowledge_verification_reviewer", TENANT_A, (c) =>
        c.query(
          `insert into knowledge_verification.adjudication (tenant_id, adjudication_id, subject_kind, subject_id, subject_digest, bound_effect_digest, reviewer_id, decision, rationale, digest, use_decision_id, qualifiers_digest)
           values ($1, $2, 'report', 'rev-admit', $3, $4, $5, 'approve', 'exact bindings reviewed', $6, 'ud-r1', null)`,
          [TENANT_A, id, extra.subject ?? subjectDigest, extra.effect ?? bound, reviewer, digest(id)],
        ),
      );
    // A grant whose scope does not cover the decision's audience qualifies for nothing here.
    await asRole(dsn("ai-engineer"), "knowledge_verification_reviewer", TENANT_A, (c) =>
      c.query(
        `insert into knowledge_verification.reviewer_grant (tenant_id, reviewer_id, scope, granted_by, granted_at)
         values ($1, 'dr-scoped', '{"uses": ["knowledge_ingestion.fact_assert_state"], "audiences": ["internal"], "reportKinds": ["evidence_report"]}'::jsonb, 'owner', now() - interval '1 hour'),
                ($1, 'dr-right', '{"uses": ["knowledge_ingestion.fact_assert_state"], "audiences": ["official"], "reportKinds": ["evidence_report"]}'::jsonb, 'owner', now() - interval '1 hour')`,
        [TENANT_A],
      ),
    );
    await expect(adjudicate("adj-scope", "dr-scoped")).rejects.toThrow(/REVIEWER_NOT_QUALIFIED/);
    await expect(adjudicate("adj-subject", "dr-right", { subject: digest("other report") })).rejects.toThrow(
      /ADJUDICATION_SUBJECT_MISMATCH/,
    );
    await expect(adjudicate("adj-effect", "dr-right", { effect: digest("edited") })).rejects.toThrow(
      /REVIEW_BINDING_MISMATCH/,
    );
    await adjudicate("adj-r1", "dr-right");
    // The successor names the adjudication and supersedes the reviewed decision.
    await expect(
      asRole(dsn("ai-engineer"), "knowledge_verification_writer", TENANT_A, (c) =>
        decisionCall(c, TENANT_A, {
          id: "ud-r-wrong",
          runId: seeded.runId,
          effect: bound,
          adjudication: "adj-r1",
          conditions: ["review_required"],
          subjectDigest,
          reportId: "rev-review",
        }),
      ),
    ).rejects.toThrow(/ADJUDICATION_SUBJECT_MISMATCH/);
    await asRole(dsn("ai-engineer"), "knowledge_verification_writer", TENANT_A, (c) =>
      decisionCall(c, TENANT_A, {
        id: "ud-r2",
        runId: seeded.runId,
        effect: bound,
        adjudication: "adj-r1",
        supersedes: "ud-r1",
        conditions: ["review_required"],
        subjectDigest,
        reportId: "rev-review",
      }),
    );
    expect(await admit("ud-r1")).toMatchObject({ outcome: "held", reason: "STALE_DECISION" });
    expect(await admit("ud-r2")).toMatchObject({ outcome: "admitted" });
    // Side-effect-free eligibility for readers applies the same rule.
    const eligibility = await asRole(
      dsn("ai-engineer"),
      "knowledge_verification_reader",
      TENANT_A,
      async (c) =>
        (
          await c.query("select * from knowledge_verification.check_use_eligibility($1, 'ud-r2', $2)", [
            TENANT_A,
            bound,
          ])
        ).rows[0],
    );
    expect(eligibility).toMatchObject({ state: "admitted", reason: "OK" });
    // Revoking the reviewer's grant withdraws the authority at admission.
    await asRole(dsn("ai-engineer"), "knowledge_verification_reviewer", TENANT_A, (c) =>
      c.query("update knowledge_verification.reviewer_grant set revoked_at = now() where reviewer_id = 'dr-right'"),
    );
    expect(await admit("ud-r2")).toMatchObject({ outcome: "held", reason: "REVIEW_REQUIRED" });
  });

  it("records one receipt per effect and runs the cross-store outbox with revocation in transit", async () => {
    await pinKey(dsn("biotech"));
    const payload = Buffer.from('{"schemaVersion":"biotech-knowledge-admission.v1"}');
    const payloadDigest = digest(payload.toString("utf8"));
    await asRole(dsn("biotech"), "knowledge_verification_writer", TENANT_A, async (c) => {
      const s = await seedRun(c, TENANT_A, "outbox");
      await sealCall(c, TENANT_A, { runId: s.runId, expectedHead: null });
      await c.query("select knowledge_verification.bind_effect($1, 'effect-out', $2, $3, $4)", [
        TENANT_A,
        digest("p"),
        s.originDigest,
        digest("b"),
      ]);
      await decisionCall(c, TENANT_A, { id: "ud-out", runId: s.runId, effect: digest("b") });
      await c.query(
        "insert into knowledge_verification.artifact_custody (tenant_id, artifact_id, digest, byte_length, media_type, custody_kind, inline_bytes) values ($1, 'payload-out', $2, $3, 'application/json', 'inline', $4)",
        [TENANT_A, payloadDigest, payload.byteLength, payload],
      );
      const receiptArgs = [
        TENANT_A,
        "effect-out",
        "applied",
        "{}",
        "[]",
        null,
        "rev-7",
        0,
        "[]",
        null,
        digest("receipt-1"),
      ];
      const receipt = await c.query(
        "select outcome from knowledge_verification.record_effect_receipt($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9::jsonb, $10, $11)",
        receiptArgs,
      );
      expect(receipt.rows[0]?.outcome).toBe("applied");
      await c.query(
        "select outcome from knowledge_verification.record_effect_receipt($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9::jsonb, $10, $11)",
        receiptArgs,
      );
      await failing(
        c,
        () =>
          c.query(
            "select outcome from knowledge_verification.record_effect_receipt($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9::jsonb, $10, $11)",
            [...receiptArgs.slice(0, 10), digest("receipt-2")],
          ),
        /RECEIPT_CONFLICT/,
      );
      // The writer can no longer insert outbox rows directly: enqueue_dispatch is the only path.
      await failing(
        c,
        () =>
          c.query(
            "insert into knowledge_verification.dispatch_outbox (tenant_id, dispatch_id, effect_key, target_binding, payload_digest) values ($1, 'direct', 'effect-out', 'biotech-graph', $2)",
            [TENANT_A, payloadDigest],
          ),
        /permission denied/,
      );
      await failing(
        c,
        () =>
          c.query(
            "select * from knowledge_verification.enqueue_dispatch($1, 'd-x', 'effect-out', 'biotech-graph', $2, 'ud-out', $3, 0)",
            [TENANT_A, payloadDigest, digest("other bytes")],
          ),
        /EFFECT_CONFLICT/,
      );
      await failing(
        c,
        () =>
          c.query(
            "select * from knowledge_verification.enqueue_dispatch($1, 'd-x', 'effect-out', 'biotech-graph', $2, 'ud-out', $3, 0)",
            [TENANT_A, digest("no such payload"), digest("b")],
          ),
        /PAYLOAD_NOT_IN_CUSTODY/,
      );
      // 2.4.0 (R1 F2): enqueue admits through admit_exact_use, so a null values digest raises.
      await failing(
        c,
        () =>
          c.query(
            "select * from knowledge_verification.enqueue_dispatch($1, 'd-null', 'effect-out', 'biotech-graph', $2, 'ud-out', $3, 0, null, 'ks-intent-marker.v1')",
            [TENANT_A, payloadDigest, digest("b")],
          ),
        /NORMALIZED_VALUES_REQUIRED/,
      );
      for (const [id, scheme] of [
        ["d-1", "ks-intent-marker.v1"],
        ["d-2", "ks-intent-marker.v1"],
        ["d-3", "bks-intent-marker-digest.v1"],
      ] as const) {
        await c.query(
          "select * from knowledge_verification.enqueue_dispatch($1, $2, 'effect-out', 'biotech-graph', $3, 'ud-out', $4, 0, $5, $6)",
          [TENANT_A, id, payloadDigest, digest("b"), digest(JSON.stringify({ parameters: "7000000000" })), scheme],
        );
      }
    });
    const worker = <T>(fn: (c: Client) => Promise<T>) =>
      asRole(dsn("biotech"), "knowledge_verification_outbox_worker", TENANT_A, fn);
    const claimed = await worker((c) =>
      c.query<{ dispatch_id: string; expected_marker_digest: string | null }>(
        "select dispatch_id, expected_marker_digest from knowledge_verification.claim_dispatches($1, 10, now(), 'biotech-graph') order by dispatch_id",
        [TENANT_A],
      ),
    );
    expect(claimed.rows.map((r) => r.dispatch_id)).toEqual(["d-1", "d-2", "d-3"]);
    const expected = claimed.rows[0]?.expected_marker_digest as string;
    const ack = (id: string, ackDigest: string, record: Record<string, unknown> | null = null) =>
      worker((c) =>
        c.query(
          "select state, ack_outcome from knowledge_verification.acknowledge_dispatch($1, $2, $3, now(), $4::jsonb)",
          [TENANT_A, id, ackDigest, record === null ? null : JSON.stringify(record)],
        ),
      );
    await expect(ack("d-1", digest("marker-1"))).rejects.toThrow(/MARKER_MISMATCH/);
    expect((await ack("d-1", expected)).rows[0]).toEqual({ state: "acknowledged", ack_outcome: "applied" });
    expect((await ack("d-1", expected)).rows[0]?.state).toBe("acknowledged"); // duplicate delivery no-op
    await expect(ack("d-1", digest("marker-other"))).rejects.toThrow(/ACK_CONFLICT/);
    // BKS marker scheme: the digest is sha256 of the JCS bytes {format, payloadDigest, planDigest}.
    const planDigest = digest("plan");
    const bks = digest(
      `{"format":"bks-intent-marker-digest.v1","payloadDigest":"${payloadDigest}","planDigest":"${planDigest}"}`,
    );
    await expect(ack("d-3", bks, { payloadDigest: digest("other payload"), planDigest })).rejects.toThrow(
      /MARKER_MISMATCH/,
    );
    expect((await ack("d-3", bks, { payloadDigest, planDigest, outcome: "noop", graphTxRef: "tx-3" })).rows[0]).toEqual(
      {
        state: "acknowledged",
        ack_outcome: "noop",
      },
    );
    const revoked = await asRole(dsn("biotech"), "knowledge_verification_writer", TENANT_A, (c) =>
      c.query<{ n: number }>("select knowledge_verification.revoke_pending_dispatches($1, 'effect-out') as n", [
        TENANT_A,
      ]),
    );
    expect(revoked.rows[0]?.n).toBe(1);
    await expect(ack("d-2", expected)).rejects.toThrow(/DISPATCH_REVOKED/);
    // The worker settles the revoked dispatch terminally (idempotent), with its reason recorded.
    const settle = () =>
      worker((c) =>
        c.query(
          "select state, settled_at is not null as settled from knowledge_verification.settle_dispatch($1, 'd-2', 'revoked', $2::jsonb)",
          [TENANT_A, JSON.stringify({ reason: "decision revoked in transit" })],
        ),
      );
    expect((await settle()).rows[0]).toEqual({ state: "revoked", settled: true });
    expect((await settle()).rows[0]?.state).toBe("revoked");
    // Append-only records refuse mutation even for the writer.
    await expect(
      asRole(dsn("biotech"), "knowledge_verification_writer", TENANT_A, (c) =>
        c.query("delete from knowledge_verification.effect_receipt where effect_key = 'effect-out'"),
      ),
    ).rejects.toThrow(/permission denied|IMMUTABLE_RECORD/);
  });
});
