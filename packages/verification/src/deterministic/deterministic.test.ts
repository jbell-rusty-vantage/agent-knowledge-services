import { describe, expect, it } from "vitest";
import { canonicalizeJson, sha256Digest } from "../canonical/index.js";
import { formatRoundedDecimal, replayDecimalOperation } from "../decimal/index.js";
import { verifyDeterministicBundle, type DeterministicVerificationInput } from "./bundle-verification.js";
import { prototypeClaimInput, prototypeMetricInput, runtimePrincipals } from "./engine-golden.fixture.js";

const clone = <T>(value: T): T => structuredClone(value);
const replaceArtifactContent = (
  input: DeterministicVerificationInput,
  content: string,
): DeterministicVerificationInput => ({
  ...input,
  artifacts: input.artifacts.map((artifact, index) => (index === 0 ? { ...artifact, content } : artifact)),
});

describe("frozen prototype parity", () => {
  it("admits native lineage only through a trusted runtime binding and still rejects changed bytes", () => {
    const original = prototypeClaimInput(),
      capture = original.bundle.captures[0]!;
    const content = "projection",
      projection = {
        ...capture.contentArtifact,
        artifactId: "33333333-3333-4333-8333-333333333333",
        digest: sha256Digest(content),
        byteLength: content.length,
        parentArtifactIds: [],
      };
    delete projection.transformationSignature;
    capture.canonicalProjectionArtifact = projection;
    const input = {
      ...original,
      artifacts: [...original.artifacts, { artifactId: projection.artifactId, content }],
    };
    expect(verifyDeterministicBundle(input).summary.failedCheckCodes).toContain("PROJECTION_LINEAGE_BOUND");
    const admittedBinding = canonicalizeJson({
      captureId: capture.captureId,
      sourceArtifact: capture.contentArtifact,
      projectionArtifact: projection,
    });
    const options = {
      isProjectionLineageAdmitted: (binding: unknown) => canonicalizeJson(binding) === admittedBinding,
    };
    expect(verifyDeterministicBundle(input, options).status).toBe("passed");
    expect(projection.parentArtifactIds).toEqual([]);
    const corrupted = {
      ...input,
      artifacts: input.artifacts.map((item) =>
        item.artifactId === projection.artifactId ? { ...item, content: "tampered" } : item,
      ),
    };
    expect(verifyDeterministicBundle(corrupted, options).summary.failedCheckCodes).toContain("PROJECTION_DIGEST_MATCH");
    const changed = clone(input);
    changed.bundle.captures[0]!.captureId = "unadmitted-capture";
    expect(verifyDeterministicBundle(changed, options).summary.failedCheckCodes).toContain("PROJECTION_LINEAGE_BOUND");
  });
  it("passes the unique exact quote fixture", () => {
    const result = verifyDeterministicBundle(prototypeClaimInput());
    expect(sha256Digest(canonicalizeJson(result))).toBe(
      "sha256:f8e03144923c54a18a62b6c0f4a16b41678655978379e9ceceda8244e6d4f531",
    );
    expect(result.status).toBe("passed");
    expect(result.assertions[0]?.semanticEligibility).toBe(true);
    expect(result.assertions[0]?.evidence[0]?.resolution.resolvedRanges[0]?.start).toBe(7);
  });

  it("fails closed when declared offsets drift", () => {
    let input = prototypeClaimInput();
    const edge = input.bundle.assertions[0]!.evidence[0]!;
    edge.fragment.selector = {
      kind: "character_position",
      start: 1,
      end: 20,
      offsetBasis: "utf16_code_units",
      normalization: "none",
    };
    const result = verifyDeterministicBundle(input);
    expect(result.status).toBe("failed");
    expect(result.summary.failedCheckCodes).toContain("EXPECTED_SELECTED_CONTENT_DIGEST_MATCH");
  });

  it("preserves the prototype's review result for lossy filler normalization", () => {
    let input = prototypeClaimInput();
    const edge = input.bundle.assertions[0]!.evidence[0]!;
    const content = "some sort of uh default agent that does search";
    input = replaceArtifactContent(input, content);
    input.bundle.captures[0]!.contentArtifact.digest = sha256Digest(content);
    input.bundle.captures[0]!.contentArtifact.byteLength = new TextEncoder().encode(content).byteLength;
    edge.fragment.selector = {
      kind: "text_quote",
      quote: "some sort of default agent that does search",
      normalization: "casefold_whitespace_filler_removed",
    };
    delete edge.expectedSelectedContentDigest;
    const result = verifyDeterministicBundle(input);
    expect(result.status).toBe("review_required");
    expect(result.semanticEligibility).toBe(false);
  });

  it("rejects self-verification by runtime principal identity", () => {
    let input = prototypeClaimInput();
    input.bundle.verifier.deploymentId = input.bundle.producer.deploymentId;
    input = {
      ...input,
      runtimePrincipals: {
        ...runtimePrincipals,
        verifierDeploymentId: runtimePrincipals.producerDeploymentId,
      },
    };
    const result = verifyDeterministicBundle(input);
    expect(result.status).toBe("failed");
    expect(result.deploymentSeparation.status).toBe("not_established");
  });

  it("replays source-bound metric arithmetic", () => {
    const result = verifyDeterministicBundle(prototypeMetricInput());
    expect(sha256Digest(canonicalizeJson(result))).toBe(
      "sha256:92151eed894f783575f5bca11a29f43c8278b7781f4223787dd426929d62416b",
    );
    expect(result.status).toBe("passed");
    expect(result.metrics.find((metric) => metric.observationId === "npm-downloads-30d")?.replayedValue).toBe("25");
  });
});

