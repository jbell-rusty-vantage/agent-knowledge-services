import assert from "node:assert/strict";
import test from "node:test";
import { digestBytes, digestCanonical, type Origin, type Ref } from "@aiengineer/knowledge-operation-protocol";
import { prepareQualiaReport, type AuthoredReport } from "./qualia-report.js";

const origin: Origin = {
  kind: "standalone",
  installationId: "01a103c0-9a9e-7a95-961b-29dda83c842b",
  applicationId: "biotech",
  tenantId: "a6be1117-e0cc-4d6a-9e52-8bc28f310888",
  issuer: "test-host",
  subject: "test-producer",
  mission: null,
  recoveryAuthorityRef: null,
  invocationId: "test-invocation",
  authenticatedAt: "2026-10-30T00:00:00Z",
};
const put = async (bytes: Uint8Array): Promise<Ref<"artifact">> => ({
  kind: "artifact",
  id: `artifact-${digestBytes(bytes).slice(7, 30)}`,
  version: "artifact.v1",
  digest: digestBytes(bytes),
  tenant: origin.tenantId,
  binding: "biotech-graph",
});
const primary = "Synthetic treatment group mean biomarker rose 20 percent.";
const qualifiers = [
  "Synthetic Example formulation was administered.",
  "The paired analysis contained 25 adults.",
  "The follow-up visit occurred after 28 days.",
];
const authored: AuthoredReport = {
  id: "synthetic-multiple-quotes",
  title: "Synthetic qualifier evidence test",
  summary: "Structure only; no scientific entailment is asserted by this test.",
  claims: [
    {
      id: "change",
      statement: "The synthetic study reports a biomarker change after 28 days in 25 adults receiving Example.",
      sourceUrl: "https://fixtures.bks.test/study",
      quote: primary,
      additional_quotes: qualifiers,
      qualifiers: {
        negation: false,
        entity: "synthetic-study",
        intervention: "Example",
        sampleSize: 25,
        followUp: "28 days",
      },
    },
  ],
  limitations: ["Synthetic unit-test source only."],
};

async function prepare(report = structuredClone(authored), text = [primary, ...qualifiers].join("\n")) {
  return prepareQualiaReport({
    authored: report,
    sources: [
      {
        url: authored.claims[0]!.sourceUrl,
        text,
        ref: await put(Buffer.from(text)),
        retrievedAt: "2026-10-30T00:00:00Z",
      },
    ],
    origin,
    put,
  });
}

test("polarity is explicit producer input and never inferred or defaulted", async () => {
  for (const value of [undefined, null, "false", 0]) {
    const report = structuredClone(authored);
    Object.assign(report.claims[0]!.qualifiers, { negation: value });
    await assert.rejects(prepare(report), /explicit boolean qualifiers.negation/);
  }
  const report = structuredClone(authored);
  report.claims[0]!.qualifiers.negation = true;
  const registration = await prepare(report);
  assert.equal(registration.assertions[0]!.qualifiers.negation, true);
});

test("the fixture accepts up to 24 separately declared claims with every original obligation retained", async () => {
  const report = structuredClone(authored);
  report.claims = Array.from({ length: 24 }, (_, index) => ({
    ...structuredClone(authored.claims[0]!),
    id: `atomic-${index}`,
  }));
  const registration = await prepare(report);
  assert.equal(registration.assertions.length, 24);
  assert.equal(registration.task.obligations.length, 24);
  assert.equal(
    registration.task.obligations.reduce((total, obligation) => total + obligation.weight, 0),
    10000,
  );
  report.claims.push({ ...structuredClone(authored.claims[0]!), id: "over-limit" });
  await assert.rejects(prepare(report), /1\.\.24/);
});

test("separate exact source quotes form one complete cited support input without invented context", async () => {
  const registration = await prepare();
  const quotes = [primary, ...qualifiers];
  assert.equal(registration.fragments.length, 4);
  assert.equal(new Set(registration.fragments.map((fragment) => fragment.id)).size, 4);
  assert.deepEqual(
    registration.fragments.map((fragment) => fragment.selector.value),
    quotes,
  );
  for (const [index, fragment] of registration.fragments.entries()) {
    assert.equal(fragment.selectedDigest, digestBytes(quotes[index]!));
    assert.equal(fragment.selectedSize, Buffer.byteLength(quotes[index]!));
    assert.deepEqual(fragment.capture, fragment.representation);
  }
  assert.equal(registration.supportSets.length, 1);
  assert.equal(registration.supportSets[0]!.required.length, 1);
  assert.deepEqual(
    registration.supportSets[0]!.required[0]!.evidence.map((ref) => ref.id),
    registration.fragments.map((fragment) => fragment.id),
  );
  assert.equal(registration.supportSets[0]!.qualifiersDigest, digestCanonical(registration.assertions[0]!.qualifiers));
  const scientific = registration.assertions[0]!.qualifiers;
  assert.equal(scientific.profile, "scientific.v2");
  if (scientific.profile === "scientific.v2") assert.equal(scientific.followUp, "28 days");
  const findings = registration.report.structuredBody.sections.find((section) => section.id === "findings")!;
  const paragraph = findings.blocks[0]!;
  assert.equal(paragraph.type, "paragraph");
  if (paragraph.type === "paragraph")
    assert.equal(paragraph.inlines.filter((inline) => inline.type === "citation").length, 4);
});

