import assert from "node:assert/strict";
import { canonicalDigestExample } from "./01-canonical-digest.js";
import { resolveExample, selectorExamples } from "./02-resolve-selectors.js";
import { deterministicBundleExample, summarize } from "./03-deterministic-bundle.js";
import { acceptedLeaves, extractionFieldsExample } from "./04-extraction-fields.js";
import { semanticRecordedJudgeExample } from "./05-semantic-recorded-judge.js";
import { sealInspectReplayExample } from "./06-seal-inspect-replay.js";

const print = (stage: string, value: unknown) => console.log(JSON.stringify({ stage, ...(value as object) }));

// 01 — canonical digest
const digest = canonicalDigestExample();
assert.equal(digest.sameCanonicalForm, true);
assert.equal(digest.sameDigest, true);
assert.equal(digest.recognizesDigest, true);
assert.equal(digest.rejectsBareHex, false);
print("01-canonical-digest", digest);

// 02 — resolve selectors
for (const example of selectorExamples) {
  const result = resolveExample(example);
  assert.equal(result?.resolution.status, "resolved", example.name);
  assert.ok(new TextDecoder().decode(result?.selectedContent).includes(example.expectedText), example.name);
  print("02-resolve-selectors", {
    example: example.name,
    status: result.resolution.status,
    ranges: result.resolution.resolvedRanges,
  });
}
const repeated = {
  name: "ambiguous value",
  content: "Panel A: 42. Panel B: 42.",
  selector: { kind: "text_quote", quote: "42", normalization: "none" } as const,
  expectedText: "42",
};
assert.equal(resolveExample(repeated)?.resolution.status, "ambiguous");
const recovered = resolveExample({
  ...repeated,
  selector: { ...repeated.selector, prefix: "Panel B: " },
});
assert.equal(recovered?.resolution.status, "resolved");
print("02-resolve-selectors", {
  example: repeated.name,
  initial: "ambiguous",
  withContext: recovered.resolution.status,
});

// 03 — deterministic bundle
const bundles = deterministicBundleExample();
assert.equal(bundles.passing.status, "passed");
assert.equal(bundles.passing.semanticEligibility, true);
assert.ok(bundles.corrupted.summary.failedCheckCodes.includes("CAPTURE_DIGEST_MATCH"));
assert.equal(bundles.corrupted.semanticEligibility, false);
print("03-deterministic-bundle", {
  passing: summarize(bundles.passing),
  corrupted: summarize(bundles.corrupted),
});

// 04 — extraction fields
const extraction = extractionFieldsExample();
assert.equal(extraction.valid, true);
assert.deepEqual(
  acceptedLeaves(extraction).map((leaf) => leaf.path),
  ["/total", "/vendor"],
);
print("04-extraction-fields", {
  valid: extraction.valid,
  acceptedLeaves: acceptedLeaves(extraction),
});

// 05 — semantic recorded judge
const semantic = await semanticRecordedJudgeExample();
assert.ok(semantic.closed.reasonCodes.includes("MECHANICAL_GATE_CLOSED"));
assert.equal(semantic.closed.judgeCalls, 0);
assert.equal(semantic.supported.verdict, "directly_supported");
assert.equal(semantic.supported.judgeCalls, 1);
print("05-semantic-recorded-judge", semantic);

// 06 — seal, inspect, replay
const provenance = await sealInspectReplayExample();
assert.equal(provenance.inspection.valid, true);
assert.equal(provenance.inspection.signatureStatus, "verified");
assert.equal(provenance.replay.matchesSealedDigest, true);
assert.equal(provenance.replay.policyReplays, 1);
print("06-seal-inspect-replay", provenance);
