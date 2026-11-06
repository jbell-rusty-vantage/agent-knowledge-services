import { spawn, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BIOTECH_SCHEMA_RELEASE_V2_2_0,
  type FrozenReportBinding,
  biotechEffect,
  biotechReportKind,
  reportPublishFields,
} from "@aiengineer/knowledge-binding-biotech-graph";
import { install, loadComponent } from "@aiengineer/knowledge-db-contract";
import {
  type JsonValue,
  type OperationEnvelope,
  OperationReceiptSchema,
  ReceiptLookupSchema,
  digestCanonical,
  envelopeDigest,
} from "@aiengineer/knowledge-operation-protocol";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  claimsFor,
  envelopeFor,
  generateIssuerKey,
  jwksOf,
  liveOrigin,
  recoveryOriginFor,
  signCredential,
} from "./tests/test-support.js";

/**
 * WI-05 (OVE-167) fresh-process proof, Biotech, over the disposable Biotech component PostgreSQL 17 and a disposable
 * loopback Neo4j running the REAL BKS dispatch consumer (BKS sources from a guarded `WI05_BKS_ROOT`). Each step is its
 * own OS process. What these cases prove, and nothing more:
 *   - SIGKILL after the SQL commit (exact-use admission + outbox enqueue), before the K01 protocol receipt: a fresh
 *     retransmission and a fresh read-only receipt.get answer the original dispatch's receipt; one outbox row.
 *   - Changed bytes under the committed key refuse EFFECT_CONFLICT.
 *   - SIGKILL after the graph commit (effect + KsIntentMarker), before the PostgreSQL ack: a fresh consumer finds the
 *     marker, acknowledges once with the expected marker digest, never re-applies; a further trigger claims nothing.
 *   - Reordered protocol acknowledgments: dispatch N is held after its SQL commit, dispatch N+1 records the receipt
 *     first, N's late write answers that same first-recorded receipt.
 *   - Revocation before dispatch (outbox row revoked before the consumer claims it): no graph write, delivery revoked.
 *   - Revocation during the acknowledgment (after the graph commit): delivery revoked, the marker stays, no re-apply.
 *   - Rollback on a stale decision: no commit, no outbox row, receipt.get not_found.
 *   - Two concurrent different-bytes applies of one key in two processes: one commits, the other EFFECT_CONFLICT.
 *   - Separate readback: marker/Activity/Report counts read from Neo4j by another process, outbox rows from PostgreSQL.
 * Needs KNOWLEDGE_DB_CONTRACT_ADMIN_DSN (loopback), WI05_BKS_ROOT, NEO4J_TEST_URI, NEO4J_TEST_PASSWORD; skips without.
 */
const ADMIN = process.env.KNOWLEDGE_DB_CONTRACT_ADMIN_DSN;
const BKS_ROOT = process.env.WI05_BKS_ROOT;
const NEO4J = process.env.NEO4J_TEST_URI;
const enabled = Boolean(ADMIN && BKS_ROOT && NEO4J && process.env.NEO4J_TEST_PASSWORD);
const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, "../..");
const TENANT = randomUUID();
const INSTALLATION = randomUUID();
const BINDING = "biotech-graph";
const digest = (value: string | Uint8Array) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const VALUES_DIGEST = digestCanonical({});

