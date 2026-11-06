import {
  digestBytes,
  digestCanonical,
  EvaluationContextSchema,
  type EvaluationContext,
  type Ref,
} from "@aiengineer/knowledge-operation-protocol";
import {
  DiscoveredOccurrenceSchema,
  UsageSchema,
  VerificationObservationSchema,
} from "@aiengineer/knowledge-research-core";

export function qualiaEvaluationRequest(value: unknown) {
  const context = EvaluationContextSchema.parse(value);
  const judge = context.role === "judge";
  const json_schema = judge
    ? {
        type: "object",
        additionalProperties: false,
        required: ["judgments"],
        properties: {
          judgments: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["setIndex", "verdict", "reason", "fragmentIndices", "unsupportedFacets", "qualification"],
              properties: {
                setIndex: { type: "integer" },
                verdict: {
                  type: "string",
                  enum: [
                    "full_support",
                    "qualified_support",
                    "partial_or_context_only",
                    "contradiction",
                    "conflict",
                    "insufficient_evidence",
                    "unable_to_assess",
                  ],
                },
                reason: { type: "string" },
                fragmentIndices: { type: "array", items: { type: "integer" } },
                unsupportedFacets: {
                  type: "array",
                  items: {
                    type: "string",
                    enum: [
                      "entity",
                      "coreference",
                      "quantity",
                      "denominator",
                      "unit",
                      "population",
                      "time",
                      "baseline",
                      "negation",
                      "modality",
                      "causal_wording",
                      "attribution",
                      "comparison",
                      "jurisdiction",
                    ],
                  },
                },
                qualification: { type: ["string", "null"] },
              },
            },
          },
        },
      }
    : {
        type: "object",
        additionalProperties: false,
        required: ["occurrences", "unitExplanations", "rationale", "limitations", "recallReason"],
        properties: {
          occurrences: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["quote", "blockPath", "assertionIndex", "negated", "interrogative"],
              properties: {
                quote: { type: "string" },
                blockPath: { type: "string" },
                assertionIndex: { type: ["integer", "null"] },
                negated: { type: "boolean" },
                interrogative: { type: "boolean" },
              },
            },
          },
          unitExplanations: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["path", "reason"],
              properties: { path: { type: "string" }, reason: { type: "string" } },
            },
          },
          rationale: { type: "string" },
          limitations: { type: "array", items: { type: "string" } },
          recallReason: { type: "string" },
        },
      };
  const prompt = judge
    ? "Act as an independent evidence judge. For EVERY indexed supportSets entry assess the entire assertion and its exact scientific qualifiers against only retained evidence. Return one judgment per set. fragmentIndices index context.evidence. Do not assume a benefit beyond study population, formulation, comparator, endpoint or duration. Source_report means attribution, not generalized truth. State unsupported facets and qualifications. full_support requires no unsupported facets and qualification:null. Keep uncertainty and adverse findings; never manufacture evidence."
    : "Act as an independent factual census auditor. Read the exact frozen body from scratch. Independently discover EVERY factual assertion occurrence, including ones absent from the supplied comparison assertions. Return exact quote, exact renderer unit blockPath, comparison assertionIndex if matched (otherwise null), and actual negation/question readings. Exclude section framing/bibliographic references with unitExplanations when needed. Do not infer an inventory from assertion count or any producer ledger. Judge neither medical benefit nor support here. Recall is unmeasured: supply an honest recallReason. The trusted host computes byte-bound spans and reconciliation from your discoveries.";
  return { context, prompt, json_schema, body: context.body.text };
}

