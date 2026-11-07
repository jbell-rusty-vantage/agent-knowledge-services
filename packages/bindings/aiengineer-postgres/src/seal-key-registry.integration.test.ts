import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Ed25519SealSigner,
  ReportKindCatalog,
  ResearchCoordinator,
  SealKeyRegistryError,
  StaticSealVerifier,
} from "@aiengineer/knowledge-application";
import {
  AT,
  fixtureAssertion,
  fixtureBody,
  fixtureFragment,
  fixtureOrigin,
  fixtureSupportObservation,
  fixtureSupportSet,
  fixtureTask,
} from "@aiengineer/knowledge-application/testing";
import { install, loadComponent, registerSealKey } from "@aiengineer/knowledge-db-contract";
import { type AuthScope, qualifiersDigest, recordRef } from "@aiengineer/knowledge-research-core";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ComponentDatabase } from "./client.js";
import { PostgresResearchBinding } from "./research-binding.js";

/**
 * OVE-169 W1 D25 on a disposable PostgreSQL 17 (`KS_AIENG_DB_ADMIN_DSN`; skips without it): the executor's
 * seal key is not in `knowledge_verification.seal_signing_key` (the state of both remotes), so the seal refuses typed
 * (`SEAL_KEY_UNREGISTERED` naming the key id, never an untyped component `SEAL_INVALID`); the key ceremony
 * (`knowledge-db seal-key` = `registerSealKey`, the installers' `seal-key` step) pins the PUBLIC half derived from the
 * executor's PEM, is `current` on repeat, refuses another key under the same id, retires an earlier key; then the
 * exact same seal succeeds.
 */
const ADMIN = process.env.KS_AIENG_DB_ADMIN_DSN;
const describeDb = ADMIN ? describe : describe.skip;
const TENANT = "00000000-0000-7000-8000-0000000000aa";
const BINDING = "aiengineer-postgres";
const KEY_ID = "ks-seal-w1-d25";

function pemKey(directory: string, name: string): string {
  const { privateKey } = generateKeyPairSync("ed25519");
  const path = join(directory, name);
  writeFileSync(path, privateKey.export({ format: "pem", type: "pkcs8" }));
  return path;
}

