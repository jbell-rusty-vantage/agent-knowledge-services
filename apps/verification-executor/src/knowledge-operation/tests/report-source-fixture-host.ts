/** Disposable host for the MC joined seam test. Stdin is the trusted test controller,
 * never a production HTTP judgment endpoint. No model/search/native provider is composed. */
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import {
  CorrectionService,
  ReportKindCatalog,
  ScriptedAuditorDiscovery,
  SourceAuthorityCatalog,
} from "@aiengineer/knowledge-application";
import {
  AT,
  FIXTURE_SEAL_KEYS,
  fixtureSupportObservation,
  fixtureScientificQualifiers,
  fixtureBody,
  fixtureSupportSet,
  fixtureEvaluator,
  fixtureRef,
  reportKindCases,
} from "@aiengineer/knowledge-application/testing";
import { createAiEngineerPostgresBackend, pinSealSigningKey } from "@aiengineer/knowledge-binding-aiengineer-postgres";
import { createBiotechGraphPostgresBackend } from "@aiengineer/knowledge-binding-biotech-graph";
import { install, loadComponent } from "@aiengineer/knowledge-db-contract";
import {
  DispatchRegistry,
  JwksCache,
  KnowledgeCredentialVerifier,
  KnowledgeOperationService,
  staticJwksSource,
} from "@aiengineer/knowledge-host/knowledge-operation";
import {
  digestBytes,
  digestCanonical,
  DigestSchema,
  type Digest,
  type Origin,
  type Ref,
  type JsonValue,
  OperationHandleSchema,
  OperationStatusSchema,
} from "@aiengineer/knowledge-operation-protocol";
import {
  type AuthScope,
  recordRef,
  qualifiersDigest,
  SCIENTIFIC_RUBRIC_VERSION,
} from "@aiengineer/knowledge-research-core";
import { Client } from "pg";
import { handleKnowledgeOperation } from "../http.js";
import { requireLoopback } from "./proof-guards.js";
import { openCapturedSourceFixture } from "./report-source-capture-fixture.js";
import {
  claimsFor,
  envelopeFor,
  generateIssuerKey,
  jwksOf,
  signCredential,
  TEST_AUDIENCE,
  TEST_ISSUER,
} from "./test-support.js";

