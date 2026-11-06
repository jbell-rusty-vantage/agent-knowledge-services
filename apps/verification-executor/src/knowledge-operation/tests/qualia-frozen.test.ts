import assert from "node:assert/strict";
import test from "node:test";
import { digestBytes, type Origin, type Ref } from "@aiengineer/knowledge-operation-protocol";
import {
  ReportRevisionSchema,
  VerificationObservationSchema,
  buildLedger,
  recordRef,
  renderReport,
} from "@aiengineer/knowledge-research-core";
import { supportObservation } from "@aiengineer/knowledge-research-core/testing";
import { prepareQualiaReport } from "./qualia-report.js";
import {
  hydrateQualiaFrozenReport,
  retainQualiaFragmentBinding,
  type QualiaFragmentCaptureBinding,
} from "./qualia-frozen.js";

async function fixture(extraClaim = false) {
  const tenant = "synthetic-tenant",
    binding = "biotech-graph";
  const origin: Origin = {
    kind: "standalone",
    installationId: "01a103c0-9a9e-7a95-961b-29dda83c842b",
    applicationId: "biotech",
    tenantId: tenant,
    issuer: "test-host",
    subject: "test-producer",
    mission: null,
    recoveryAuthorityRef: null,
    invocationId: "synthetic-invocation",
    authenticatedAt: "2026-10-30T00:00:00Z",
  };
  const artifacts = new Map<string, Uint8Array>();
  const put = async (bytes: Uint8Array): Promise<Ref<"artifact">> => {
    const digest = digestBytes(bytes);
    artifacts.set(digest, bytes);
    return { kind: "artifact", id: `artifact-${digest.slice(7, 30)}`, version: "artifact.v1", digest, tenant, binding };
  };
  const text = "The synthetic trial reports a biomarker change. The synthetic follow-up was 28 days.";
  const source = {
    captureId: "a".repeat(32),
    url: "https://fixtures.bks.test/study",
    text,
    ref: await put(Buffer.from(text)),
    retrievedAt: "2026-10-30T00:00:00Z",
  };
  const fragmentBindings = new Map<string, QualiaFragmentCaptureBinding>();
  const registration = await prepareQualiaReport({
    authored: {
      id: "synthetic-frozen",
      title: "Synthetic fixture",
      summary: "No clinical conclusion",
      claims: [
        {
          id: "change",
          statement: "The synthetic source reports a biomarker change at 28 days.",
          sourceUrl: source.url,
          capture_id: source.captureId,
          quote: "The synthetic trial reports a biomarker change.",
          additional_quotes: ["The synthetic follow-up was 28 days."],
          qualifiers: { negation: false, followUp: "28 days" },
        },
        ...(extraClaim
          ? [
              {
                id: "context",
                statement: "The synthetic source describes a 28-day follow-up.",
                sourceUrl: source.url,
                capture_id: source.captureId,
                quote: "The synthetic follow-up was 28 days.",
                qualifiers: { negation: false, followUp: "28 days" },
              },
            ]
          : []),
      ],
      limitations: ["Synthetic test only."],
    },
    sources: [source],
    origin,
    put,
    bindFragment: (fragment, capture) => retainQualiaFragmentBinding(fragmentBindings, fragment, capture),
  });
  const rendered = renderReport(registration.report.structuredBody);
  const body = await put(rendered.bytes);
  const ledger = buildLedger({ frozen: rendered, body, id: "synthetic-ledger", tenant, binding });
  const revision = ReportRevisionSchema.parse({
    schemaVersion: "research-report.v2",
    id: "synthetic-frozen-r1",
    tenant,
    binding,
    kind: { ...body, kind: "report_kind", id: "evidence_report@1.0.0", version: "report-kind.v1" },
    task: recordRef("task", registration.task),
    structuredBody: await put(Buffer.from(JSON.stringify(registration.report.structuredBody))),
    body,
    bodyDigest: body.digest,
    renderer: rendered.renderer,
    normalization: rendered.normalization,
    ledger: await put(Buffer.from(JSON.stringify(ledger))),
    assertions: registration.assertions.map((assertion) => recordRef("assertion", assertion)),
    timeCoverage: registration.report.timeCoverage,
    derivationCandidates: [],
    supersedes: null,
  });
  const input: Parameters<typeof hydrateQualiaFrozenReport>[0] = {
    report: recordRef("report", revision),
    context: {
      report: { revision, ledger },
      assertions: registration.assertions,
      supportSets: registration.supportSets,
      observations: [],
    },
    sources: [source],
    fragmentBindings,
    loadFragments: async () => registration.fragments,
    readArtifact: async (ref) => {
      const bytes = artifacts.get(ref.digest);
      if (!bytes) throw new Error("Missing actual artifact");
      return bytes;
    },
  };
  return { input, registration, source, artifacts, fragmentBindings };
}

test("frozen projection is hydrated from actual report assertions, support fragments, custody and host capture identity", async () => {
  const { input, registration, source } = await fixture();
  const frozen = await hydrateQualiaFrozenReport(input);
  assert.equal(frozen.reportRevisionId, input.report.id);
  assert.equal(frozen.assertions.length, 1);
  assert.deepEqual(
    frozen.assertions.map((assertion) => [assertion.id, assertion.proposition, assertion.qualifiers]),
    registration.assertions.map((assertion) => [assertion.id, assertion.proposition, assertion.qualifiers]),
  );
  assert.deepEqual(
    frozen.assertions.flatMap((assertion) => assertion.evidence),
    registration.fragments.map((fragment) => ({
      captureId: source.captureId,
      sourceUrl: source.url,
      quote: fragment.selector.value,
      fragmentId: fragment.id,
      fragmentDigest: recordRef("fragment", fragment).digest,
    })),
  );
});