describeDb("seal-key registry (W1 D25)", () => {
  const database = `kvs_${randomBytes(4).toString("hex")}`;
  const keys = mkdtempSync(join(tmpdir(), "ks-seal-"));
  let db: ComponentDatabase;
  const dsn = () => {
    const url = new URL(ADMIN as string);
    url.pathname = `/${database}`;
    return url.toString();
  };

  beforeAll(async () => {
    const admin = new Client({ connectionString: ADMIN });
    await admin.connect();
    await admin.query(`create database ${database}`);
    await admin.end();
    await install(loadComponent(), {
      adminDsn: dsn(),
      installationId: "0192a4f0-0000-7000-8000-0000000a1e00",
      applicationId: "ai-engineer",
      binding: BINDING,
    });
    db = new ComponentDatabase({ connectionString: dsn() });
  });

  afterAll(async () => {
    await db?.end();
    rmSync(keys, { recursive: true, force: true });
    const admin = new Client({ connectionString: ADMIN });
    await admin.connect();
    await admin.query(`drop database if exists ${database} with (force)`);
    await admin.end();
  });

  it("refuses typed until the ceremony pins the executor's key, then the same seal succeeds", async () => {
    const keyFile = pemKey(keys, "executor-seal.pem");
    const signer = Ed25519SealSigner.fromKeyFile(KEY_ID, keyFile);
    const verifier = new StaticSealVerifier([{ keyId: KEY_ID, publicKey: signer.publicKeyRaw(), status: "active" }]);
    const origin = fixtureOrigin(TENANT);
    const scope: AuthScope = {
      tenant: TENANT,
      application: "ai-engineer",
      binding: BINDING,
      origin,
      grants: ["research.write"],
    };
    const binding = new PostgresResearchBinding(db, BINDING, { sealVerifier: verifier });
    const kinds = ReportKindCatalog.fromDirectory(
      resolve(dirname(fileURLToPath(import.meta.url)), "../../../../catalog/research/report-kinds"),
    );
    const coordinator = new ResearchCoordinator(binding, { now: () => AT }, kinds, { signer });
    const { runId } = await coordinator.openRun(scope, {
      task: fixtureTask(TENANT, BINDING),
      originatingOrigin: origin,
    });
    const fragment = fixtureFragment(TENANT, BINDING);
    const assertion = fixtureAssertion(TENANT, BINDING, origin);
    const set = fixtureSupportSet(TENANT, BINDING, assertion, fragment);
    await coordinator.registerEvidence(scope, { fragments: [fragment], assertions: [assertion], supportSets: [set] });
    await coordinator.registerReport(scope, {
      runId,
      reportId: "report-d25",
      revision: 1,
      kind: kinds.ref(scope, "evidence_report"),
      structuredBody: fixtureBody(assertion, fragment),
      assertions: [recordRef("assertion", assertion)],
      timeCoverage: { world: null, observed: { from: AT, to: AT }, knowledgeHead: null },
      supersedes: null,
    });
    await coordinator.observe(
      scope,
      runId,
      fixtureSupportObservation({
        tenant: TENANT,
        binding: BINDING,
        id: "obs-judge-d25",
        set,
        fragment,
        role: "judge",
        verdict: "full_support",
        qualifiersDigest: qualifiersDigest(assertion.qualifiers),
      }),
    );
    const seal = () =>
      coordinator.sealVerificationSnapshot(scope, {
        runId,
        build: { buildId: "build-d25", runtime: "node24", dirty: true },
        signer: "ks-sealer",
      });

    // The remotes' state: the registry is empty.
    const unregistered = await seal().catch((error: unknown) => error);
    expect(unregistered).toBeInstanceOf(SealKeyRegistryError);
    expect((unregistered as SealKeyRegistryError).code).toBe("SEAL_KEY_UNREGISTERED");
    expect((unregistered as SealKeyRegistryError).keyId).toBe(KEY_ID);

    // The ceremony: applied, then current; another key under the same id refuses; a key file never leaks.
    const applied = await registerSealKey({ adminDsn: dsn(), keyId: KEY_ID, keyFile });
    expect(applied).toMatchObject({ status: "applied", keyId: KEY_ID, registered: true, issuer: "knowledge-services" });
    expect(JSON.stringify(applied)).not.toMatch(/PRIVATE KEY/);
    expect(await registerSealKey({ adminDsn: dsn(), keyId: KEY_ID, keyFile })).toMatchObject({ status: "current" });
    await expect(
      registerSealKey({ adminDsn: dsn(), keyId: KEY_ID, keyFile: pemKey(keys, "other.pem") }),
    ).rejects.toMatchObject({ code: "SEAL_KEY_CONFLICT" });

    // The same seal now succeeds and verifies against the pinned key.
    const { sealed } = await seal();
    expect(sealed.seal.keyId).toBe(KEY_ID);

    // Rotation: a new key registers beside the old one, which retires (still verifies, signs nothing new).
    const next = await registerSealKey({
      adminDsn: dsn(),
      keyId: `${KEY_ID}-2`,
      keyFile: pemKey(keys, "next.pem"),
      retire: [KEY_ID],
    });
    expect(next).toMatchObject({ status: "applied", retired: [{ keyId: KEY_ID, status: "applied" }] });
    await expect(registerSealKey({ adminDsn: dsn(), keyId: KEY_ID, keyFile })).rejects.toMatchObject({
      code: "SEAL_KEY_NOT_ACTIVE",
    });
    await expect(
      registerSealKey({ adminDsn: dsn(), keyId: `${KEY_ID}-3`, keyFile: pemKey(keys, "third.pem"), retire: ["nope"] }),
    ).rejects.toMatchObject({ code: "SEAL_KEY_UNKNOWN" });
  });

  it("a concurrent first registration of one id is applied once, then current or a typed conflict", async () => {
    const keyFile = pemKey(keys, "race.pem");
    const same = await Promise.all(
      Array.from({ length: 4 }, () => registerSealKey({ adminDsn: dsn(), keyId: `${KEY_ID}-race`, keyFile })),
    );
    expect(same.map((receipt) => receipt.status).sort()).toEqual(["applied", "current", "current", "current"]);
    const files = [pemKey(keys, "race-a.pem"), pemKey(keys, "race-b.pem")];
    const settled = await Promise.allSettled(
      files.map((file) => registerSealKey({ adminDsn: dsn(), keyId: `${KEY_ID}-race-2`, keyFile: file })),
    );
    expect(settled.filter((item) => item.status === "fulfilled").map((item) => item.value.status)).toEqual(["applied"]);
    const rejected = settled.filter((item): item is PromiseRejectedResult => item.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ code: "SEAL_KEY_CONFLICT" });
  });
});
