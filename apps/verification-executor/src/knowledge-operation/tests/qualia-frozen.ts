import { type FrozenReportBinding, biotechReportKind } from "@aiengineer/knowledge-binding-biotech-graph";
import { type Ref, digestBytes, digestCanonical, sameRef } from "@aiengineer/knowledge-operation-protocol";
import {
  type AssertionVersion,
  type EvidenceFragment,
  type ReportLedger,
  type ReportRevision,
  type SupportSet,
  type SupportObservation,
  type VerificationObservation,
  type VerificationRun,
  type Inline,
  ReportLedgerSchema,
  StructuredBodySchema,
  recordRef,
  renderReport,
} from "@aiengineer/knowledge-research-core";
import { type CapturedSource, selectQualiaCapture } from "./qualia-captures.js";

export interface QualiaFragmentCaptureBinding {
  fragment: Ref<"fragment">;
  captureId: string;
  sourceUrl: string;
  capture: Ref<"artifact">;
}
export interface FrozenQualiaAssertion {
  id: string;
  proposition: string;
  qualifiers: AssertionVersion["qualifiers"];
  evidence: Array<{ captureId: string; sourceUrl: string; quote: string; fragmentId: string; fragmentDigest: string }>;
  declaredEvidence: FrozenQualiaAssertion["evidence"];
  observedEvidence: FrozenQualiaAssertion["evidence"];
  judgments: Array<{
    id: string;
    digest: string;
    outcome: SupportObservation["outcome"];
    rationale: string;
    method: Ref<"method">;
    qualifiersDigest: string;
    target: SupportObservation["target"];
    observation: SupportObservation;
    evidence: FrozenQualiaAssertion["evidence"];
  }>;
}
export interface FrozenQualiaReport extends FrozenReportBinding {
  assertions: FrozenQualiaAssertion[];
}

/** Capture identity is bound by the trusted preparer, then checked against registered fragment records. */
export function retainQualiaFragmentBinding(
  bindings: Map<string, QualiaFragmentCaptureBinding>,
  fragment: Ref<"fragment">,
  source: CapturedSource,
) {
  if (!source.captureId) throw new Error("Registered Qualia fragments require a retained capture identity");
  const binding = { fragment, captureId: source.captureId, sourceUrl: source.url, capture: source.ref };
  const prior = bindings.get(fragment.digest);
  if (prior && digestCanonical({ ...prior }) !== digestCanonical(binding))
    throw new Error("Frozen fragment was rebound to another captured source identity");
  bindings.set(fragment.digest, binding);
}