for (const change of ["report", "assertion", "fragment", "support", "custody", "binding"] as const) {
  test(`refuses altered frozen ${change} authority rather than reconstructing evidence`, async () => {
    const { input, registration, artifacts, fragmentBindings } = await fixture();
    if (change === "report") input.report = { ...input.report, digest: `sha256:${"f".repeat(64)}` };
    else if (change === "assertion") registration.assertions[0]!.proposition = "Altered proposition.";
    else if (change === "fragment") registration.fragments[0]!.selector.value = "Altered quoted evidence.";
    else if (change === "support") registration.supportSets[0]!.qualifiersDigest = `sha256:${"f".repeat(64)}`;
    else if (change === "custody")
      artifacts.set(input.context.report!.revision.body.digest, Buffer.from("Tampered actual body"));
    else fragmentBindings.clear();
    await assert.rejects(hydrateQualiaFrozenReport(input), /mismatch/);
  });
}

test("a frozen fragment cannot be rebound to another snapshot with identical text", async () => {
  const { registration, source, fragmentBindings } = await fixture();
  assert.throws(
    () =>
      retainQualiaFragmentBinding(fragmentBindings, recordRef("fragment", registration.fragments[0]!), {
        ...source,
        captureId: "b".repeat(32),
      }),
    /rebound/,
  );
});

async function judgedFixture(extraClaim = false) {
  const f = await fixture(extraClaim);
  const assertion = f.registration.assertions[0]!;
  const set = f.registration.supportSets[0]!;
  const candidate = supportObservation({
    id: "synthetic-actual-judge",
    set,
    target: assertion,
    verdict: "qualified_support",
  });
  const refs = f.registration.fragments.map((fragment) => recordRef("fragment", fragment));
  assert.equal(candidate.property, "support");
  if (candidate.property !== "support") throw new Error("Expected test support observation");
  const observation = VerificationObservationSchema.parse({
    ...candidate,
    tenant: assertion.tenant,
    binding: assertion.binding,
    method: { ...candidate.method, tenant: assertion.tenant, binding: assertion.binding },
    evidence: refs,
    rationale: "Synthetic actual judge reason, unchanged.",
    outcome: {
      ...candidate.outcome,
      citedFragments: refs,
      qualification: "Applies only to this synthetic follow-up.",
      unsupportedFacets: ["population"],
    },
  });
  f.input.context = { ...f.input.context, observations: [observation] };
  return { ...f, observation };
}

test("actual judge context may cite another exact frozen report fragment without changing declared support", async () => {
  const { input, registration, observation } = await judgedFixture(true);
  const frozen = await hydrateQualiaFrozenReport(input);
  const assertion = frozen.assertions[0]!;
  assert.equal(assertion.declaredEvidence.length, 2);
  assert.equal(assertion.observedEvidence.length, 3);
  assert.equal(assertion.evidence.length, 3);
  assert.equal(assertion.judgments[0]!.evidence.length, 3);
  assert.deepEqual(assertion.judgments[0]!.target, recordRef("support_set", registration.supportSets[0]!));
  assert.deepEqual(assertion.judgments[0]!.outcome, observation.outcome);
  assert.equal(registration.supportSets[0]!.required[0]!.evidence.length, 2);
});

for (const change of ["unknown", "out-of-report", "digest", "scope", "missing-capture", "tampered-record"] as const) {
  test(`additional observed evidence refuses ${change} references`, async () => {
    const { input, registration, observation, source, fragmentBindings } = await judgedFixture(true);
    assert.equal(observation.property, "support");
    if (observation.property !== "support") throw new Error("Expected support fixture");
    const contextual = registration.fragments[2]!;
    const ref = recordRef("fragment", contextual);
    if (change === "missing-capture") fragmentBindings.delete(ref.digest);
    else if (change === "tampered-record") contextual.selectedDigest = `sha256:${"f".repeat(64)}`;
    else {
      let invalid = { ...ref };
      if (change === "out-of-report") {
        const outside = { ...contextual, id: "actual-but-not-in-this-report" };
        invalid = recordRef("fragment", outside);
        registration.fragments.push(outside);
        retainQualiaFragmentBinding(fragmentBindings, invalid, source);
      } else if (change === "scope") invalid.tenant = "other-tenant";
      else if (change === "unknown") invalid.id = "unregistered-fragment";
      else invalid.digest = `sha256:${"f".repeat(64)}`;
      observation.evidence = [...observation.evidence, invalid];
    }
    await assert.rejects(hydrateQualiaFrozenReport(input), /mismatch|out-of-report/);
  });
}

test("judgments retain actual support observation identity, exact outcome and rationale without verdict normalization", async () => {
  const { input, observation } = await judgedFixture();
  const frozen = await hydrateQualiaFrozenReport(input);
  const judgment = frozen.assertions[0]!.judgments[0]!;
  assert.equal(judgment.id, observation.id);
  assert.equal(judgment.digest, recordRef("observation", observation).digest);
  assert.equal(judgment.rationale, observation.rationale);
  assert.deepEqual(judgment.outcome, observation.outcome);
  assert.deepEqual(judgment.target, observation.target);
  assert.deepEqual(judgment.observation, observation);
});

for (const change of ["target", "qualifiers", "scope"] as const) {
  test(`refuses mismatched actual support observation ${change}`, async () => {
    const { input, observation } = await judgedFixture();
    if (change === "target") observation.target = { ...observation.target, digest: `sha256:${"f".repeat(64)}` };
    else if (change === "qualifiers") observation.qualifiersDigest = `sha256:${"f".repeat(64)}`;
    else observation.tenant = "another-tenant";
    await assert.rejects(hydrateQualiaFrozenReport(input), /mismatch/);
  });
}