function required<T>(value: T | undefined | null, name: string): T {
  if (value == null) throw new Error(`fixture requires ${name}`);
  return value;
}
const config = JSON.parse(readFileSync(required(process.argv[2], "config path"), "utf8")) as {
  origin: Origin;
  keyPath: string;
  captureMode?: boolean;
  evidenceRoot?: string;
};
const origin = config.origin;
const application = origin.applicationId;
if (!["ai-engineer", "biotech"].includes(application)) throw new Error("unsupported fixture application");
const binding = application === "ai-engineer" ? "aiengineer-postgres" : "biotech-graph";
const tenant = origin.tenantId;
const scope: AuthScope = { tenant, application, binding, origin, grants: [] };
const adminDsn = requireLoopback("KS_AIENG_DB_ADMIN_DSN", process.env.KS_AIENG_DB_ADMIN_DSN);
const database = `foundation_join_${randomBytes(5).toString("hex")}`;
const connection = new URL(adminDsn);
connection.pathname = `/${database}`;
const admin = new Client({ connectionString: adminDsn });
await admin.connect();
await admin.query(`create database ${database}`);
await admin.end();
const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const root = resolve(import.meta.dirname, "../../../../..");
const key = generateIssuerKey("foundation-join");
writeFileSync(config.keyPath, JSON.stringify(key.privateJwk), { mode: 0o600 });
let closeBackend: (() => Promise<void>) | undefined;
let closeServer: (() => Promise<void>) | undefined;
let closeCapture: (() => Promise<void>) | undefined;
try {
  await install(loadComponent(), {
    adminDsn: connection.toString(),
    installationId: origin.installationId,
    applicationId: application,
    binding,
  });
  await pinSealSigningKey(connection.toString(), {
    keyId: FIXTURE_SEAL_KEYS.signer.keyId,
    publicKey: FIXTURE_SEAL_KEYS.publicKey,
  });
  const correct = application === "biotech" ? "Product A label lists cellulose." : "Model X has 7B parameters.";
  const incorrect = application === "biotech" ? "Product A label lists caffeine." : "Model X has 9B parameters.";
  if (config.captureMode && application !== "ai-engineer") throw new Error("CAPTURE_FIXTURE_AI_ENGINEER_FIRST");
  const captured = config.captureMode
    ? await openCapturedSourceFixture(scope, required(config.evidenceRoot, "capture evidence root"))
    : undefined;
  closeCapture = captured?.close;
  const options = {
    application,
    binding,
    installationId: origin.installationId,
    connectionString: connection.toString(),
    kinds: ReportKindCatalog.fromDirectory(resolve(root, "catalog/research/report-kinds")),
    authority: SourceAuthorityCatalog.fromDirectory(resolve(root, "catalog/research/source-authority")),
    seal: FIXTURE_SEAL_KEYS,
    clock: { now: () => AT },
    ...(captured ? { externalCustody: captured.externalCustody } : {}),
    auditor: new ScriptedAuditorDiscovery({
      entries: [
        { quote: correct, assertionLogicalId: "model-size" },
        { quote: incorrect, assertionLogicalId: "model-size" },
      ],
    }),
  };
  const backend = await (application === "ai-engineer"
    ? createAiEngineerPostgresBackend(options)
    : createBiotechGraphPostgresBackend(options));
  closeBackend = () => backend.close();
  const service = new KnowledgeOperationService({
    verifier: new KnowledgeCredentialVerifier({
      issuer: TEST_ISSUER,
      audience: TEST_AUDIENCE,
      jwks: new JwksCache(staticJwksSource(jwksOf([key]))),
    }),
    backends: [backend],
    installed: [{ application, binding, installationId: origin.installationId, tenants: [tenant] }],
    dispatches: new DispatchRegistry(),
    signingIssuer: "foundation-join",
  });
  const server = createServer((request, response) => {
    void handleKnowledgeOperation(request, response, new URL(request.url ?? "/", "http://localhost"), service);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  closeServer = async () => {
    await service.settled();
    await new Promise<void>((done, reject) => server.close((error) => (error ? reject(error) : done())));
  };
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const research = backend.research();
  const kase = required(
    reportKindCases(tenant, binding, origin).find((item) => item.kindId === "evidence_report"),
    "evidence report case",
  );
  const baseFragment = required(kase.fragments[0], "source fragment");
  const baseAssertion = required(kase.assertions[0], "assertion");
  const task = {
    ...kase.task,
    domain: application === "biotech" ? "scientific" : "engineering",
    audience: "internal",
    use: application === "biotech" ? "label_reference.ingredients" : "engineering_reference.model_facts",
    rubric:
      application === "biotech"
        ? { ...kase.task.rubric, id: "rubric-scientific", version: SCIENTIFIC_RUBRIC_VERSION }
        : kase.task.rubric,
  };
  const capture =
    captured?.bridges[0]?.fragment.capture ??
    (await research.binding.custody.put(scope, Buffer.from(correct), "text/plain"));
  const fragment = captured?.bridges[0]?.fragment ?? {
    ...baseFragment,
    capture,
    representation: capture,
    selector: { ...baseFragment.selector, value: correct },
    selectedDigest: digestBytes(correct),
    selectedSize: Buffer.byteLength(correct),
  };
  const reports = [1, 2].map((revision) => {
    const proposition = revision === 1 ? incorrect : correct;
    const assertion = {
      ...baseAssertion,
      id: `joined-asr-${revision}`,
      proposition,
      value:
        application === "biotech"
          ? { type: "text" as const, value: revision === 1 ? "caffeine" : "cellulose" }
          : { type: "quantity" as const, amount: revision === 1 ? "9000000000" : "7000000000", unit: "parameters" },
      qualifiers:
        application === "biotech"
          ? {
              ...fixtureScientificQualifiers(),
              entity: "product-a",
              population: null,
              studyDesign: null,
              species: null,
              intervention: null,
              comparator: null,
              sampleSize: null,
            }
          : baseAssertion.qualifiers,
    };
    const support = { ...fixtureSupportSet(tenant, binding, assertion, fragment), id: `joined-set-${revision}` };
    const body = JSON.parse(
      JSON.stringify(fixtureBody(assertion, fragment))
        .replaceAll("Model X has 7B parameters.", proposition)
        .replaceAll(
          "Parameter count of Model X for official ingestion, as of 2026-10-24.",
          "Synthetic replay report; no native ingestion or clinical inference.",
        ),
    );
    const fragments = [fragment],
      assertions = [assertion],
      supportSets = [support];
    if (captured) {
      const secondFragment = required(captured.bridges[1], "second captured source").fragment;
      const secondAssertion = {
        ...assertion,
        id: `joined-note-asr-${revision}`,
        logicalId: "model-size-note",
        proposition: "The published parameter count for Model X is 7 billion.",
        value: { type: "quantity" as const, amount: "7000000000", unit: "parameters" },
      };
      fragments.push(secondFragment);
      assertions.push(secondAssertion);
      supportSets.push({
        ...fixtureSupportSet(tenant, binding, secondAssertion, secondFragment),
        id: `joined-note-set-${revision}`,
      });
      body.sections
        .find((section: { id: string }) => section.id === "findings")
        .blocks.push({
          type: "paragraph",
          id: "p2",
          excludedReason: null,
          inlines: [
            {
              type: "claim",
              occurrenceId: "occ-size-note",
              assertion: recordRef("assertion", secondAssertion),
              text: secondAssertion.proposition,
              obligations: ["finding.size"],
              attribution: "technical note",
            },
            { type: "text", text: " " },
            { type: "citation", label: "note", fragment: recordRef("fragment", secondFragment) },
          ],
        });
    }
    return {
      task,
      fragments,
      assertions,
      supportSets,
      report: {
        reportId: "joined-report",
        revision,
        kind: "evidence_report",
        structuredBody: body,
        timeCoverage: { world: null, observed: null, knowledgeHead: null },
        supersedes: null,
      },
    };
  });
  send({
    ready: true,
    url,
    issuer: TEST_ISSUER,
    audience: TEST_AUDIENCE,
    binding,
    reports,
    ...(captured
      ? {
          captureEvidence: {
            captures: captured.captures,
            bridges: captured.bridges,
            checks: captured.checks,
            reconstructed: captured.reconstructed,
            providerCalls: captured.providerCalls,
          },
        }
      : {}),
  });
  for await (const line of createInterface({ input: process.stdin })) {
    const command = JSON.parse(line) as { action: string; report: Ref<"report">; revision: number };
    if (command.action === "close") break;
    if (!["assess", "read", "inspect", "correct-source"].includes(command.action))
      throw new Error("unsupported fixture command");
    const runId = await research.locator.runOf(scope, command.report);
    if (!runId) throw new Error("report run missing");
    const context = await research.binding.loadRunContext(scope, runId);
    if (command.action === "inspect") {
      const revision = required(context.report, "stored report").revision;
      if (digestCanonical(revision) !== command.report.digest) throw new Error("EXACT_REPORT_DIGEST_MISMATCH");
      send({ report: command.report, context });
      continue;
    }
    if (command.action === "correct-source") {
      const revision = required(context.report, "stored report").revision;
      if (digestCanonical(revision) !== command.report.digest) throw new Error("EXACT_REPORT_DIGEST_MISMATCH");
      const set = required(context.supportSets[0], "stored support set");
      const evidence = required(set.required.flatMap((premise) => premise.evidence)[0], "exact source evidence");
      const [stored] = await research.binding.loadFragments(scope, [evidence]);
      if (!stored || digestCanonical(stored) !== evidence.digest) throw new Error("EXACT_FRAGMENT_DIGEST_MISMATCH");
      const beforeEpoch = await research.binding.currentEpoch(scope);
      const corrections = new CorrectionService(research.binding, research.coordinator, options.clock);
      const closure = await corrections.recordCorrection(scope, {
        corrected: { kind: "fragment", id: stored.id },
        reason: "Trusted local fixture source correction: withdraw this exact fragment from current use.",
        evaluator: { ...fixtureEvaluator("auditor", "linked-source-correction"), kind: "deterministic" },
        method: fixtureRef("method", "linked-source-correction", tenant, binding, "correction.v1"),
      });
      const corrected = await research.binding.loadRunContext(scope, runId);
      send({
        report: command.report,
        corrected: evidence,
        beforeEpoch,
        afterEpoch: await research.binding.currentEpoch(scope),
        closure,
        manifests: corrected.manifests,
      });
      continue;
    }
    if (command.action === "read") {
      const revision = required(context.report, "stored report").revision;
      if (digestCanonical(revision) !== command.report.digest) throw new Error("EXACT_REPORT_DIGEST_MISMATCH");
      const body = await research.binding.custody.get(scope, revision.body);
      send({
        report: command.report,
        body: Buffer.from(body).toString("utf8"),
        bodyDigest: digestBytes(body),
        revision,
      });
      continue;
    }
    const supportSet = required(context.supportSets[0], "stored support set");
    const storedAssertion = required(context.assertions[0], "stored assertion");
    const evidenceRefs = supportSet.required.flatMap((premise) => premise.evidence);
    const [storedFragment] = await research.binding.loadFragments(scope, evidenceRefs);
    if (!storedFragment) throw new Error("stored support fragment is unavailable");
    const fragmentDiagnostics = {
      expected: required(evidenceRefs[0], "evidence reference").digest,
      stored: digestCanonical(storedFragment),
      fixture: digestCanonical(fragment),
    };
    const observation = fixtureSupportObservation({
      tenant,
      binding,
      id: `joined-judge-${command.revision}`,
      set: supportSet,
      fragment: storedFragment,
      role: "judge",
      verdict: command.revision === 1 ? "contradiction" : "full_support",
      qualifiersDigest: qualifiersDigest(storedAssertion.qualifiers),
    });
    await research.coordinator.observe(scope, runId, {
      ...observation,
      usage: { providerCalls: 0, tokens: 0, costUsd: "0" },
      rationale: "Local scripted evidence comparator, independent evaluator family.",
    });
    const envelope = envelopeFor({
      operation: "report.assess",
      origin,
      binding,
      upstream: [command.report],
      payload: {
        report: command.report,
        obligation: "draft.report",
        submission: `joined-${command.revision}`,
      } as unknown as JsonValue,
    });
    const token = signCredential(
      key,
      claimsFor({ origin, binding, operations: ["report.assess"], dispatchId: envelope.dispatchId }),
    );
    const response = await fetch(`${url}/knowledge-operation/v2/invoke`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(envelope),
    });
    const handle = OperationHandleSchema.parse(await response.json());
    await service.settled();
    const statusToken = signCredential(
      key,
      claimsFor({ origin, binding, operations: ["operation.get"], dispatchId: `status-${command.revision}` }),
    );
    const status = OperationStatusSchema.parse(
      await (
        await fetch(`${url}/knowledge-operation/v2/operations/${handle.operationId}`, {
          headers: { authorization: `Bearer ${statusToken}` },
        })
      ).json(),
    );
    if (command.revision === 1) {
      send({ state: status.state, admitted: false, fragmentDiagnostics });
      continue;
    }
    await research.coordinator.sealVerificationSnapshot(scope, {
      runId,
      build: { buildId: "joined-local", runtime: "node", dirty: true },
      signer: "joined-sealer",
    });
    const decision = await research.coordinator.decideReportUse(scope, {
      runId,
      use: task.use,
      audience: task.audience,
      boundEffectDigest: DigestSchema.parse(command.report.digest) as Digest,
      targetSchema: "research-report.v2",
      normalizedValues: {},
      policy: task.policy,
      rubric: task.rubric,
    });
    const body = await research.binding.custody.get(scope, required(context.report, "stored report").revision.body);
    send({
      state: status.state,
      admitted: decision.decision.disposition === "admitted",
      decision: decision.decision,
      fragmentDiagnostics,
      body: Buffer.from(body).toString("utf8"),
      bodyDigest: digestBytes(body),
      report: command.report,
    });
  }
} finally {
  await closeServer?.();
  await closeBackend?.();
  await closeCapture?.();
  const cleanup = new Client({ connectionString: adminDsn });
  await cleanup.connect();
  try {
    await cleanup.query(`drop database ${database} with (force)`);
  } finally {
    await cleanup.end();
  }
}
