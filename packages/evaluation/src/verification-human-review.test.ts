import { describe, expect, it } from "vitest";
import { digestCanonicalJson } from "@aiengineer/knowledge-verification";
import { exportHumanReviewPack, importHumanAnnotations, renderHumanReviewHtml } from "./verification-human-review.js";

const makeInput = () => {
  const candidates = Array.from({ length: 150 }, (_, index) => ({
    candidateId: `candidate-${index}`,
    fragmentId: `fragment-${index}`,
    sourceKey: "fixture-source",
    sourceClass: "publication",
    captureId: `capture-${index}`,
    projectionArtifactId: `projection-${index}`,
    projectionDigest: digestCanonicalJson(`projection-${index}`),
    selector: { kind: "html", domPath: `${index}` },
    selectedContentDigest: digestCanonicalJson(`excerpt-${index}`),
    labelStatus: "annotation_pending",
    independentObservation: false,
  }));
  const fragments = candidates.map((item) => ({
    candidateId: item.fragmentId,
    captureId: item.captureId,
    exactText: `excerpt-${Number(item.candidateId.slice(10))}`,
    projectionArtifactId: item.projectionArtifactId,
    projectionDigest: item.projectionDigest,
    selectedContentDigest: item.selectedContentDigest,
    selector: item.selector,
    sourceClass: item.sourceClass,
    sourceKey: item.sourceKey,
    transformationArtifactId: `transform-${item.candidateId}`,
    rights: "restricted",
  }));
  return {
    sourcePreparationManifestDigest: digestCanonicalJson("source"),
    candidatePoolDigest: digestCanonicalJson(candidates),
    candidates,
    fragments,
  };
};