/** Encode actual model-authored judgments/discoveries, preserving their failure/uncertainty, into published KS records. */
export async function qualiaEvaluationSubmission(input: {
  request: ReturnType<typeof qualiaEvaluationRequest>;
  answer: Record<string, any>;
  model: "gpt-6.1-sol" | "gpt-6.1-terra";
  rawResponse: string;
  usage: unknown;
  put(bytes: Uint8Array, mediaType: string): Promise<Ref<"artifact">>;
}) {
  if (!["gpt-6.1-sol", "gpt-6.1-terra"].includes(input.model) || !input.rawResponse)
    throw new Error("Actual permitted model and raw response are required");
  if (digestCanonical(JSON.parse(input.rawResponse)) !== digestCanonical(input.answer))
    throw new Error("Submitted evaluation differs from actual model response JSON");
  const context = input.request.context;
  const usage = UsageSchema.parse(input.usage);
  if (usage.providerCalls < 1) throw new Error("A real evaluator model call is required");
  const rawResponse = await input.put(Buffer.from(input.rawResponse), "application/json");
  const methodDocument = {
    schemaVersion: "qualia-evidence-evaluation.v1",
    prompt: input.request.prompt,
    json_schema: input.request.json_schema,
    model: input.model,
    contextRequest: context.request,
  };
  const methodArtifact = await input.put(Buffer.from(JSON.stringify(methodDocument)), "application/json");
  const method = { ...methodArtifact, kind: "method" as const, version: "qualia-evidence-evaluation.v1" };
  const evaluator = {
    role: context.role,
    kind: "model",
    provider: "openai",
    family: "gpt-6.1",
    model: input.model,
    deployment: "qualia-stagegraph-fixture",
    reviewerId: null,
    methodVersion: "qualia-evidence-evaluation.v1",
    promptDigest: digestBytes(input.request.prompt),
    configDigest: digestCanonical({ model: input.model, schema: input.request.json_schema }),
  };
  if (context.role === "judge") {
    if (!Array.isArray(input.answer.judgments)) throw new Error("Judge judgments array missing");
    const sets = context.supportSets ?? [];
    const seen = new Set<number>();
    const observations = input.answer.judgments.map((judgment: Record<string, any>, i: number) => {
      if (!Number.isInteger(judgment.setIndex) || seen.has(judgment.setIndex) || !sets[judgment.setIndex])
        throw new Error("Judge set index invalid or duplicate");
      seen.add(judgment.setIndex);
      const set = sets[judgment.setIndex]!;
      const record = set.record as Record<string, any>;
      const assertion = context.assertions.find((a) => (a.handle as Ref).digest === record.assertion.digest);
      if (!assertion) throw new Error("Support set assertion unavailable");
      if (!Array.isArray(judgment.fragmentIndices)) throw new Error("Judge evidence indices missing");
      const citedFragments = judgment.fragmentIndices.map((n: number) => {
        const evidence = context.evidence?.[n];
        if (!Number.isInteger(n) || !evidence) throw new Error("Judge evidence index invalid");
        return evidence.handle;
      });
      return VerificationObservationSchema.parse({
        schemaVersion: "research-core.observation.v2",
        id: `qualia-judge-${context.revision}-${i}`,
        tenant: context.report.tenant,
        binding: context.report.binding,
        target: set.handle,
        inputDigest: digestCanonical(
          JSON.parse(JSON.stringify({ set: set.record, assertion: assertion.record, evidence: context.evidence })),
        ),
        qualifiersDigest: assertion.qualifiersDigest,
        method,
        evaluator,
        rationale: judgment.reason,
        limitations: [],
        evidence: citedFragments,
        rawResponse,
        usage: i === 0 ? usage : { providerCalls: 0, tokens: 0, costUsd: "0" },
        recordedAt: new Date().toISOString().replace(/\.(\d*?)0+Z$/, (_m, d: string) => (d ? `.${d}Z` : "Z")),
        property: "support",
        outcome: {
          verdict: judgment.verdict,
          premise: null,
          citedFragments,
          contradictingFragments: judgment.verdict === "contradiction" ? citedFragments : [],
          unsupportedFacets: judgment.unsupportedFacets,
          qualification: judgment.qualification,
        },
      });
    });
    if (seen.size !== sets.length) throw new Error("Judge must explicitly assess every support set");
    return { schema: "report-observation.v1", report: context.report, observations, census: null };
  }
  if (context.role !== "auditor" || !Array.isArray(input.answer.occurrences))
    throw new Error("Auditor discoveries missing");
  const occurrences = input.answer.occurrences.map((found: Record<string, any>, i: number) => {
    const unit = context.units.find((u) => u.path === found.blockPath);
    if (!unit?.span || typeof found.quote !== "string" || !found.quote)
      throw new Error("Auditor unit or quote unavailable");
    const unitText = context.body.text.slice(unit.span.start, unit.span.end);
    const offset = unitText.indexOf(found.quote);
    if (offset < 0 || offset !== unitText.lastIndexOf(found.quote))
      throw new Error("Auditor quote does not uniquely resolve in claimed unit");
    const assertion = found.assertionIndex === null ? null : context.assertions[found.assertionIndex]?.handle;
    if (found.assertionIndex !== null && (!Number.isInteger(found.assertionIndex) || !assertion))
      throw new Error("Auditor assertion index invalid");
    return DiscoveredOccurrenceSchema.parse({
      schemaVersion: "research-core.discovered_occurrence.v1",
      id: `qualia-auditor-${context.revision}-${i}`,
      body: context.body.artifact,
      span: {
        basis: "utf16-code-units-v1",
        start: unit.span.start + offset,
        end: unit.span.start + offset + found.quote.length,
      },
      blockPath: unit.path,
      quoteDigest: digestBytes(found.quote),
      candidateAssertion: found.quote,
      assertion,
      negated: found.negated,
      interrogative: found.interrogative,
    });
  });
  return {
    schema: "report-observation.v1",
    report: context.report,
    observations: [],
    census: {
      evaluator,
      method,
      occurrences,
      explanations: [],
      unitExplanations: input.answer.unitExplanations,
      recall: { label: "unmeasured", reason: input.answer.recallReason },
      rationale: input.answer.rationale,
      limitations: input.answer.limitations,
      usage,
      rawResponse,
    },
  };
}
