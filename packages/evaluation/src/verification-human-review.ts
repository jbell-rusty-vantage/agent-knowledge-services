import { canonicalizeJson, sha256Digest } from "@aiengineer/knowledge-verification";

export const HUMAN_ANNOTATION_PACK_VERSION = "verification-human-annotation-pack.v3" as const;
export const HUMAN_LABELS = [
  "directly_supported",
  "supported_with_qualification",
  "partially_supported",
  "contradicted",
  "not_supported",
  "insufficient_evidence",
  "context_only",
  "unverifiable",
  "abstain",
] as const;
export type HumanSemanticLabel = (typeof HUMAN_LABELS)[number];

interface Candidate {
  candidateId: string;
  fragmentId: string;
  sourceKey: string;
  sourceClass: string;
  captureId: string;
  projectionArtifactId: string;
  projectionDigest: string;
  selector: unknown;
  selectedContentDigest: string;
  labelStatus: string;
  independentObservation: boolean;
}
interface Fragment {
  candidateId: string;
  captureId: string;
  exactText: string;
  projectionArtifactId: string;
  projectionDigest: string;
  selectedContentDigest: string;
  selector: unknown;
  sourceClass: string;
  sourceKey: string;
  transformationArtifactId: string;
  rights: string;
}
export interface HumanReviewPackCase {
  caseId: string;
  candidateId: string;
  sourceKey: string;
  sourceClass: string;
  captureId: string;
  projectionArtifactId: string;
  projectionDigest: string;
  selector: unknown;
  fragmentId: string;
  exactExcerpt: string;
  excerptDigest: `sha256:${string}`;
  selectedContentDigest: string;
  atomizationStatus: "candidate_requires_atomization";
  atomicProposition: "";
  qualifiers: readonly string[];
  labels: null;
}
export interface HumanReviewPack {
  schemaVersion: typeof HUMAN_ANNOTATION_PACK_VERSION;
  status: "awaiting_human_annotation";
  sourcePreparationManifestDigest: string;
  candidatePoolDigest: string;
  candidateCount: number;
  limitation: string;
  labelChoices: readonly string[];
  cases: readonly HumanReviewPackCase[];
  packDigest: `sha256:${string}`;
}

const digest = (value: unknown): `sha256:${string}` => sha256Digest(canonicalizeJson(value));
const escapeHtml = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
/** D-013 permits 2,000 UTF-16 characters for this local human-review surface. */
const EXCERPT_LIMIT = 2000;
const excerpt = (value: string): string => {
  if (value.length > EXCERPT_LIMIT) throw new Error("HUMAN_REVIEW_EXCERPT_TOO_LARGE");
  return value;
};