describe("capture, identity, source binding, and monotonic eligibility", () => {
  it("rejects changed capture bytes and raw/projection length drift", () => {
    const tampered = replaceArtifactContent(prototypeClaimInput(), "tampered");
    const tamperedCodes = verifyDeterministicBundle(tampered).summary.failedCheckCodes;
    expect(tamperedCodes).toContain("CAPTURE_DIGEST_MATCH");
    expect(tamperedCodes).toContain("CAPTURE_BYTE_LENGTH_MATCH");

    let projected = prototypeClaimInput();
    const projectionId = "33333333-3333-4333-8333-333333333333";
    const content = "projection";
    projected.bundle.captures[0]!.canonicalProjectionArtifact = {
      ...projected.bundle.captures[0]!.contentArtifact,
      artifactId: projectionId,
      digest: sha256Digest(content),
      byteLength: 999,
      objectKey: `verification/${projectionId}`,
      parentArtifactIds: [projected.bundle.captures[0]!.contentArtifact.artifactId],
      transformationSignature: sha256Digest("projection-v1"),
    };
    projected = {
      ...projected,
      artifacts: [...projected.artifacts, { artifactId: projectionId, content }],
    };
    expect(verifyDeterministicBundle(projected).summary.failedCheckCodes).toContain("PROJECTION_BYTE_LENGTH_MATCH");
  });

  it("rejects bundle/runtime identity mismatches and assertion producer substitution", () => {
    let forgedRuntime = prototypeClaimInput();
    forgedRuntime = {
      ...forgedRuntime,
      runtimePrincipals: {
        ...runtimePrincipals,
        verifierDeploymentId: "forged",
      },
    };
    expect(verifyDeterministicBundle(forgedRuntime).summary.failedCheckCodes).toContain(
      "RUNTIME_PRINCIPAL_BINDING_MATCH",
    );

    const forgedAssertion = prototypeClaimInput();
    forgedAssertion.bundle.assertions[0]!.producer.deploymentId = "verification-agent";
    expect(verifyDeterministicBundle(forgedAssertion).summary.failedCheckCodes).toContain("ASSERTION_PRODUCER_MATCH");
  });

  it("rejects ambiguous and reversed or overlapping evidence", () => {
    let ambiguous = prototypeClaimInput();
    const content = "fact and fact";
    ambiguous = replaceArtifactContent(ambiguous, content);
    ambiguous.bundle.captures[0]!.contentArtifact.digest = sha256Digest(content);
    ambiguous.bundle.captures[0]!.contentArtifact.byteLength = content.length;
    const edge = ambiguous.bundle.assertions[0]!.evidence[0]!;
    edge.fragment.selector = {
      kind: "text_quote",
      quote: "fact",
      normalization: "none",
    };
    delete edge.expectedSelectedContentDigest;
    expect(verifyDeterministicBundle(ambiguous).summary.failedCheckCodes).toContain("LOCATOR_UNIQUE");

    const reversed = prototypeClaimInput();
    const reversedEdge = reversed.bundle.assertions[0]!.evidence[0]!;
    reversedEdge.fragment.selector = {
      kind: "multi_fragment_text",
      fragments: [
        {
          kind: "character_position",
          start: 7,
          end: 10,
          offsetBasis: "utf16_code_units",
          normalization: "none",
        },
        {
          kind: "character_position",
          start: 0,
          end: 5,
          offsetBasis: "utf16_code_units",
          normalization: "none",
        },
      ],
      joiner: " … ",
    };
    delete reversedEdge.expectedSelectedContentDigest;
    expect(verifyDeterministicBundle(reversed).summary.failedCheckCodes).toContain("LOCATOR_UNIQUE");

    for (const fragments of [
      [
        {
          kind: "character_position" as const,
          start: 0,
          end: 5,
          offsetBasis: "utf16_code_units" as const,
          normalization: "none" as const,
        },
        {
          kind: "character_position" as const,
          start: 0,
          end: 5,
          offsetBasis: "utf16_code_units" as const,
          normalization: "none" as const,
        },
      ],
      [
        {
          kind: "character_position" as const,
          start: 0,
          end: 8,
          offsetBasis: "utf16_code_units" as const,
          normalization: "none" as const,
        },
        {
          kind: "character_position" as const,
          start: 5,
          end: 12,
          offsetBasis: "utf16_code_units" as const,
          normalization: "none" as const,
        },
      ],
    ]) {
      const invalid = prototypeClaimInput();
      const invalidEdge = invalid.bundle.assertions[0]!.evidence[0]!;
      invalidEdge.fragment.selector = {
        kind: "multi_fragment_text",
        fragments,
        joiner: " … ",
      };
      delete invalidEdge.expectedSelectedContentDigest;
      expect(verifyDeterministicBundle(invalid).summary.failedCheckCodes).toContain("LOCATOR_UNIQUE");
    }
  });

  it("never improves eligibility as valid evidence is degraded", () => {
    const valid = prototypeClaimInput();
    let ambiguous = clone(valid);
    const content = "RAG was basically just a hack; RAG was basically just a hack";
    ambiguous = replaceArtifactContent(ambiguous, content);
    ambiguous.bundle.captures[0]!.contentArtifact.digest = sha256Digest(content);
    ambiguous.bundle.captures[0]!.contentArtifact.byteLength = content.length;
    delete ambiguous.bundle.assertions[0]!.evidence[0]!.expectedSelectedContentDigest;
    const tampered = clone(ambiguous);
    tampered.bundle.captures[0]!.contentArtifact.digest = sha256Digest("different");
    const rank = { passed: 2, review_required: 1, failed: 0 } as const;
    const statuses = [valid, ambiguous, tampered].map((input) => verifyDeterministicBundle(input).status);
    expect(statuses).toEqual(["passed", "failed", "failed"]);
    expect(statuses.every((status, index) => index === 0 || rank[status] <= rank[statuses[index - 1]!])).toBe(true);
  });
});

