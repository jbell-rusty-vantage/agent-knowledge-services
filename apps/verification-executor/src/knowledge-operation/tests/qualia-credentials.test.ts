import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { ReportKindCatalog } from "@aiengineer/knowledge-application";
import {
  DispatchRegistry,
  JwksCache,
  KnowledgeCredentialVerifier,
  KnowledgeOperationService,
  authorize,
  createInMemoryBackend,
  staticJwksSource,
} from "@aiengineer/knowledge-host/knowledge-operation";
import { type OperationName, type Origin, digestCanonical } from "@aiengineer/knowledge-operation-protocol";
import { recordRef } from "@aiengineer/knowledge-research-core";
import { supportObservation } from "@aiengineer/knowledge-research-core/testing";
import { handleKnowledgeOperation } from "../http.js";
import { qualiaCredential, qualiaRoles } from "./qualia-credentials.js";
import { prepareQualiaReport } from "./qualia-report.js";
import {
  claimsFor,
  envelopeFor,
  generateIssuerKey,
  jwksOf,
  signCredential,
  TEST_AUDIENCE,
  TEST_ISSUER,
} from "./test-support.js";

const producer: Origin = {
  kind: "standalone",
  installationId: "01a103c0-9a9e-7a95-961b-29dda83c842b",
  applicationId: "biotech",
  tenantId: "synthetic-auth-tenant",
  issuer: TEST_ISSUER,
  subject: "synthetic-auth-producer",
  mission: null,
  recoveryAuthorityRef: null,
  invocationId: "synthetic-auth-invocation",
  authenticatedAt: "2026-10-30T00:00:00Z",
};
const roles = qualiaRoles(producer);
const installed = [
  {
    application: "biotech",
    binding: "biotech-graph",
    installationId: producer.installationId,
    tenants: [producer.tenantId],
  },
];
function verifier(key: ReturnType<typeof generateIssuerKey>) {
  return new KnowledgeCredentialVerifier({
    issuer: TEST_ISSUER,
    audience: TEST_AUDIENCE,
    jwks: new JwksCache(staticJwksSource(jwksOf([key]))),
  });
}

test("complete judge/auditor observe grants validate before signing and survive the actual JWT authorization pipeline", async () => {
  const key = generateIssuerKey("synthetic-qualia-credential");
  const auth = verifier(key);
  for (const actor of ["judge", "auditor"] as const) {
    const minted = qualiaCredential({
      key,
      roles,
      actor,
      operations: ["report.observe"],
      dispatchId: `synthetic-${actor}-observe`,
    });
    const claims = await auth.verify(minted.token);
    assert.deepEqual(claims, minted.claims);
    assert.equal(claims.evaluation?.role, actor);
    assert.equal(claims.origin.subject, roles[actor].subject);
    assert.notEqual(claims.origin.subject, producer.subject);
    assert.equal(claims.evaluation?.provider, "openai");
    assert.equal(claims.evaluation?.family, "gpt-6.1");
    const scope = authorize(claims, installed, {
      operation: "report.observe",
      envelope: {
        tenant: producer.tenantId,
        application: "biotech",
        binding: "biotech-graph",
        dispatchId: minted.claims.dispatchId,
        effect: null,
      },
    });
    assert.equal(scope.origin.subject, roles[actor].subject);
    assert.deepEqual(scope.grants, ["report.observe"]);
    await assert.rejects(auth.verify(minted.token), /replay/);
    assert.throws(
      () => authorize(claims, installed, { operation: "knowledge.apply", envelope: null }),
      /does not grant/,
    );
    assert.throws(
      () =>
        authorize(claims, installed, {
          operation: "report.observe",
          envelope: {
            tenant: producer.tenantId,
            application: "biotech",
            binding: "biotech-graph",
            dispatchId: "wrong-dispatch",
            effect: null,
          },
        }),
      /dispatch id/,
    );
  }
  assert.notEqual(roles.judge.subject, roles.auditor.subject);
});