export function exportHumanReviewPack(input: {
  readonly sourcePreparationManifestDigest: string;
  readonly candidatePoolDigest: string;
  readonly candidates: readonly Candidate[];
  readonly fragments: readonly Fragment[];
}): HumanReviewPack {
  if (input.candidates.length < 150 || input.candidates.length > 300)
    throw new Error("HUMAN_REVIEW_CANDIDATE_COUNT_INVALID");
  const byKey = new Map<string, Fragment>();
  for (const item of input.fragments) {
    if (byKey.has(item.candidateId)) throw new Error("HUMAN_REVIEW_FRAGMENT_DUPLICATE");
    byKey.set(item.candidateId, item);
  }
  const seen = new Set<string>(),
    fragmentIds = new Set<string>();
  const cases = input.candidates.map((candidate) => {
    if (seen.has(candidate.candidateId)) throw new Error("HUMAN_REVIEW_CANDIDATE_DUPLICATE");
    seen.add(candidate.candidateId);
    if (fragmentIds.has(candidate.fragmentId)) throw new Error("HUMAN_REVIEW_FRAGMENT_ID_DUPLICATE");
    fragmentIds.add(candidate.fragmentId);
    if (candidate.labelStatus !== "annotation_pending" || candidate.independentObservation)
      throw new Error("HUMAN_REVIEW_CANDIDATE_ALREADY_LABELLED");
    const fragment = byKey.get(candidate.fragmentId);
    if (
      !fragment ||
      fragment.selectedContentDigest !== candidate.selectedContentDigest ||
      fragment.captureId !== candidate.captureId ||
      fragment.projectionArtifactId !== candidate.projectionArtifactId ||
      fragment.projectionDigest !== candidate.projectionDigest ||
      fragment.sourceKey !== candidate.sourceKey ||
      fragment.sourceClass !== candidate.sourceClass ||
      canonicalizeJson(fragment.selector) !== canonicalizeJson(candidate.selector)
    )
      throw new Error(`HUMAN_REVIEW_FRAGMENT_BINDING_MISSING:${candidate.candidateId}`);
    const exactExcerpt = excerpt(fragment.exactText);
    return {
      caseId: `candidate-review-${candidate.candidateId}`,
      candidateId: candidate.candidateId,
      sourceKey: candidate.sourceKey,
      sourceClass: candidate.sourceClass,
      captureId: candidate.captureId,
      projectionArtifactId: candidate.projectionArtifactId,
      projectionDigest: candidate.projectionDigest,
      selector: candidate.selector,
      fragmentId: candidate.fragmentId,
      exactExcerpt,
      excerptDigest: digest(exactExcerpt),
      selectedContentDigest: candidate.selectedContentDigest,
      atomizationStatus: "candidate_requires_atomization" as const,
      atomicProposition: "" as const,
      qualifiers: [],
      labels: null,
    };
  });
  const material = {
    schemaVersion: HUMAN_ANNOTATION_PACK_VERSION,
    status: "awaiting_human_annotation" as const,
    sourcePreparationManifestDigest: input.sourcePreparationManifestDigest,
    candidatePoolDigest: input.candidatePoolDigest,
    candidateCount: cases.length,
    limitation:
      "These are source-bound fragment candidates, not atomic assertions or independent observations. Human atomization is required before labels can become benchmark gold.",
    labelChoices: HUMAN_LABELS,
    cases,
  };
  return structuredClone(Object.freeze({ ...material, packDigest: digest(material) }));
}

export interface HumanAnnotationSubmission {
  schemaVersion: typeof HUMAN_ANNOTATION_PACK_VERSION;
  packDigest: string;
  annotatorIdentity: string;
  annotatorQualification: string;
  annotatorCount: 1;
  provenance: "human_single_annotator";
  submittedAt: string;
  labels: readonly {
    caseId: string;
    label: HumanSemanticLabel;
    rationale: string;
    excerptDigest: string;
    atomicProposition: string;
    qualifiers: readonly string[];
  }[];
}
export function importHumanAnnotations(
  pack: HumanReviewPack,
  submission: HumanAnnotationSubmission,
): {
  status: "human_single_annotator";
  annotatorCount: 1;
  annotatedCaseCount: number;
  submissionDigest: `sha256:${string}`;
} {
  const { packDigest: _provided, ...material } = pack;
  if (
    digest(material) !== pack.packDigest ||
    submission.schemaVersion !== HUMAN_ANNOTATION_PACK_VERSION ||
    submission.packDigest !== pack.packDigest
  )
    throw new Error("HUMAN_REVIEW_PACK_DIGEST_MISMATCH");
  if (!submission.annotatorIdentity.trim() || !submission.annotatorQualification.trim())
    throw new Error("HUMAN_REVIEW_ANNOTATOR_IDENTITY_REQUIRED");
  if (submission.annotatorCount !== 1 || submission.provenance !== "human_single_annotator")
    throw new Error("HUMAN_REVIEW_PROVENANCE_INVALID");
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(submission.submittedAt) ||
    new Date(submission.submittedAt).toISOString() !== submission.submittedAt
  )
    throw new Error("HUMAN_REVIEW_SUBMITTED_AT_INVALID");
  const allowed = new Set<string>(HUMAN_LABELS),
    cases = new Map(pack.cases.map((item) => [item.caseId, item]));
  const seen = new Set<string>();
  for (const item of submission.labels) {
    const target = cases.get(item.caseId);
    if (!target || seen.has(item.caseId)) throw new Error("HUMAN_REVIEW_CASE_UNKNOWN_OR_DUPLICATE");
    if (
      !allowed.has(item.label) ||
      !item.rationale.trim() ||
      !item.atomicProposition.trim() ||
      item.atomicProposition.length > 1000 ||
      !Array.isArray(item.qualifiers) ||
      item.qualifiers.some((q) => !q.trim() || q.length > 500) ||
      item.excerptDigest !== target.excerptDigest
    )
      throw new Error("HUMAN_REVIEW_LABEL_INVALID_OR_TAMPERED");
    seen.add(item.caseId);
  }
  return {
    status: "human_single_annotator",
    annotatorCount: 1,
    annotatedCaseCount: seen.size,
    submissionDigest: digest(submission),
  };
}

