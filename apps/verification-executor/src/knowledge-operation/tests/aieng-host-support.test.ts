import assert from "node:assert/strict";
import test from "node:test";
import type { Origin } from "@aiengineer/knowledge-operation-protocol";
import {
  checkMigrationHead,
  credentialSource,
  evaluatorBase,
  mergeJwks,
  parseHostConfig,
  producerOf,
} from "./aieng-host-support.js";
import { qualiaCredential, qualiaRoles } from "./qualia-credentials.js";
import { claimsFor, generateIssuerKey, jwksOf, signCredential } from "./test-support.js";

const startup: Origin = {
  kind: "standalone",
  installationId: "0192a4f0-0000-7000-8000-0000000a1e11",
  applicationId: "ai-engineer",
  tenantId: "9287e246-224b-5814-bc00-44bb5396e0c5",
  issuer: "mission-control",
  subject: "mission-control-runtime",
  mission: null,
  recoveryAuthorityRef: null,
  invocationId: "aieng-stagegraph-startup",
  authenticatedAt: "2026-10-31T00:00:00Z",
};
const wire: Origin = {
  ...startup,
  kind: "mission_invocation",
  mission: {
    missionId: "0192a4f0-0000-7000-8000-00000000a001",
    runId: "run-located",
    activationId: "0192a4f0-0000-7000-8000-00000000ac71",
    operationId: "ingest",
    operationAttempt: 2,
    executionGeneration: 1,
    lane: "deep_agents",
  },
  invocationId: "inv-mc-1",
};
const config = {
  origin: startup,
  jwksPath: "C:/tmp/jwks.json",
  issuer: "mission-control",
  audience: "knowledge-services-executor",
  evidenceRoot: "C:/tmp/e",
  workspaceDir: "C:/tmp/w",
};

test("config requires MC's JWKS, issuer and audience and refuses the retired producer keyPath", () => {
  assert.equal(parseHostConfig(config).migrationHead, null);
  assert.equal(parseHostConfig({ ...config, migrationHead: "20261031010000" }).migrationHead, "20261031010000");
  assert.throws(() => parseHostConfig({ ...config, jwksPath: undefined }), /jwksPath/);
  assert.throws(() => parseHostConfig({ ...config, keyPath: "k.json" }), /keyPath/);
  assert.throws(() => parseHostConfig({ ...config, issuer: "other" }), /issuer/);
  assert.throws(() => parseHostConfig({ ...config, migrationHead: "head" }), /migrationHead/);
});

test("the head check accepts a configured head or the workspace head, never a mismatch", () => {
  assert.equal(
    checkMigrationHead({ database: "20261025010200", workspace: "20261025010200" }).workspaceTracksDatabase,
    true,
  );
  const advanced = checkMigrationHead({
    database: "20261031010000",
    workspace: "20261025010200",
    configured: "20261031010000",
  });
  assert.equal(advanced.expected, "20261031010000");
  assert.equal(advanced.workspaceTracksDatabase, false);
  assert.throws(() => checkMigrationHead({ database: "20261031010000", workspace: "20261025010200" }), /workspace/);
  assert.throws(
    () => checkMigrationHead({ database: "20261025010200", workspace: "20261025010200", configured: "20261031010000" }),
    /configured/,
  );
});

test("one JWKS holds MC's keys and the host evaluator key; colliding or empty sets are refused", () => {
  const mc = generateIssuerKey("mc-k1");
  const host = generateIssuerKey("aieng-host-evaluator-1");
  const merged = mergeJwks(jwksOf([mc]), jwksOf([host]).keys[0]!);
  assert.deepEqual(merged.mcKids, ["mc-k1"]);
  assert.deepEqual(
    merged.document.keys.map((key) => key.kid),
    ["mc-k1", "aieng-host-evaluator-1"],
  );
  assert.throws(() => mergeJwks(jwksOf([mc]), jwksOf([mc]).keys[0]!), /collides/);
  assert.throws(() => mergeJwks({ keys: [] }, jwksOf([host]).keys[0]!), /no key/);
});

test("served calls are attributed to the signing key: MC producer vs host evaluator", () => {
  const mc = generateIssuerKey("mc-k1");
  const hostKey = generateIssuerKey("aieng-host-evaluator-1");
  const keys = { mcKids: new Set(["mc-k1"]), hostKid: "aieng-host-evaluator-1" };
  const produced = signCredential(
    mc,
    claimsFor({
      origin: wire,
      binding: "aiengineer-postgres",
      operations: ["knowledge.apply"],
      dispatchId: "d-1",
      effect: { effectKey: "k", boundEffectDigest: `sha256:${"0".repeat(64)}` },
    }),
  );
  const fromMc = credentialSource(`Bearer ${produced}`, keys);
  assert.equal(fromMc.minter, "mission-control");
  assert.equal(fromMc.originKind, "mission_invocation");
  assert.equal(fromMc.mission?.missionId, wire.mission!.missionId);
  assert.deepEqual(fromMc.operations, ["knowledge.apply"]);

  const roles = { ...qualiaRoles(evaluatorBase(startup, "aieng-fixture-host")), producer: startup };
  const judged = qualiaCredential({
    key: hostKey,
    roles,
    actor: "judge",
    operations: ["report.observe"],
    dispatchId: "d-2",
    binding: "aiengineer-postgres",
    issuer: "mission-control",
    audience: "knowledge-services-executor",
  });
  assert.equal(judged.claims.aud, "knowledge-services-executor");
  const fromHost = credentialSource(`Bearer ${judged.token}`, keys);
  assert.equal(fromHost.minter, "host");
  assert.equal(fromHost.originKind, "standalone");
  assert.equal(fromHost.evaluationRole, "judge");
  assert.equal(fromHost.sub, "aieng-fixture-host-judge");
  assert.notEqual(roles.judge.subject, roles.auditor.subject);
  assert.notEqual(roles.judge.subject, wire.subject);

  assert.equal(credentialSource(undefined, keys).minter, "none");
  assert.equal(credentialSource(`Bearer ${signCredential(generateIssuerKey("x"), { a: 1 })}`, keys).minter, "unknown");
});

test("the producer is only an MC mission_invocation origin of this tenant, installation and issuer", () => {
  const expected = { tenantId: startup.tenantId, installationId: startup.installationId, issuer: "mission-control" };
  const producer = producerOf(wire, expected);
  assert.equal(producer.missionId, wire.mission!.missionId);
  assert.equal(producer.attempt, 2);
  assert.throws(() => producerOf(startup, expected), /mission_invocation/);
  assert.throws(() => producerOf({ ...wire, tenantId: "11111111-1111-4111-8111-111111111111" }, expected), /another/);
  assert.throws(() => producerOf({ ...wire, issuer: "aieng-fixture-host" }, expected), /another/);
});