test("producer observe, evaluator writes/review and forged identity remain refused", async () => {
  const key = generateIssuerKey("synthetic-negative-credential");
  assert.throws(
    () =>
      qualiaCredential({
        key,
        roles,
        actor: "producer",
        operations: ["report.observe"],
        dispatchId: "producer-observe",
      }),
    /evaluator grant/,
  );
  for (const operation of ["report.register", "knowledge.apply", "report.review"] as const) {
    assert.throws(() =>
      qualiaCredential({
        key,
        roles,
        actor: "judge",
        operations: [operation],
        dispatchId: `judge-${operation}`,
        effect:
          operation === "knowledge.apply"
            ? { effectKey: "test-effect", boundEffectDigest: digestCanonical({ synthetic: true }) }
            : null,
      }),
    );
  }
  assert.throws(
    () =>
      qualiaCredential({
        key,
        roles: { ...roles, judge: producer },
        actor: "judge",
        operations: ["report.observe"],
        dispatchId: "forged-identity",
      }),
    /own authenticated/,
  );
  const valid = qualiaCredential({
    key,
    roles,
    actor: "judge",
    operations: ["report.observe"],
    dispatchId: "missing-role",
  });
  const { evaluation: _evaluation, ...withoutGrant } = valid.claims;
  await assert.rejects(verifier(key).verify(signCredential(key, withoutGrant)), /claims_invalid/);
});