describe("metric evidence and calculation graph", () => {
  it("rejects a correct-looking value bound to the wrong source fragment", () => {
    const input = prototypeMetricInput();
    const total = input.bundle.metricObservations.find((metric) => metric.observationId === "npm-downloads-30d")!;
    total.evidence.find((edge) => edge.evidenceId === "value-total")!.fragment.selector = {
      kind: "json_pointer",
      pointer: "/day1",
    };
    total.evidence.find((edge) => edge.evidenceId === "value-total")!.expectedSelectedContentDigest =
      sha256Digest("10");
    expect(verifyDeterministicBundle(input).summary.failedCheckCodes).toContain("METRIC_FACET_SOURCE_BOUND");
  });

  it("rejects fabricated, missing, failed, and cyclic operands", () => {
    const fabricated = prototypeMetricInput();
    fabricated.bundle.metricObservations[2]!.calculation!.operands[0]!.value = "999";
    expect(verifyDeterministicBundle(fabricated).summary.failedCheckCodes).toContain("CALCULATION_OPERAND_VALUE_BOUND");

    const missing = prototypeMetricInput();
    missing.bundle.metricObservations.splice(1, 1);
    expect(verifyDeterministicBundle(missing).summary.failedCheckCodes).toContain("CALCULATION_OPERAND_PRESENT");

    const failed = prototypeMetricInput();
    failed.bundle.metricObservations[0]!.evidenceBindings[0]!.expectedLiteral = "11";
    expect(verifyDeterministicBundle(failed).summary.failedCheckCodes).toContain("CALCULATION_OPERAND_VERIFIED");

    const cyclic = prototypeMetricInput();
    cyclic.bundle.metricObservations[0]!.calculation = {
      operation: "identity",
      operands: [{ observationId: "npm-downloads-30d", value: "25" }],
      expectedResult: "10",
      rounding: { mode: "none", decimalPlaces: 0 },
      tolerance: "0",
      operationVersion: "decimal.v1",
    };
    expect(verifyDeterministicBundle(cyclic).summary.failedCheckCodes).toContain("CALCULATION_GRAPH_ACYCLIC");
  });
});

describe("canonical JSON and exact decimal replay", () => {
  it("matches stable ordering and ECMAScript number serialization", () => {
    expect(canonicalizeJson({ z: 1e30, a: 0.002, n: 1e-27 })).toBe('{"a":0.002,"n":1e-27,"z":1e+30}');
    expect(canonicalizeJson({ "€": "euro", "\r": "cr", "1": "one" })).toBe('{"\\r":"cr","1":"one","€":"euro"}');
  });

  it("rejects lone surrogates, nonfinite values, and non-JSON object classes", () => {
    expect(() => canonicalizeJson("\ud800")).toThrow(/surrogate/);
    expect(() => canonicalizeJson({ ["\udc00"]: true })).toThrow(/surrogate/);
    expect(() => canonicalizeJson(Number.NaN)).toThrow(/non-finite/);
    expect(() => canonicalizeJson(new Date())).toThrow(/plain objects/);
    expect(() => canonicalizeJson(new Map())).toThrow(/plain objects/);
  });

  it("enforces operation cardinality and exact rounding", () => {
    expect(() => replayDecimalOperation("identity", ["1", "2"])).toThrow(/exactly one/);
    expect(() => replayDecimalOperation("ratio", ["1"])).toThrow(/exactly two/);
    expect(formatRoundedDecimal(replayDecimalOperation("ratio", ["1", "8"]), 3, "none")).toBe("0.125");
    expect(formatRoundedDecimal(replayDecimalOperation("percent_change", ["10", "15"]), 0, "half_even")).toBe("50");
  });
});