describe("diagnostics human annotation pack", () => {
  it("binds exact excerpts, leaves candidates unlabeled, and records one human annotator", () => {
    const pack = exportHumanReviewPack(makeInput());
    expect(pack.candidateCount).toBe(150);
    expect(pack.cases[0]).toMatchObject({ atomizationStatus: "candidate_requires_atomization", labels: null });
    const first = pack.cases[0]!;
    expect(
      importHumanAnnotations(pack, {
        schemaVersion: pack.schemaVersion,
        packDigest: pack.packDigest,
        annotatorIdentity: "human-1",
        annotatorQualification: "research reviewer",
        annotatorCount: 1,
        provenance: "human_single_annotator",
        submittedAt: "2026-09-06T00:00:00.000Z",
        labels: [
          {
            caseId: first.caseId,
            label: "abstain",
            rationale: "Candidate requires atomization.",
            excerptDigest: first.excerptDigest,
            atomicProposition: "A human-authored atomic proposition.",
            qualifiers: ["Fixture qualifier"],
          },
        ],
      }),
    ).toMatchObject({ status: "human_single_annotator", annotatedCaseCount: 1 });
  });

  it("rejects missing identity, duplicate cases, and tampered or unknown labels", () => {
    const pack = exportHumanReviewPack(makeInput());
    const first = pack.cases[0]!;
    const base = {
      schemaVersion: pack.schemaVersion,
      packDigest: pack.packDigest,
      annotatorIdentity: "human-1",
      annotatorQualification: "qualified",
      annotatorCount: 1 as const,
      provenance: "human_single_annotator" as const,
      submittedAt: "2026-09-06T00:00:00.000Z",
    };
    expect(() => importHumanAnnotations(pack, { ...base, annotatorIdentity: "", labels: [] })).toThrow(
      "IDENTITY_REQUIRED",
    );
    const label = {
      caseId: first.caseId,
      label: "abstain" as const,
      rationale: "r",
      excerptDigest: first.excerptDigest,
      atomicProposition: "Atomic fixture proposition",
      qualifiers: [],
    };
    expect(() => importHumanAnnotations(pack, { ...base, labels: [label, label] })).toThrow("UNKNOWN_OR_DUPLICATE");
    expect(() =>
      importHumanAnnotations(pack, { ...base, labels: [{ ...label, excerptDigest: digestCanonicalJson("tampered") }] }),
    ).toThrow("TAMPERED");
    expect(() => importHumanAnnotations(pack, { ...base, labels: [{ ...label, caseId: "unknown" }] })).toThrow(
      "UNKNOWN_OR_DUPLICATE",
    );
  });
  it("recomputes pack integrity and rejects fragment custody collisions and oversized evidence", () => {
    const input = makeInput(),
      pack = exportHumanReviewPack(input);
    const changed = structuredClone(pack);
    changed.cases[0]!.excerptDigest = digestCanonicalJson("forged");
    expect(() =>
      importHumanAnnotations(changed, {
        schemaVersion: pack.schemaVersion,
        packDigest: pack.packDigest,
        annotatorIdentity: "a",
        annotatorQualification: "q",
        annotatorCount: 1,
        provenance: "human_single_annotator",
        submittedAt: "2026-09-06T00:00:00.000Z",
        labels: [],
      }),
    ).toThrow("PACK_DIGEST_MISMATCH");
    expect(() =>
      exportHumanReviewPack({
        ...input,
        fragments: [
          ...input.fragments.slice(1),
          { ...input.fragments[0]!, candidateId: "fragment-0", sourceKey: "forged" },
        ],
      }),
    ).toThrow("FRAGMENT_BINDING_MISSING");
    expect(() =>
      exportHumanReviewPack({
        ...input,
        fragments: input.fragments.map((x, i) => (i === 0 ? { ...x, exactText: "x".repeat(2001) } : x)),
      }),
    ).toThrow("EXCERPT_TOO_LARGE");
  });
  it("renders an initially blank offline submission export with reviewer fields and exact digests", () => {
    const pack = exportHumanReviewPack(makeInput()),
      html = renderHumanReviewHtml(pack),
      first = pack.cases[0]!;
    expect(html).toContain('id="identity"');
    expect(html).toContain('id="qualification"');
    expect(html).toContain('id="export"');
    expect(html).toContain(`"packDigest":"${pack.packDigest}"`);
    expect(html).toContain(`"caseId":"${first.caseId}"`);
    expect(html).toContain(`"excerptDigest":"${first.excerptDigest}"`);
    expect(html).toContain('<option value="">select one</option>');
    expect(html).toContain("Atomic proposition");
    expect(html).toMatch(/candidate requires human atomization/iu);
  });
  it("requires a proposition, canonical timestamp, unique fragment binding, and safely serializes hostile case data", () => {
    const input = makeInput(),
      pack = exportHumanReviewPack(input),
      first = pack.cases[0]!;
    const base = {
      schemaVersion: pack.schemaVersion,
      packDigest: pack.packDigest,
      annotatorIdentity: "a",
      annotatorQualification: "q",
      annotatorCount: 1 as const,
      provenance: "human_single_annotator" as const,
      submittedAt: "2026-09-06T00:00:00.000Z",
    };
    const label = {
      caseId: first.caseId,
      label: "abstain" as const,
      rationale: "r",
      excerptDigest: first.excerptDigest,
      atomicProposition: "",
      qualifiers: [],
    };
    expect(() => importHumanAnnotations(pack, { ...base, labels: [label] })).toThrow("LABEL_INVALID");
    const firstImport = importHumanAnnotations(pack, {
      ...base,
      labels: [{ ...label, atomicProposition: "A proposition bound to this submission." }],
    });
    const changedProposition = importHumanAnnotations(pack, {
      ...base,
      labels: [{ ...label, atomicProposition: "A different proposition." }],
    });
    expect(changedProposition.submissionDigest).not.toBe(firstImport.submissionDigest);
    expect(() => importHumanAnnotations(pack, { ...base, submittedAt: "2026-09-06T00:00:00Z", labels: [] })).toThrow(
      "SUBMITTED_AT_INVALID",
    );
    expect(() => exportHumanReviewPack({ ...input, fragments: [...input.fragments, input.fragments[0]!] })).toThrow(
      "FRAGMENT_DUPLICATE",
    );
    expect(() =>
      exportHumanReviewPack({
        ...input,
        candidates: [...input.candidates, { ...input.candidates[0]!, candidateId: "candidate-fragment-collision" }],
      }),
    ).toThrow("FRAGMENT_ID_DUPLICATE");
    const hostile = structuredClone(pack);
    hostile.cases[0]!.caseId = "</script><img src=x onerror=alert(1)>";
    const html = renderHumanReviewHtml(hostile);
    expect(html).not.toContain("</script><img");
    expect(html).toContain("\\u003c/script\\u003e");
  });
});