test("the runnable host credential helper reaches real HTTP report.observe and enforces producer independence", async () => {
  const key = generateIssuerKey("synthetic-loopback-observe");
  const backend = createInMemoryBackend({
    application: "biotech",
    binding: "biotech-graph",
    kinds: ReportKindCatalog.fromDirectory(
      resolve(import.meta.dirname, "../../../../../catalog/research/report-kinds"),
    ),
    auditor: null,
  });
  const research = backend.research();
  const scope = {
    tenant: producer.tenantId,
    application: "biotech",
    binding: "biotech-graph",
    origin: producer,
    grants: [],
  };
  const service = new KnowledgeOperationService({
    verifier: verifier(key),
    backends: [backend],
    installed,
    dispatches: new DispatchRegistry(),
    signingIssuer: "synthetic-offline-host",
  });
  const server = createServer((request, response) => {
    void handleKnowledgeOperation(request, response, new URL(request.url ?? "/", "http://localhost"), service);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/knowledge-operation/v2`;
  let sequence = 0;
  async function http(
    actor: "producer" | "judge" | "auditor",
    path: string,
    operation: OperationName,
    body?: unknown,
    overrideToken?: string,
  ) {
    const dispatchId =
      body && typeof body === "object" && "dispatchId" in body
        ? String(body.dispatchId)
        : `synthetic-http-${sequence++}`;
    const effect =
      body && typeof body === "object" && "effect" in body
        ? (body.effect as { effectKey: string; boundEffectDigest: string } | null)
        : null;
    const token =
      overrideToken ?? qualiaCredential({ key, roles, actor, operations: [operation], dispatchId, effect }).token;
    const result = await fetch(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: result.status, document: (await result.json()) as Record<string, any> };
  }
  async function invoke(
    actor: "producer" | "judge",
    operation: OperationName,
    payload: unknown,
    nativeContract: { name: string; version: string },
    overrideToken?: (dispatchId: string) => string,
  ) {
    const envelope = envelopeFor({
      operation,
      origin: roles[actor],
      binding: "biotech-graph",
      payload: payload as any,
      nativeContract,
      requestId: `synthetic-request-${sequence++}`,
    });
    const response = await http(actor, "/invoke", operation, envelope, overrideToken?.(envelope.dispatchId));
    assert.ok(response.status >= 200 && response.status < 300, JSON.stringify(response.document));
    if (typeof response.document.operationId !== "string") return response.document;
    await service.settled();
    const status = await http(
      actor,
      `/operations/${encodeURIComponent(response.document.operationId)}`,
      "operation.get",
    );
    assert.equal(status.status, 200);
    const ref = status.document.resultRef;
    assert.ok(ref, JSON.stringify(status.document));
    const result = await http(
      actor,
      `/artifacts/${encodeURIComponent(ref.id)}?digest=${encodeURIComponent(ref.digest)}`,
      "knowledge.read",
    );
    return result.document;
  }
  try {
    const text = "Synthetic credential fixture source reports cellulose.";
    const put = (bytes: Uint8Array, mediaType: string) => research.binding.custody.put(scope, bytes, mediaType);
    const registration = await prepareQualiaReport({
      authored: {
        id: "synthetic-auth-report",
        title: "Offline authorization test",
        summary: "Synthetic test only",
        claims: [
          {
            id: "cellulose",
            statement: "The synthetic source reports cellulose.",
            sourceUrl: "https://fixtures.bks.test/auth",
            quote: text,
            qualifiers: { negation: false },
          },
        ],
        limitations: ["Synthetic local test, no model or remote service."],
      },
      sources: [
        {
          url: "https://fixtures.bks.test/auth",
          text,
          ref: await put(Buffer.from(text), "text/plain"),
          retrievedAt: "2026-10-30T00:00:00Z",
        },
      ],
      origin: producer,
      put,
    });
    const registered = await invoke("producer", "report.register", registration, {
      name: "research-report",
      version: "v2",
    });
    const report = registered.nativeReceiptRef;
    assert.equal(report.kind, "report");
    const set = registration.supportSets[0]!,
      assertion = registration.assertions[0]!;
    const synthetic = supportObservation({
      id: "synthetic-offline-observation",
      set,
      target: assertion,
      verdict: "full_support",
    });
    assert.equal(synthetic.property, "support");
    if (synthetic.property !== "support") throw new Error("Expected support fixture");
    const fragment = recordRef("fragment", registration.fragments[0]!);
    const observation = {
      ...synthetic,
      tenant: producer.tenantId,
      binding: "biotech-graph",
      evidence: [fragment],
      method: { ...synthetic.method, tenant: producer.tenantId, binding: "biotech-graph" },
      evaluator: {
        ...synthetic.evaluator,
        provider: "openai",
        family: "gpt-6.1",
        model: "synthetic-offline-credential-test",
      },
      usage: { providerCalls: 0, tokens: 0, costUsd: "0" },
      outcome: { ...synthetic.outcome, citedFragments: [fragment] },
    };
    const payload = { schema: "report-observation.v1", report, observations: [observation], census: null };
    const accepted = await invoke("judge", "report.observe", payload, { name: "report-observation", version: "v1" });
    assert.ok(accepted, "actual K01 observe completed without a model call");
    const runId = await research.locator.runOf(scope, report);
    assert.ok(runId);
    const context = await research.binding.loadRunContext(scope, runId);
    assert.ok(context.observations.some((stored) => stored.id === observation.id));
    const invalidEnvelope = envelopeFor({
      operation: "report.observe",
      origin: producer,
      binding: "biotech-graph",
      payload: payload as any,
      nativeContract: { name: "report-observation", version: "v1" },
      requestId: "synthetic-producer-cannot-judge",
    });
    const invalidToken = signCredential(
      key,
      claimsFor({
        origin: producer,
        operations: ["report.observe"],
        binding: "biotech-graph",
        dispatchId: invalidEnvelope.dispatchId,
        evaluation: {
          role: "judge",
          credentialRef: "synthetic-forged-independent",
          provider: "openai",
          family: "gpt-6.1",
        },
      }),
    );
    const invalid = await http("producer", "/invoke", "report.observe", invalidEnvelope, invalidToken);
    assert.ok(invalid.status >= 400);
    assert.equal(invalid.document.code, "INDEPENDENCE_UNPROVEN");
  } finally {
    await service.settled();
    await new Promise<void>((done, reject) => server.close((error) => (error ? reject(error) : done())));
    await backend.close();
  }
});