test("omitting additional quotes preserves the original single-quote fragment identity", async () => {
  const report = structuredClone(authored);
  delete report.claims[0]!.additional_quotes;
  const absent = await prepare(report);
  report.claims[0]!.additional_quotes = [];
  const empty = await prepare(report);
  assert.equal(absent.fragments.length, 1);
  assert.equal(absent.fragments[0]!.id, `${authored.id}-fragment-change`);
  assert.deepEqual(absent.fragments, empty.fragments);
  assert.deepEqual(absent.supportSets, empty.supportSets);
});

for (const [name, extras, text, pattern] of [
  ["missing", ["Absent qualifier quotation."], undefined, /uniquely resolve/],
  ["tampered", [qualifiers[0]!.replace("Example", "Changed")], undefined, /uniquely resolve/],
  ["duplicate primary", [primary], undefined, /Duplicate quote/],
  ["duplicate extra", [qualifiers[0]!, qualifiers[0]!], undefined, /Duplicate quote/],
  ["ambiguous", [qualifiers[0]!], [primary, qualifiers[0], qualifiers[0]].join("\n"), /uniquely resolve/],
  ["empty", [""], undefined, /nonempty strings/],
  ["too many", [...qualifiers, "Fourth qualifier."], undefined, /at most 3/],
] as const) {
  test(`refuses ${name} additional quotes`, async () => {
    const report = structuredClone(authored);
    report.claims[0]!.additional_quotes = [...extras];
    await assert.rejects(prepare(report, text), pattern);
  });
}

test("all quotes share the retained source and its custody digest", async () => {
  const text = [primary, ...qualifiers].join("\n");
  await assert.rejects(
    prepareQualiaReport({
      authored,
      sources: [
        {
          url: authored.claims[0]!.sourceUrl,
          text,
          ref: await put(Buffer.from(`${text} changed`)),
          retrievedAt: "2026-10-30T00:00:00Z",
        },
      ],
      origin,
      put,
    }),
    /unavailable/,
  );
});

test("the primary and additional quotes share one 8000-character budget", async () => {
  const report = structuredClone(authored);
  report.claims[0]!.quote = "p".repeat(4000);
  report.claims[0]!.additional_quotes = ["q".repeat(4000)];
  assert.equal(
    (await prepare(report, `${report.claims[0]!.quote}\n${report.claims[0]!.additional_quotes[0]}`)).fragments.length,
    2,
  );
  report.claims[0]!.additional_quotes[0] += "q";
  await assert.rejects(prepare(report), /8000 characters/);
});

test("duplicate claim ids and generated fragment-id collisions refuse registration", async () => {
  const report = structuredClone(authored);
  report.claims.push(structuredClone(report.claims[0]!));
  await assert.rejects(prepare(report), /claim ids must be unique/);
  report.claims[1]!.id = "change-additional-1";
  report.claims[1]!.additional_quotes = [];
  await assert.rejects(prepare(report), /Duplicate fragment id/);
});

test("a report pins the selected same-URL snapshot instead of preferring acquisition order", async () => {
  const text = [primary, ...qualifiers].join("\n");
  const selectedId = "a".repeat(32),
    otherId = "b".repeat(32);
  const selected = {
    captureId: selectedId,
    url: authored.claims[0]!.sourceUrl,
    text,
    ref: await put(Buffer.from(text)),
    retrievedAt: "2026-10-30T00:00:00Z",
  };
  const otherText = "A different capture of the same URL without those quoted statements.";
  const other = { ...selected, captureId: otherId, text: otherText, ref: await put(Buffer.from(otherText)) };
  const report = structuredClone(authored);
  report.claims[0]!.capture_id = selectedId;
  for (const sources of [
    [selected, other],
    [other, selected],
  ]) {
    const registration = await prepareQualiaReport({ authored: report, sources, origin, put });
    assert.equal(registration.fragments.length, 4);
    assert.ok(registration.fragments.every((fragment) => fragment.capture.digest === selected.ref.digest));
    assert.ok(registration.fragments.every((fragment) => fragment.context.surroundingDigest === selected.ref.digest));
  }
  report.claims[0]!.capture_id = otherId;
  await assert.rejects(
    prepareQualiaReport({ authored: report, sources: [selected, other], origin, put }),
    /uniquely resolve/,
  );
  delete report.claims[0]!.capture_id;
  await assert.rejects(prepareQualiaReport({ authored: report, sources: [selected, other], origin, put }), /ambiguous/);
  report.claims[0]!.capture_id = "c".repeat(32);
  await assert.rejects(
    prepareQualiaReport({ authored: report, sources: [selected, other], origin, put }),
    /unavailable/,
  );
  report.claims[0]!.capture_id = selectedId;
  report.claims[0]!.sourceUrl += "/other";
  await assert.rejects(
    prepareQualiaReport({ authored: report, sources: [selected, other], origin, put }),
    /unavailable/,
  );
});