describe.skipIf(!enabled)(
  "WI-05 native recovery across fresh processes (Biotech component PostgreSQL + Neo4j + BKS consumer)",
  () => {
    const database = `kvr_${randomBytes(4).toString("hex")}`;
    const outboxRole = `wi05_outbox_${randomBytes(3).toString("hex")}`;
    const rolePassword = `wi05-${randomBytes(8).toString("hex")}`;
    const work = mkdtempSync(join(tmpdir(), "ks-wi05-"));
    const key = generateIssuerKey("mc-wi05");
    const origin = liveOrigin(TENANT, { installationId: INSTALLATION, application: "biotech", invocation: "inv-wi05" });
    const dsn = (user?: { name: string; password: string }) => {
      const url = new URL(ADMIN as string);
      if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) throw new Error("LOOPBACK_REQUIRED");
      url.pathname = `/${database}`;
      if (user) {
        url.username = user.name;
        url.password = user.password;
      }
      return url.toString();
    };
    let runId = "";
    let frozen!: FrozenReportBinding;
    let seq = 0;

    const owner = async <T>(fn: (c: Client) => Promise<T>): Promise<T> => {
      const c = new Client({ connectionString: dsn() });
      await c.connect();
      try {
        await c.query("begin");
        await c.query("select set_config('app.tenant_id', $1, true)", [TENANT]);
        const result = await fn(c);
        await c.query("commit");
        return result;
      } finally {
        await c.end();
      }
    };

    /** Run one driver in its own OS process; `killed` when it died by SIGKILL (the crash under test). */
    function run(
      driver: string,
      body: Record<string, unknown>,
    ): { killed: boolean; out: Record<string, unknown> | null } {
      seq += 1;
      const file = join(work, `request-${seq}.json`);
      writeFileSync(file, JSON.stringify(body));
      const result = spawnSync(process.execPath, ["--import", "tsx", join(HERE, "tests", driver), file], {
        cwd: APP,
        env: {
          ...process.env,
          WI05_KS_DSN: dsn(),
          WI05_ADMIN_DSN: dsn(),
          WI05_OUTBOX_DSN: dsn({ name: outboxRole, password: rolePassword }),
        },
        encoding: "utf8",
        timeout: 120_000,
        windowsHide: true,
      });
      const line = result.stdout.trim().split("\n").filter(Boolean).at(-1);
      // The driver announces the crash on stderr right before it SIGKILLs itself; anything else is a failure.
      const killed = !line && result.status !== 0 && result.stderr.includes("WI05_CRASH");
      if (!killed && (result.status !== 0 || !line)) throw new Error(`${driver} failed: ${result.stderr.slice(-2000)}`);
      return { killed, out: line ? (JSON.parse(line) as Record<string, unknown>) : null };
    }

    /**
     * Start a driver that holds after its native commit (stderr `WI05_HELD`) until `release()`: a real delayed
     * acknowledgment in its own process. `done` resolves with its answer line.
     */
    async function startHeld(driver: string, body: Record<string, unknown>) {
      seq += 1;
      const file = join(work, `request-${seq}.json`);
      const releaseFile = join(work, `release-${seq}`);
      writeFileSync(file, JSON.stringify({ ...body, hold: { releaseFile } }));
      const child = spawn(process.execPath, ["--import", "tsx", join(HERE, "tests", driver), file], {
        cwd: APP,
        env: { ...process.env, WI05_KS_DSN: dsn() },
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += String(chunk)));
      const held = new Promise<void>((ready, failed) => {
        child.stderr.on("data", (chunk) => {
          stderr += String(chunk);
          if (stderr.includes("WI05_HELD")) ready();
        });
        child.on("exit", () => failed(new Error(`${driver} exited before holding: ${stderr.slice(-2000)}`)));
      });
      const done = new Promise<Record<string, unknown>>((answer, failed) =>
        child.on("exit", (status) => {
          const line = stdout.trim().split("\n").filter(Boolean).at(-1);
          if (status !== 0 || !line) failed(new Error(`${driver} failed: ${stderr.slice(-2000)}`));
          else answer(JSON.parse(line) as Record<string, unknown>);
        }),
      );
      await held;
      return { release: () => writeFileSync(releaseFile, "release"), done };
    }

    /** One KS invoke in its own OS process, not awaited: for genuinely concurrent native applies. */
    function ksAsync(body: Record<string, unknown>): Promise<Record<string, unknown>> {
      seq += 1;
      const file = join(work, `request-${seq}.json`);
      writeFileSync(
        file,
        JSON.stringify({
          binding: BINDING,
          installationId: INSTALLATION,
          tenants: [TENANT],
          jwks: jwksOf([key]),
          ...body,
        }),
      );
      const child = spawn(process.execPath, ["--import", "tsx", join(HERE, "tests", "ks-operation-driver.ts"), file], {
        cwd: APP,
        env: { ...process.env, WI05_KS_DSN: dsn() },
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += String(chunk)));
      child.stderr.on("data", (chunk) => (stderr += String(chunk)));
      return new Promise((answer, failed) =>
        child.on("exit", (status) => {
          const line = stdout.trim().split("\n").filter(Boolean).at(-1);
          if (status !== 0 || !line) failed(new Error(`ks driver failed: ${stderr.slice(-2000)}`));
          else answer(JSON.parse(line) as Record<string, unknown>);
        }),
      );
    }

    const ks = (body: Record<string, unknown>) =>
      run("ks-operation-driver.ts", {
        binding: BINDING,
        installationId: INSTALLATION,
        tenants: [TENANT],
        jwks: jwksOf([key]),
        ...body,
      });
    const bks = (body: Record<string, unknown>) =>
      run("bks-consumer-driver.ts", { tenantId: TENANT, installationId: INSTALLATION, ...body });

    /** An admitted use decision for a fresh effect over the frozen report revision; its apply envelope. */
    async function prepared(name: string) {
      const n = `${name}-${TENANT.slice(0, 8)}`;
      const intent = {
        schemaVersion: "biotech-knowledge-intent.v2",
        intentId: `wi05-${n}`,
        pins: { schemaReleaseDigest: BIOTECH_SCHEMA_RELEASE_V2_2_0, policyVersion: "bks-admission-policy/v1" },
        context: {
          actor: { kind: "agent", id: "ks-wi05", model: "synthetic" },
          run: { system: "ks-verification", runId: `${runId}/${name}`, operationId: `op-${name}` },
          activityKind: "EVIDENCE_MISSION",
        },
        basis: { creationOnly: { reason: "WI-05 synthetic native recovery fixture: first capture of these entities" } },
        // The evidence-report shape the BKS consumer applies (its SV-11 fixture): a cited occurrence assertion.
        sources: [
          {
            ref: "post",
            source: { canonicalUri: `https://fixtures.bks.test/wi05/${n}/post`, sourceKind: "WEB_PAGE" },
            snapshot: {
              retrievedAt: "2026-10-27T08:00:00Z",
              observedAt: "2026-10-27T08:00:00Z",
              contentHash: digest(`post-${n}`),
              contentHashBasis: "SYNTHETIC_FIXTURE",
              captureMethod: "bks-fixture/1",
              captureCompleteness: "COMPLETE",
            },
            locators: [
              {
                ref: "l-claim",
                selectorKind: "TEXT_QUOTE",
                selector: {
                  basis: "raw-capture/v1",
                  type: "TextQuoteSelector",
                  exact: "Synthetic NR activates synthetic protein SP1",
                  refinedBy: { type: "TextPositionSelector", start: 100, end: 144 },
                },
                exact: "Synthetic NR activates synthetic protein SP1",
                startOffset: 100,
                endOffset: 144,
              },
            ],
          },
        ],
        subjects: [
          {
            ref: "org",
            mode: "new",
            nodeType: "Organization",
            name: `WI-05 Claimant ${n}`,
            uidSegment: `wi05-org-${n}`,
            properties: { entityKind: "LEGAL_ENTITY" },
            onMatch: "use_existing",
          },
          {
            ref: "nr",
            mode: "new",
            nodeType: "ChemicalSubstance",
            name: `WI-05 NR ${n}`,
            uidSegment: `wi05-nr-${n}`,
            properties: {},
            onMatch: "use_existing",
          },
          {
            ref: "sp1",
            mode: "new",
            nodeType: "MolecularEntity",
            name: `WI-05 protein SP1 ${n}`,
            uidSegment: `wi05-sp1-${n}`,
            properties: {},
            onMatch: "use_existing",
          },
          {
            ref: "claim",
            mode: "new",
            nodeType: "Claim",
            name: `WI-05 NR activates SP1 (${n})`,
            properties: {
              proposition: `WI-05 NR ${n} directly activates synthetic protein SP1`,
              claimType: "RELATIONSHIP",
            },
            onMatch: "use_existing",
          },
        ],
        proposals: [
          { proposalId: "lineage", kind: "lineage.start", about: ["claim"] },
          {
            proposalId: "occurrence",
            kind: "assertion.relate",
            subjectRef: "nr",
            objectRef: "sp1",
            asserterRef: "org",
            evidence: ["l-claim"],
            assertion: {
              predicate: "ACTIVATES",
              assertionKind: "CLAIM",
              claimType: "RELATIONSHIP",
              occurrenceOf: { claimRef: "claim" },
              speechAct: "STATES",
              basisKind: "MANUFACTURER_CLAIM",
              validity: { validObservedAt: "2026-10-27T00:00:00Z" },
            },
          },
          {
            proposalId: "report",
            kind: "report.publish",
            name: `WI-05 evidence report ${n}`,
            policyVersion: "bks-admission-policy/v1",
            ...reportPublishFields(frozen),
            verdict: "NOT_SUPPORTED",
            about: ["claim"],
            citesAssertions: [{ proposal: "occurrence" }],
            evidence: ["l-claim"],
          },
        ],
      };
      const bound = biotechEffect(intent, origin).boundEffectDigest;
      const decisionId = `ud-wi05-${name}`;
      const epoch = await owner(async (c) =>
        Number(
          (await c.query<{ e: string }>("select knowledge_verification.current_revocation_epoch($1)::text e", [TENANT]))
            .rows[0]?.e,
        ),
      );
      await owner((c) =>
        c.query(
          `insert into knowledge_verification.use_decision (tenant_id, use_decision_id, schema_version, subject_kind, subject_id, subject_digest, run_id, bound_effect_digest, use_name, audience, disposition, conditions, policy_ref, rubric_ref, qualifiers_digest, revocation_epoch, record, digest, normalized_values, normalized_values_digest)
         values ($1, $2, 'research-core.use_decision.v2', 'report', $3, $4, $5::uuid, $6, 'official.publication', 'biotech-public', 'admitted', '[]'::jsonb, 'policy/wi05@1', 'rubric/wi05@1', null, $7, '{}'::jsonb, $8, '{}'::jsonb, $9)`,
          [
            TENANT,
            decisionId,
            frozen.reportRevisionId,
            digest(frozen.reportRevisionId),
            runId,
            bound,
            epoch,
            digest(decisionId),
            VALUES_DIGEST,
          ],
        ),
      );
      const effectKey = `ks:wi05/${TENANT.slice(0, 8)}/${name}`;
      const payload = {
        schemaVersion: "biotech-knowledge-apply.v1",
        intent,
        exactUse: { useDecisionId: decisionId, processedEpoch: epoch, normalizedValuesDigest: VALUES_DIGEST },
      } as unknown as JsonValue;
      const envelope = envelopeFor({
        operation: "knowledge.apply",
        origin,
        binding: BINDING,
        payload,
        effectKey,
        boundEffectDigest: bound,
        nativeContract: { name: "biotech-knowledge-apply", version: "v1" },
      });
      return { envelope, effectKey, bound, decisionId, intent };
    }

    const tokenFor = (envelope: OperationEnvelope) =>
      signCredential(
        key,
        claimsFor({
          origin,
          operations: ["knowledge.apply"],
          dispatchId: envelope.dispatchId,
          binding: BINDING,
          effect: {
            effectKey: (envelope.effect as NonNullable<OperationEnvelope["effect"]>).effectKey,
            boundEffectDigest: (envelope.effect as NonNullable<OperationEnvelope["effect"]>).boundEffectDigest,
          },
        }),
      );
    const lookupToken = (effectKey: string, bound: string) =>
      signCredential(
        key,
        claimsFor({
          origin: { ...recoveryOriginFor(TENANT, "recovery-wi05", INSTALLATION), applicationId: "biotech" },
          operations: ["receipt.get"],
          dispatchId: `dispatch-lookup-${randomUUID()}`,
          binding: BINDING,
          recovery: { scope: "read_only", authorityRef: "recovery-wi05", effectKey, boundEffectDigest: bound },
        }),
      );
    const lookup = (effectKey: string, bound: string) => {
      const { out } = ks({ step: "receipt", token: lookupToken(effectKey, bound), effectKey });
      if (out?.answer === undefined) throw new Error(`receipt.get refused: ${JSON.stringify(out?.refusal)}`);
      return ReceiptLookupSchema.parse(out.answer);
    };
    const rows = (effectKey: string) =>
      owner(async (c) => {
        const q = async (sql: string) => Number((await c.query<{ n: number }>(sql, [TENANT, effectKey])).rows[0]?.n);
        return {
          journal: await q(
            "select count(*)::int n from knowledge_verification.effect_dispatch where tenant_id = $1 and effect_key = $2",
          ),
          commit: await q(
            "select count(*)::int n from knowledge_verification.effect_commit where tenant_id = $1 and effect_key = $2",
          ),
          outbox: await q(
            "select count(*)::int n from knowledge_verification.dispatch_outbox where tenant_id = $1 and effect_key = $2",
          ),
          protocol: await q(
            "select count(*)::int n from knowledge_verification.protocol_receipt where tenant_id = $1 and effect_key = $2",
          ),
        };
      });
    const outboxState = (effectKey: string) =>
      owner(
        async (c) =>
          (
            await c.query<{ state: string; ack_digest: string | null; expected_marker_digest: string | null }>(
              "select state, ack_digest, expected_marker_digest from knowledge_verification.dispatch_outbox where tenant_id = $1 and effect_key = $2",
              [TENANT, effectKey],
            )
          ).rows,
      );

    beforeAll(async () => {
      const admin = new Client({ connectionString: ADMIN });
      await admin.connect();
      await admin.query(`create database ${database}`);
      await admin.query(
        `create role ${outboxRole} login password '${rolePassword}' in role knowledge_verification_outbox_worker`,
      );
      await admin.end();
      const installed = await install(loadComponent(), {
        adminDsn: dsn(),
        installationId: INSTALLATION,
        applicationId: "biotech",
        binding: BINDING,
      });
      expect(installed.componentVersion).toBe("2.5.0");
      // A sealed verification run with one frozen report revision (kind pinned), seeded as the owner.
      const { privateKey, publicKey } = generateKeyPairSync("ed25519");
      const keyId = `wi05-${randomBytes(3).toString("hex")}`;
      runId = await owner(async (c) => {
        const spki = publicKey.export({ format: "der", type: "spki" });
        await c.query(
          "insert into knowledge_verification.seal_signing_key (key_id, algorithm, public_key, issuer) values ($1, 'Ed25519', $2, 'knowledge-services')",
          [keyId, Buffer.from(spki.subarray(spki.length - 32))],
        );
        const seedOrigin = digestCanonical({ seed: TENANT });
        await c.query(
          `insert into knowledge_verification.origin (tenant_id, origin_digest, kind, installation_id, application_id, issuer, subject, identity)
         values ($1, $2, 'standalone', $3, 'biotech', 'ks', 'seed', '{}'::jsonb)`,
          [TENANT, seedOrigin, INSTALLATION],
        );
        await c.query(
          `insert into knowledge_verification.verification_task (tenant_id, task_id, schema_version, task_digest, original_task_ref, use_name, audience, minimum_risk, rubric_ref, policy_ref, body)
         values ($1, 'task-wi05', 'research-core.task.v2', $2, '{}'::jsonb, 'official.publication', 'biotech-public', 'medium', 'rubric/wi05@1', 'policy/wi05@1', '{}'::jsonb)`,
          [TENANT, digest("task-wi05")],
        );
        const id = String(
          (
            await c.query<{ run_id: string }>(
              "insert into knowledge_verification.verification_run (tenant_id, task_id, binding, originating_origin_digest) values ($1, 'task-wi05', 'biotech-graph', $2) returning run_id::text",
              [TENANT, seedOrigin],
            )
          ).rows[0]?.run_id,
        );
        const parts = { structured: '{"sections":[]}', body: "# WI-05 report\n", ledger: '{"occurrences":[]}' };
        for (const [part, content] of Object.entries(parts)) {
          await c.query(
            "insert into knowledge_verification.artifact_custody (tenant_id, artifact_id, digest, byte_length, media_type, custody_kind, inline_bytes) values ($1, $2, $3, $4, 'text/plain', 'inline', $5)",
            [TENANT, `${part}-wi05`, digest(content), Buffer.byteLength(content), Buffer.from(content)],
          );
        }
        const kind = {
          kind: "report_kind",
          id: "evidence_report@1.0.0",
          version: "research-report-kind.v1",
          digest: digest("kind"),
          tenant: TENANT,
          binding: BINDING,
        };
        await c.query(
          `insert into knowledge_verification.report_revision (tenant_id, report_revision_id, report_id, revision, schema_version, report_kind, task_id, run_id,
           structured_body_artifact_id, body_artifact_id, ledger_artifact_id, body_digest, renderer_version, assertion_refs, time_coverage, record, digest)
         values ($1, 'rr-wi05', 'report-wi05', 1, 'research-report.v2', 'evidence_report', 'task-wi05', $2::uuid, 'structured-wi05', 'body-wi05', 'ledger-wi05', $3, 'r', '[]'::jsonb, '{}'::jsonb, $4::jsonb, $5)`,
          [TENANT, id, digest(parts.body), JSON.stringify({ kind }), digest("rr-wi05")],
        );
        const manifest = { snapshot: "verification_snapshot", run: { id }, predecessor: null };
        const manifestDigest = digestCanonical(manifest);
        const context = { manifestDigest, signer: "ks-sealer", signedAt: "2026-10-27T00:00:00Z", keyId };
        await c.query(
          "select * from knowledge_verification.seal_run($1, $2::uuid, null, 'verification_snapshot', $3::jsonb, $4, $5::jsonb, 'ks-sealer', 'Ed25519', $6, $7, $8::jsonb)",
          [
            TENANT,
            id,
            JSON.stringify(manifest),
            manifestDigest,
            JSON.stringify({
              capture: digest("c"),
              claims: digest("cl"),
              report: digest("r"),
              observations: digest("o"),
            }),
            keyId,
            sign(null, Buffer.from(JSON.stringify(context)), privateKey),
            JSON.stringify(context),
          ],
        );
        return id;
      });
      frozen = {
        reportRevisionId: "rr-wi05",
        reportKind: biotechReportKind("evidence_report@1.0.0"),
        reportKindRef: "evidence_report@1.0.0",
        reportSchema: "research-report.v2",
        bodyDigest: digest("# WI-05 report\n"),
        ledgerDigest: digest('{"occurrences":[]}'),
        structuredBodyDigest: digest('{"sections":[]}'),
      };
      expect(bks({ step: "prepare" }).out).toMatchObject({ prepared: true });
    }, 240_000);

    afterAll(async () => {
      const admin = new Client({ connectionString: ADMIN });
      await admin.connect();
      await admin.query(`drop database if exists ${database} with (force)`);
      await admin.query(`drop role if exists ${outboxRole}`).catch(() => undefined);
      await admin.end();
      rmSync(work, { recursive: true, force: true });
    });

    it("crash after the SQL commit, then after the graph commit: fresh processes recover the original receipt and the graph holds the effect once", async () => {
      const x = await prepared("crash");
      // 1. Process A commits the admission + outbox enqueue and dies before the K01 protocol receipt.
      const crashed = ks({
        step: "invoke",
        envelope: x.envelope,
        token: tokenFor(x.envelope),
        crash: "before_protocol_receipt",
      });
      expect(crashed.killed).toBe(true);
      expect(await rows(x.effectKey)).toEqual({ journal: 1, commit: 1, outbox: 1, protocol: 0 });
      // 2. Process B (fresh) retransmits (new dispatch id): it answers the ORIGINAL caller/effect receipt, rebuilt from
      //    the journal and the outbox row read back; nothing is admitted or enqueued again.
      const retry = { ...x.envelope, dispatchId: `dispatch-${randomUUID()}` };
      const receipt = OperationReceiptSchema.parse(
        ks({ step: "invoke", envelope: retry, token: tokenFor(retry) }).out?.answer,
      );
      expect(receipt.outcome).toBe("pending_dispatch");
      expect(receipt.effect).toMatchObject({
        dispatchId: x.envelope.dispatchId,
        envelopeDigest: envelopeDigest(x.envelope),
        dispatchSequence: 1,
        currentCallerOrigin: origin,
      });
      // Process C (fresh, read-only recovery) answers the same recorded receipt with its composed delivery.
      const found = lookup(x.effectKey, x.bound);
      expect(found.disposition === "found" && found.receipt).toEqual(receipt);
      expect(found.disposition === "found" && found.delivery?.state).toBe("pending");
      // Changed bytes under the committed effect key refuse EFFECT_CONFLICT.
      const changed = await prepared("crash-changed");
      const forged = {
        ...changed.envelope,
        effect: { ...(changed.envelope.effect as NonNullable<OperationEnvelope["effect"]>), effectKey: x.effectKey },
      };
      expect(ks({ step: "invoke", envelope: forged, token: tokenFor(forged) }).out?.refusal).toMatchObject({
        code: "EFFECT_CONFLICT",
      });
      expect(await rows(x.effectKey)).toEqual({ journal: 1, commit: 1, outbox: 1, protocol: 1 });

      // 3. The real BKS consumer applies effect + marker in one Neo4j transaction and dies before the PostgreSQL ack.
      const graphCrash = bks({ step: "consume", crash: "after_graph_commit" });
      expect(graphCrash.killed).toBe(true);
      expect(bks({ step: "marker", effectKey: x.effectKey }).out).toMatchObject({
        found: true,
        status: "applied",
        markers: 1,
      });
      expect((await outboxState(x.effectKey))[0]?.state).toBe("dispatched");
      const beforeAck = lookup(x.effectKey, x.bound);
      expect(beforeAck.disposition === "found" && beforeAck.delivery?.state).toBe("dispatched");

      // 4. A fresh consumer finds the marker, never applies again, and acknowledges with the expected marker digest.
      const resumed = bks({ step: "consume", clockOffsetMs: 61_000 }).out as {
        results: { outcome: string; acknowledged: boolean }[];
      };
      expect(resumed.results).toEqual([expect.objectContaining({ outcome: "duplicate", acknowledged: true })]);
      // Duplicate acknowledgment: another trigger claims nothing; the acknowledged row is unchanged.
      expect((bks({ step: "consume", clockOffsetMs: 122_000 }).out as { results: unknown[] }).results).toEqual([]);
      const [acked] = await outboxState(x.effectKey);
      expect(acked?.state).toBe("acknowledged");
      expect(acked?.ack_digest).toBe(acked?.expected_marker_digest);
      // Separate native readback: exactly one marker, one Activity and one Report for the effect.
      expect(bks({ step: "marker", effectKey: x.effectKey }).out).toMatchObject({
        found: true,
        status: "applied",
        markers: 1,
        activities: 1,
        reports: 1,
      });
      const settled = lookup(x.effectKey, x.bound);
      expect(settled.disposition === "found" && settled.delivery?.state).toBe("applied");
      expect(settled.disposition === "found" && settled.receipt).toEqual(receipt);
      expect(await rows(x.effectKey)).toEqual({ journal: 1, commit: 1, outbox: 1, protocol: 1 });
    }, 600_000);

    it("revocation before dispatch: a stopped dispatch is never written to the graph and reads revoked", async () => {
      const x = await prepared("revoked-before");
      const receipt = OperationReceiptSchema.parse(
        ks({ step: "invoke", envelope: x.envelope, token: tokenFor(x.envelope) }).out?.answer,
      );
      expect(receipt.outcome).toBe("pending_dispatch");
      await owner((c) =>
        c.query("select knowledge_verification.revoke_pending_dispatches($1, $2)", [TENANT, x.effectKey]),
      );
      const claimed = (bks({ step: "consume" }).out as { results: { dispatchId: string }[] }).results;
      expect(claimed.filter((r) => r.dispatchId === receipt.nativeReceiptRef.id)).toEqual([]);
      expect(bks({ step: "marker", effectKey: x.effectKey }).out).toMatchObject({
        found: false,
        markers: 0,
        reports: 0,
      });
      const read = lookup(x.effectKey, x.bound);
      expect(read.disposition === "found" && read.delivery?.state).toBe("revoked");
    }, 300_000);

    it("revocation during the acknowledgment: the committed graph effect stays, the dispatch reads revoked, nothing re-applies", async () => {
      const x = await prepared("revoked-ack");
      ks({ step: "invoke", envelope: x.envelope, token: tokenFor(x.envelope) });
      const consumed = bks({ step: "consume", revokeDuringAck: true, effectKey: x.effectKey }).out as {
        results: { outcome: string }[];
      };
      expect(consumed.results).toEqual([expect.objectContaining({ outcome: "revoked" })]);
      expect((await outboxState(x.effectKey))[0]?.state).toBe("revoked");
      // Never rewritten as not-happened: the marker stays (official reads exclude a revoked dispatch).
      const graph = bks({ step: "marker", effectKey: x.effectKey }).out;
      expect(graph).toMatchObject({ found: true, markers: 1, activities: 1 });
      const read = lookup(x.effectKey, x.bound);
      expect(read.disposition === "found" && read.delivery?.state).toBe("revoked");
      // A later trigger claims nothing for it and the graph is unchanged (no second native write).
      const later = (bks({ step: "consume", clockOffsetMs: 61_000 }).out as { results: { dispatchId: string }[] })
        .results;
      const outboxDispatch = read.disposition === "found" ? read.receipt.nativeReceiptRef.id : null;
      expect(later.filter((r) => r.dispatchId === outboxDispatch)).toEqual([]);
      expect(bks({ step: "marker", effectKey: x.effectKey }).out).toEqual(graph);
    }, 300_000);

    it("rollback: a stale decision rolls the native transaction back; the journaled dispatch has no commit and reads not_found", async () => {
      const x = await prepared("rollback");
      await owner(async (c) => {
        const inv = await c.query<{ invalidation_id: string }>(
          "select invalidation_id::text from knowledge_verification.record_invalidation($1, 'fragment', $2, 'unrelated correction')",
          [TENANT, `frag-wi05-${randomUUID()}`],
        );
        await c.query(
          "update knowledge_verification.invalidation set closure_processed_at = now() where invalidation_id = $1::uuid",
          [inv.rows[0]?.invalidation_id],
        );
      });
      const refused = ks({ step: "invoke", envelope: x.envelope, token: tokenFor(x.envelope) }).out?.refusal;
      expect(refused).toMatchObject({ code: "STALE_DECISION" });
      expect(await rows(x.effectKey)).toEqual({ journal: 1, commit: 0, outbox: 0, protocol: 0 });
      expect(lookup(x.effectKey, x.bound).disposition).toBe("not_found");
    }, 300_000);

    it("reordered protocol acknowledgments: N held after its SQL commit, N+1 records first, N's late ack answers the same receipt", async () => {
      const x = await prepared("reordered");
      const original = await startHeld("ks-operation-driver.ts", {
        binding: BINDING,
        installationId: INSTALLATION,
        tenants: [TENANT],
        jwks: jwksOf([key]),
        step: "invoke",
        envelope: x.envelope,
        token: tokenFor(x.envelope),
      });
      expect(await rows(x.effectKey)).toEqual({ journal: 1, commit: 1, outbox: 1, protocol: 0 });
      // N+1 (another process) acknowledges first: the original dispatch's receipt, rebuilt and recorded.
      const next = { ...x.envelope, dispatchId: `dispatch-${randomUUID()}` };
      const first = OperationReceiptSchema.parse(
        ks({ step: "invoke", envelope: next, token: tokenFor(next) }).out?.answer,
      );
      expect(first.effect.dispatchId).toBe(x.envelope.dispatchId);
      // N's acknowledgment lands late: first writer wins, it answers the same recorded receipt.
      original.release();
      const late = OperationReceiptSchema.parse((await original.done).answer);
      expect(late).toEqual(first);
      expect(await rows(x.effectKey)).toEqual({ journal: 1, commit: 1, outbox: 1, protocol: 1 });
    }, 300_000);

    it("two genuinely concurrent different-bytes applies of one key (two processes): one commits, the other refuses EFFECT_CONFLICT", async () => {
      const a = await prepared("concurrent-a");
      const b = await prepared("concurrent-b");
      // b's bytes (and its own admitted decision) under a's effect key: the same key, other bound bytes.
      const forged = {
        ...b.envelope,
        effect: { ...(b.envelope.effect as NonNullable<OperationEnvelope["effect"]>), effectKey: a.effectKey },
      };
      const [first, second] = await Promise.all([
        ksAsync({ step: "invoke", envelope: a.envelope, token: tokenFor(a.envelope) }),
        ksAsync({ step: "invoke", envelope: forged, token: tokenFor(forged) }),
      ]);
      const answers = [first, second];
      const receipts = answers.filter((answer) => answer.answer !== undefined);
      const refusals = answers.filter((answer) => answer.refusal !== undefined);
      expect(receipts).toHaveLength(1);
      expect(refusals).toEqual([
        expect.objectContaining({
          refusal: expect.objectContaining({
            code: "EFFECT_CONFLICT",
            details: expect.objectContaining({ dispatch: "not_journaled" }),
          }),
        }),
      ]);
      const winner = OperationReceiptSchema.parse(receipts[0]?.answer);
      expect([a.bound, b.bound]).toContain(winner.effect.boundEffectDigest);
      // One native commit, one outbox row, one protocol receipt for the key; the loser rolled back.
      expect(await rows(a.effectKey)).toMatchObject({ commit: 1, outbox: 1, protocol: 1 });
    }, 300_000);
  },
);