/** Load truthful projection inputs only; this is neither a verdict nor a native write authorization. */
export async function hydrateQualiaFrozenReport(input: {
  report: Ref<"report">;
  context: {
    report: { revision: ReportRevision; ledger: ReportLedger } | null;
    assertions: readonly AssertionVersion[];
    supportSets: readonly SupportSet[];
    observations: readonly VerificationObservation[];
    run?: VerificationRun | null;
  };
  sources: Iterable<CapturedSource>;
  fragmentBindings: ReadonlyMap<string, QualiaFragmentCaptureBinding>;
  loadFragments(refs: readonly Ref<"fragment">[]): Promise<readonly EvidenceFragment[]>;
  readArtifact(ref: Ref<"artifact">): Promise<Uint8Array>;
  /** Maps the registered kind to the binding's report kind; Biotech's refuses unmaterialized kinds. */
  reportKind?: (kindId: string) => FrozenReportBinding["reportKind"];
}): Promise<FrozenQualiaReport> {
  const stored = input.context.report;
  if (!stored || !sameRef(recordRef("report", stored.revision), input.report))
    throw new Error("Frozen report identity or digest mismatch");
  const revision = stored.revision;
  const bytes = async (ref: Ref<"artifact">) => {
    if (ref.tenant !== input.report.tenant || ref.binding !== input.report.binding)
      throw new Error("Frozen custody scope mismatch");
    const value = await input.readArtifact(ref);
    if (digestBytes(value) !== ref.digest) throw new Error("Frozen custody bytes digest mismatch");
    return value;
  };
  if (revision.bodyDigest !== revision.body.digest) throw new Error("Frozen body digest mismatch");
  await bytes(revision.body);
  const ledger = ReportLedgerSchema.parse(JSON.parse(Buffer.from(await bytes(revision.ledger)).toString("utf8")));
  if (digestCanonical(ledger) !== digestCanonical(stored.ledger) || !sameRef(ledger.body, revision.body))
    throw new Error("Frozen report ledger mismatch");
  const structured = StructuredBodySchema.parse(
    JSON.parse(Buffer.from(await bytes(revision.structuredBody)).toString("utf8")),
  );
  if (renderReport(structured).bodyDigest !== revision.bodyDigest)
    throw new Error("Frozen structured report body mismatch");
  const reportFragments = new Map<string, Ref<"fragment">>();
  const collect = (inlines: readonly Inline[]) => {
    for (const inline of inlines)
      if (inline.type === "citation") reportFragments.set(digestCanonical(inline.fragment), inline.fragment);
  };
  for (const section of structured.sections) {
    collect(section.heading);
    for (const block of section.blocks) {
      if (block.type === "paragraph") collect(block.inlines);
      else if (block.type === "list") block.items.forEach(collect);
      else if (block.type === "table") {
        block.header.forEach(collect);
        block.rows.forEach((row) => row.forEach(collect));
        collect(block.caption ?? []);
      }
    }
  }
  const sources = [...input.sources];
  const assertions: FrozenQualiaAssertion[] = [];
  const ids = new Set<string>();
  for (const assertionRef of revision.assertions) {
    if (ids.has(assertionRef.id)) throw new Error("Duplicate frozen assertion identity");
    ids.add(assertionRef.id);
    const matches = input.context.assertions.filter((assertion) =>
      sameRef(recordRef("assertion", assertion), assertionRef),
    );
    const assertion = matches[0];
    if (
      matches.length !== 1 ||
      !assertion ||
      assertionRef.tenant !== input.report.tenant ||
      assertionRef.binding !== input.report.binding
    )
      throw new Error("Frozen assertion identity or digest mismatch");
    if (!ledger.entries.some((entry) => sameRef(entry.assertion, assertionRef)))
      throw new Error("Frozen assertion missing from the actual ledger");
    const sets = input.context.supportSets.filter(
      (set) => sameRef(set.assertion, assertionRef) && set.provenance === "declared_citation",
    );
    if (!sets.length) throw new Error("Frozen assertion has no declared support evidence");
    const refs = new Map<string, Ref<"fragment">>();
    for (const set of sets) {
      if (
        set.tenant !== input.report.tenant ||
        set.binding !== input.report.binding ||
        set.qualifiersDigest !== digestCanonical(assertion.qualifiers)
      )
        throw new Error("Frozen support qualifiers or scope mismatch");
      if (set.contrary.length || set.required.some((premise) => premise.derivedFrom.length))
        throw new Error("Qualia native projection requires direct declared source evidence only");
      for (const ref of set.required.flatMap((premise) => premise.evidence)) {
        if (ref.tenant !== input.report.tenant || ref.binding !== input.report.binding)
          throw new Error("Frozen fragment scope mismatch");
        refs.set(digestCanonical(ref), ref);
      }
    }
    if (!refs.size) throw new Error("Frozen assertion has no source fragments");
    const declaredKeys = new Set(refs.keys());
    const observedKeys = new Set<string>();
    for (const observation of input.context.observations) {
      if (observation.property !== "support" || !sets.some((set) => set.id === observation.target.id)) continue;
      if (!sets.some((set) => sameRef(recordRef("support_set", set), observation.target)))
        throw new Error("Actual support observation target digest mismatch");
      for (const ref of [
        ...observation.evidence,
        ...observation.outcome.citedFragments,
        ...observation.outcome.contradictingFragments,
      ]) {
        const key = digestCanonical(ref);
        if (!reportFragments.has(key))
          throw new Error("Actual support observation cites unknown, altered or out-of-report frozen evidence");
        refs.set(key, ref);
        observedKeys.add(key);
      }
    }
    if ([...refs.keys()].some((key) => !reportFragments.has(key)))
      throw new Error("Declared support fragment is outside the frozen report citations");
    const declaredDigests = new Set([...declaredKeys].map((key) => reportFragments.get(key)?.digest));
    const observedDigests = new Set([...observedKeys].map((key) => reportFragments.get(key)?.digest));
    const fragments = await input.loadFragments([...refs.values()]);
    const evidence: FrozenQualiaAssertion["evidence"] = [];
    for (const fragmentRef of refs.values()) {
      const matches = fragments.filter((fragment) => sameRef(recordRef("fragment", fragment), fragmentRef));
      const fragment = matches[0];
      const binding = input.fragmentBindings.get(fragmentRef.digest);
      if (matches.length !== 1 || !fragment || !binding || !sameRef(binding.fragment, fragmentRef))
        throw new Error("Frozen fragment identity, digest or registered capture binding mismatch");
      const source = selectQualiaCapture(sources, binding.sourceUrl, binding.captureId);
      if (
        !sameRef(binding.capture, source.ref) ||
        !sameRef(fragment.capture, source.ref) ||
        !sameRef(fragment.representation, source.ref)
      )
        throw new Error("Frozen fragment capture identity mismatch");
      const captured = await bytes(fragment.capture);
      if (Buffer.from(captured).toString("utf8") !== source.text)
        throw new Error("Frozen fragment retained bytes mismatch");
      const quote = fragment.selector.value;
      if (
        fragment.selector.kind !== "text_quote" ||
        !quote ||
        source.text.indexOf(quote) < 0 ||
        source.text.indexOf(quote) !== source.text.lastIndexOf(quote) ||
        fragment.selectedDigest !== digestBytes(quote) ||
        fragment.selectedSize !== Buffer.byteLength(quote) ||
        fragment.context.surroundingDigest !== source.ref.digest
      )
        throw new Error("Frozen fragment exact quote or selected digest mismatch");
      evidence.push({
        captureId: binding.captureId,
        sourceUrl: binding.sourceUrl,
        quote,
        fragmentId: fragment.id,
        fragmentDigest: fragmentRef.digest,
      });
    }
    const judgments: FrozenQualiaAssertion["judgments"] = [];
    for (const observation of input.context.observations) {
      if (observation.property !== "support" || !sets.some((set) => set.id === observation.target.id)) continue;
      if (!sets.some((set) => sameRef(recordRef("support_set", set), observation.target)))
        throw new Error("Actual support observation target digest mismatch");
      if (
        observation.tenant !== input.report.tenant ||
        observation.binding !== input.report.binding ||
        observation.method.tenant !== input.report.tenant ||
        observation.method.binding !== input.report.binding ||
        observation.qualifiersDigest !== digestCanonical(assertion.qualifiers) ||
        observation.evaluator.role !== "judge"
      )
        throw new Error("Actual support observation qualifiers, evaluator or scope mismatch");
      const observationRef = recordRef("observation", observation);
      if (
        input.context.run &&
        (!sameRef(input.context.run.report, input.report) ||
          !input.context.run.observations.some((ref) => sameRef(ref, observationRef)))
      )
        throw new Error("Actual support observation differs from frozen run identity");
      const linked = [
        ...observation.evidence,
        ...observation.outcome.citedFragments,
        ...observation.outcome.contradictingFragments,
      ];
      const linkedDigests = new Set(linked.map((ref) => ref.digest));
      if (observation.rawResponse) await bytes(observation.rawResponse);
      judgments.push({
        id: observation.id,
        digest: observationRef.digest,
        outcome: observation.outcome,
        rationale: observation.rationale,
        method: observation.method,
        qualifiersDigest: observation.qualifiersDigest,
        target: observation.target,
        observation,
        evidence: evidence.filter((item) => linkedDigests.has(item.fragmentDigest)),
      });
    }
    assertions.push({
      id: assertion.id,
      proposition: assertion.proposition,
      qualifiers: assertion.qualifiers,
      evidence,
      declaredEvidence: evidence.filter((item) => declaredDigests.has(item.fragmentDigest)),
      observedEvidence: evidence.filter((item) => observedDigests.has(item.fragmentDigest)),
      judgments,
    });
  }
  if (!assertions.length) throw new Error("Frozen report contains no assertions");
  return {
    reportRevisionId: revision.id,
    reportKind: (input.reportKind ?? biotechReportKind)(revision.kind.id),
    reportKindRef: revision.kind.id,
    reportSchema: revision.schemaVersion,
    bodyDigest: revision.bodyDigest,
    ledgerDigest: revision.ledger.digest,
    structuredBodyDigest: revision.structuredBody.digest,
    assertions,
  };
}