export function renderHumanReviewHtml(pack: HumanReviewPack): string {
  const options = pack.labelChoices
    .map((label) => `<option value="${escapeHtml(label)}">${escapeHtml(label)}</option>`)
    .join("");
  const rows = pack.cases
    .map(
      (item, index) =>
        `<article><h2>${escapeHtml(item.caseId)}</h2><p>Candidate requires human atomization. Write an atomic proposition and material qualifiers before assigning an entailment label.</p><p><b>Source:</b> ${escapeHtml(item.sourceKey)} (${escapeHtml(item.sourceClass)})</p><blockquote>${escapeHtml(item.exactExcerpt)}</blockquote><label>Atomic proposition <textarea id="p-${index}"></textarea></label><label>Qualifiers (one per line) <textarea id="q-${index}"></textarea></label><label>Human label <select id="l-${index}"><option value="">select one</option>${options}</select></label><label>Rationale <textarea id="r-${index}"></textarea></label></article>`,
    )
    .join("\n");
  const safeJson = (value: unknown) =>
    JSON.stringify(value)
      .replace(/</gu, "\\u003c")
      .replace(/>/gu, "\\u003e")
      .replace(/&/gu, "\\u0026")
      .replace(/\u2028/gu, "\\u2028")
      .replace(/\u2029/gu, "\\u2029");
  const data = safeJson({
    schemaVersion: pack.schemaVersion,
    packDigest: pack.packDigest,
    annotatorCount: 1,
    provenance: "human_single_annotator",
    cases: pack.cases.map((x) => ({ caseId: x.caseId, excerptDigest: x.excerptDigest })),
  });
  return `<!doctype html><meta charset="utf-8"><title>Diagnostics companies human review</title><style>body{font:16px sans-serif;max-width:960px;margin:2rem auto}article{border:1px solid #ccc;padding:1rem;margin:1rem 0}blockquote{white-space:pre-wrap;background:#f5f5f5;padding:1rem}textarea{width:100%;min-height:4rem}</style><h1>Diagnostics companies human annotation queue</h1><p>Every row is unlabeled. This page exports a submission; it does not certify human identity.</p><label>Annotator identity <input id="identity"></label><label>Qualification <input id="qualification"></label><button id="export">Download submission JSON</button>${rows}<script>const d=${data};document.getElementById('export').onclick=()=>{let p={...d,annotatorIdentity:document.getElementById('identity').value,annotatorQualification:document.getElementById('qualification').value,submittedAt:new Date().toISOString()};p.labels=d.cases.flatMap((x,i)=>{let l=document.getElementById('l-'+i).value;return l?[{...x,label:l,rationale:document.getElementById('r-'+i).value,atomicProposition:document.getElementById('p-'+i).value,qualifiers:document.getElementById('q-'+i).value.split('\\n').map(x=>x.trim()).filter(Boolean)}]:[]});delete p.cases;let a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(p,null,2)],{type:'application/json'}));a.download='human-review-submission.json';a.click()};</script>`;
}
