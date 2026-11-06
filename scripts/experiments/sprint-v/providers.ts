import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AuditorDiscovery,
  CounterevidenceSearch,
  DiscoveryInput,
  DiscoveryResult,
  FetchLike,
  SourceAuthorityResolver,
} from "../../../packages/application/dist/index.js";
import {
  type Digest,
  type EvaluatorIdentity,
  type JsonValue,
  type Ref,
  digestBytes,
  digestCanonical,
} from "../../../packages/knowledge-operation-protocol/dist/index.js";
import {
  type AssertionVersion,
  type AuthScope,
  type CustodyStore,
  DISCOVERED_OCCURRENCE_SCHEMA_VERSION,
  type DiscoveredOccurrence,
  DiscoveredOccurrenceSchema,
  type EvidenceFragment,
  OBSERVATION_SCHEMA_VERSION,
  type SupportSet,
  type VerificationObservation,
  VerificationObservationSchema,
  isInterrogativeText,
  isNegatedText,
  qualifiersDigest,
  quoteDigest,
  recordRef,
  span,
} from "../../../packages/research-core/dist/index.js";
import type { Labels, ProducerDraft, SourceDoc, TaskSpec } from "./fixtures.js";
import { BudgetBlocked, type Meter, plannedMaxUsd, usageCostUsd } from "./meter.js";

// ---------------------------------------------------------------------------------------------------------------
// Credentials: loaded from an explicit env-file path into this process only. Values are never printed or recorded.
// ---------------------------------------------------------------------------------------------------------------
export class Credentials {
  readonly #values = new Map<string, string>();
  constructor(path: string, names: readonly string[]) {
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (!match || !names.includes(match[1] as string)) continue;
      let value = (match[2] as string).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (value.length > 0) this.#values.set(match[1] as string, value);
    }
  }
  has(name: string): boolean {
    return this.#values.has(name);
  }
  get(name: string): string {
    const value = this.#values.get(name);
    if (value === undefined) throw new Error(`CREDENTIAL_MISSING: ${name}`);
    return value;
  }
  /** Defensive scrub of any credential value from text written to receipts. */
  redact(text: string): string {
    let out = text;
    for (const value of this.#values.values()) if (value.length >= 8) out = out.split(value).join("[REDACTED]");
    return out;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Discovery: only an authenticated models/list call counts as a route.
// ---------------------------------------------------------------------------------------------------------------
export interface Discovery {
  readonly openai: { ok: boolean; status: number; count: number; gpt6: string[]; error: string | null };
  readonly anthropic: {
    ok: boolean;
    status: number;
    count: number;
    sonnet: { id: string; created_at: string | null }[];
    error: string | null;
  };
}

export async function discover(credentials: Credentials): Promise<Discovery> {
  const openai = await (async () => {
    if (!credentials.has("OPENAI_API_KEY")) return { ok: false, status: 0, count: 0, gpt6: [], error: "missing" };
    const response = await fetch("https://api.openai.com/v1/models", {
      headers: { authorization: `Bearer ${credentials.get("OPENAI_API_KEY")}` },
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok)
      return { ok: false, status: response.status, count: 0, gpt6: [], error: `http ${response.status}` };
    const body = (await response.json()) as { data: { id: string }[] };
    const gpt6 = body.data
      .map((model) => model.id)
      .filter((id) => id.startsWith("gpt-6"))
      .sort();
    return { ok: true, status: response.status, count: body.data.length, gpt6, error: null };
  })();
  const anthropic = await (async () => {
    if (!credentials.has("ANTHROPIC_API_KEY")) return { ok: false, status: 0, count: 0, sonnet: [], error: "missing" };
    const response = await fetch("https://api.anthropic.com/v1/models?limit=1000", {
      headers: { "x-api-key": credentials.get("ANTHROPIC_API_KEY"), "anthropic-version": "2023-06-01" },
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) {
      return { ok: false, status: response.status, count: 0, sonnet: [], error: `http ${response.status}` };
    }
    const body = (await response.json()) as { data: { id: string; created_at?: string }[] };
    const sonnet = body.data
      .filter((model) => model.id.includes("sonnet"))
      .map((model) => ({ id: model.id, created_at: model.created_at ?? null }))
      .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
    return { ok: true, status: response.status, count: body.data.length, sonnet, error: null };
  })();
  return { openai, anthropic };
}

export interface Pins {
  readonly producer: { provider: "openai"; model: string; requested: string; substituted: boolean };
  readonly judge: { provider: "openai"; model: string; requested: string; substituted: boolean };
  readonly secondFamily: { provider: "anthropic"; model: string; requested: string; substituted: boolean };
  readonly auditor: { provider: "anthropic"; model: string; requested: string; substituted: boolean };
}

/** Pins per the SV-09 brief; a substitution is recorded, never silent. Null when a route was not discovered. */
export function pin(discovery: Discovery): Pins | { blocked: string } {
  if (!discovery.openai.ok) return { blocked: `openai models/list ${discovery.openai.error}` };
  if (!discovery.anthropic.ok) return { blocked: `anthropic models/list ${discovery.anthropic.error}` };
  const pick = (requested: string, family: string) => {
    if (discovery.openai.gpt6.includes(requested)) return { model: requested, substituted: false };
    const close = discovery.openai.gpt6.find((id) => id.includes(family)) ?? discovery.openai.gpt6[0];
    return close === undefined ? null : { model: close, substituted: true };
  };
  const producer = pick("gpt-6-sol", "sol");
  const judge = pick("gpt-6-luna", "luna");
  const sonnet = discovery.anthropic.sonnet[0];
  if (producer === null || judge === null) return { blocked: "no gpt-6* model listed" };
  if (sonnet === undefined) return { blocked: "no Sonnet model listed" };
  if (producer.model === judge.model) return { blocked: "producer and judge resolve to one identity" };
  return {
    producer: { provider: "openai", requested: "gpt-6-sol", ...producer },
    judge: { provider: "openai", requested: "gpt-6-luna", ...judge },
    secondFamily: { provider: "anthropic", requested: "newest Sonnet", model: sonnet.id, substituted: false },
    auditor: { provider: "anthropic", requested: "newest Sonnet (auditor role)", model: sonnet.id, substituted: false },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Metered JSON calls (direct HTTP; no SDK dependency was added to the repository).
// ---------------------------------------------------------------------------------------------------------------
export interface CallRecord {
  readonly id: string;
  readonly provider: "openai" | "anthropic";
  readonly role: string;
  readonly requestedModel: string;
  readonly responseModel: string | null;
  readonly status: "ok" | "http_error" | "timeout" | "unparseable" | "blocked_budget" | "incomplete";
  readonly httpStatus: number | null;
  readonly latencyMs: number;
  readonly usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningTokens: number };
  readonly costUsd: number;
  readonly costBasis: "usage" | "estimate" | "none";
  readonly plannedMaxUsd: number;
  readonly rawPath: string;
  readonly rawDigest: Digest;
  readonly error: string | null;
}

export interface JsonCallResult {
  readonly json: unknown | null;
  readonly record: CallRecord;
  readonly rawBytes: Buffer;
}

export interface CallContext {
  readonly credentials: Credentials;
  readonly meter: Meter;
  readonly callsDir: string;
  readonly records: CallRecord[];
}

type JsonSchema = Record<string, unknown>;
export const obj = (properties: Record<string, JsonSchema>): JsonSchema => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
export const nullable = (schema: JsonSchema): JsonSchema => ({ anyOf: [schema, { type: "null" }] });
const str: JsonSchema = { type: "string" };
const bool: JsonSchema = { type: "boolean" };
const arr = (items: JsonSchema): JsonSchema => ({ type: "array", items });
const enumOf = (values: readonly string[]): JsonSchema => ({ type: "string", enum: [...values] });

export async function callJson(
  context: CallContext,
  input: {
    id: string;
    provider: "openai" | "anthropic";
    model: string;
    role: string;
    system: string;
    user: string;
    schemaName: string;
    schema: JsonSchema;
    maxOutputTokens: number;
    effort: "low" | "medium" | "high";
  },
): Promise<JsonCallResult> {
  mkdirSync(context.callsDir, { recursive: true });
  const planned = plannedMaxUsd(
    input.model,
    input.system.length + input.user.length + JSON.stringify(input.schema).length,
    input.maxOutputTokens,
  );
  const rawPath = join(context.callsDir, `${input.id}.json`);
  const zero = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  if (planned === null) {
    const record: CallRecord = {
      id: input.id,
      provider: input.provider,
      role: input.role,
      requestedModel: input.model,
      responseModel: null,
      status: "blocked_budget",
      httpStatus: null,
      latencyMs: 0,
      usage: zero,
      costUsd: 0,
      costBasis: "none",
      plannedMaxUsd: 0,
      rawPath,
      rawDigest: digestBytes(""),
      error: `no price for ${input.model}: cannot reserve`,
    };
    context.records.push(record);
    throw new BudgetBlocked(record.error as string);
  }
  const entry = (() => {
    try {
      return context.meter.reserve({
        id: input.id,
        provider: input.provider,
        model: input.model,
        role: input.role,
        plannedMaxUsd: planned,
      });
    } catch (error) {
      context.records.push({
        id: input.id,
        provider: input.provider,
        role: input.role,
        requestedModel: input.model,
        responseModel: null,
        status: "blocked_budget",
        httpStatus: null,
        latencyMs: 0,
        usage: zero,
        costUsd: 0,
        costBasis: "none",
        plannedMaxUsd: planned,
        rawPath,
        rawDigest: digestBytes(""),
        error: (error as Error).message,
      });
      throw error;
    }
  })();
  const request =
    input.provider === "openai"
      ? {
          url: "https://api.openai.com/v1/responses",
          headers: {
            authorization: `Bearer ${context.credentials.get("OPENAI_API_KEY")}`,
            "content-type": "application/json",
          },
          body: {
            model: input.model,
            input: [
              { role: "system", content: input.system },
              { role: "user", content: input.user },
            ],
            reasoning: { effort: input.effort },
            max_output_tokens: input.maxOutputTokens,
            text: { format: { type: "json_schema", name: input.schemaName, schema: input.schema, strict: true } },
            store: false,
          },
        }
      : {
          url: "https://api.anthropic.com/v1/messages",
          headers: {
            "x-api-key": context.credentials.get("ANTHROPIC_API_KEY"),
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body: {
            model: input.model,
            max_tokens: input.maxOutputTokens,
            system: input.system,
            messages: [{ role: "user", content: input.user }],
            output_config: { effort: input.effort, format: { type: "json_schema", schema: input.schema } },
          },
        };
  const started = Date.now();
  let httpStatus: number | null = null;
  let text = "";
  let status: CallRecord["status"] = "ok";
  let error: string | null = null;
  try {
    const response = await fetch(request.url, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(240000),
    });
    httpStatus = response.status;
    text = await response.text();
    if (!response.ok) {
      status = "http_error";
      error = `http ${response.status}: ${context.credentials.redact(text).slice(0, 600)}`;
    }
  } catch (caught) {
    status = "timeout";
    error = (caught as Error).message;
  }
  const latencyMs = Date.now() - started;
  const safe = context.credentials.redact(text);
  const rawBytes = Buffer.from(safe, "utf8");
  writeFileSync(
    rawPath,
    `${JSON.stringify(
      {
        id: input.id,
        provider: input.provider,
        role: input.role,
        request: { url: request.url, body: request.body },
        httpStatus,
        latencyMs,
        response: (() => {
          try {
            return JSON.parse(safe) as unknown;
          } catch {
            return safe;
          }
        })(),
      },
      null,
      2,
    )}\n`,
  );
  let usage = zero;
  let responseModel: string | null = null;
  let json: unknown | null = null;
  if (status === "ok") {
    const body = JSON.parse(safe) as Record<string, unknown>;
    responseModel = typeof body.model === "string" ? body.model : null;
    if (input.provider === "openai") {
      const u = (body.usage ?? {}) as Record<string, unknown>;
      const details = (u.input_tokens_details ?? {}) as Record<string, number>;
      const outDetails = (u.output_tokens_details ?? {}) as Record<string, number>;
      usage = {
        inputTokens: Number(u.input_tokens ?? 0),
        cachedInputTokens: Number(details.cached_tokens ?? 0),
        outputTokens: Number(u.output_tokens ?? 0),
        reasoningTokens: Number(outDetails.reasoning_tokens ?? 0),
      };
      if (body.status !== "completed") {
        status = "incomplete";
        error = `status ${String(body.status)}: ${JSON.stringify(body.incomplete_details ?? null)}`;
      }
      const output = (body.output ?? []) as { type: string; content?: { type: string; text?: string }[] }[];
      const textOut = output
        .filter((item) => item.type === "message")
        .flatMap((item) => item.content ?? [])
        .filter((part) => part.type === "output_text")
        .map((part) => part.text ?? "")
        .join("");
      try {
        json = textOut ? (JSON.parse(textOut) as unknown) : null;
      } catch {
        json = null;
      }
    } else {
      const u = (body.usage ?? {}) as Record<string, number>;
      usage = {
        inputTokens:
          Number(u.input_tokens ?? 0) +
          Number(u.cache_read_input_tokens ?? 0) +
          Number(u.cache_creation_input_tokens ?? 0),
        cachedInputTokens: Number(u.cache_read_input_tokens ?? 0),
        outputTokens: Number(u.output_tokens ?? 0),
        reasoningTokens: 0,
      };
      if (body.stop_reason !== "end_turn") {
        status = body.stop_reason === "refusal" ? "http_error" : "incomplete";
        error = `stop_reason ${String(body.stop_reason)}`;
      }
      const content = (body.content ?? []) as { type: string; text?: string }[];
      const textOut = content
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("");
      try {
        json = textOut ? (JSON.parse(textOut) as unknown) : null;
      } catch {
        json = null;
      }
    }
    if (json === null && status === "ok") {
      status = "unparseable";
      error = "no JSON text in the response";
    }
  }
  let costUsd = 0;
  let costBasis: CallRecord["costBasis"] = "none";
  if (httpStatus === 200) {
    costUsd = usageCostUsd(input.model, usage) ?? planned;
    costBasis = "usage";
  } else if (status === "timeout") {
    // Billing unknown: fail closed at the planned maximum.
    costUsd = planned;
    costBasis = "estimate";
  }
  context.meter.settle(entry, {
    status: httpStatus === 200 ? "settled" : status === "timeout" ? "failed_billed_estimate" : "failed_unbilled",
    actualUsd: costUsd,
    basis: costBasis === "estimate" ? "estimate" : "usage",
    usage: { ...usage },
    latencyMs,
    ...(error ? { note: error.slice(0, 300) } : {}),
  });
  const record: CallRecord = {
    id: input.id,
    provider: input.provider,
    role: input.role,
    requestedModel: input.model,
    responseModel,
    status,
    httpStatus,
    latencyMs,
    usage,
    costUsd,
    costBasis,
    plannedMaxUsd: planned,
    rawPath,
    rawDigest: digestBytes(rawBytes),
    error,
  };
  context.records.push(record);
  return { json: status === "ok" ? json : null, record, rawBytes };
}

// ---------------------------------------------------------------------------------------------------------------
// Producer (paid: gpt-6-sol; T0: the recorded reference draft).
// ---------------------------------------------------------------------------------------------------------------
const valueSchema = obj({
  valueType: enumOf(["none", "quantity", "categorical", "boolean", "text"]),
  amount: nullable(str),
  unit: nullable(str),
  text: nullable(str),
  bool: nullable(bool),
});
const quoteSchema = obj({ source: str, quote: str });
const engineeringQualifiers = obj({
  entity: nullable(str),
  unit: nullable(str),
  negation: bool,
  modality: enumOf(["asserted", "possible", "probable", "hypothetical"]),
  configuration: nullable(str),
  softwareVersion: nullable(str),
  benchmarkEnvironment: nullable(str),
});
const scientificQualifiers = obj({
  entity: nullable(str),
  population: nullable(str),
  negation: bool,
  studyDesign: nullable(enumOf(["randomized_controlled_trial", "cohort", "case_control", "cross_sectional", "other"])),
  species: nullable(str),
  intervention: nullable(str),
  comparator: nullable(str),
  sampleSize: nullable({ type: "integer" }),
  endpoint: nullable(str),
  appraisalDomain: nullable(enumOf(["selection", "performance", "detection", "attrition", "reporting"])),
  appraisalJudgment: nullable(enumOf(["low", "some_concerns", "high", "not_reported"])),
});
const assertionSchema = (scientific: boolean) =>
  obj({
    key: str,
    obligations: arr(str),
    sentence: str,
    kind: enumOf(["source_report", "world_fact"]),
    subject: nullable(str),
    value: valueSchema,
    qualifiers: scientific ? scientificQualifiers : engineeringQualifiers,
    evidence: arr(quoteSchema),
    contrary: arr(quoteSchema),
  });
export const DRAFT_SCHEMAS = {
  evidence_report: obj({
    findingsHeading: str,
    scope: str,
    assertions: arr(assertionSchema(false)),
    evidenceSummary: str,
    limitations: arr(str),
  }),
  study_appraisal: obj({
    studyHeading: str,
    assertions: arr(assertionSchema(true)),
    domains: arr(
      obj({
        domain: enumOf(["selection", "performance", "detection", "attrition", "reporting"]),
        assertionKey: nullable(str),
      }),
    ),
    limitations: arr(str),
  }),
} as const;

export const PRODUCER_SYSTEM = [
  "You are the producer in an AI Engineer research pipeline. Answer the frozen task using ONLY the supplied sources; never use outside knowledge.",
  "Return one assertion per conclusion the task asks for. Each assertion has: a short key; the task obligation ids it covers; one exact declarative sentence (this sentence is printed verbatim in the report); kind source_report; subject; a typed value; qualifiers per the task's qualifier guidance; evidence quotes; contrary quotes.",
  "Every quote is copied character-for-character from exactly one supplied source and must occur exactly once in it; prefer one whole sentence or one whole table row. Name the source by its id (for example S1).",
  "When sources disagree about a conclusion, state what the primary source reports and put the disagreeing quote under contrary; never drop disagreeing evidence.",
  "Headings, scope, evidence summary and limitations are framing text: they must not state facts about the subject.",
  "Do not rate a body of evidence. Quantities are decimal strings without separators (for example 7200000000).",
].join("\n");

export function producerUser(spec: TaskSpec, sources: ReadonlyMap<string, SourceDoc>): string {
  const docs = spec.sources
    .map((id) => `<source id="${id}">\n${(sources.get(id) as SourceDoc).text}</source>`)
    .join("\n\n");
  return [
    `Frozen task ${spec.id} (report kind ${spec.kind}, domain ${spec.domain}).`,
    `Question: ${spec.question}`,
    `Obligations (id: description):\n${spec.obligations.map((o) => `- ${o.id}${o.required ? " (required)" : ""}: ${o.description}`).join("\n")}`,
    `Qualifier guidance:\n${Object.entries(spec.qualifierGuidance)
      .map(([k, v]) => `- ${k}: ${v}`)
      .join("\n")}`,
    spec.kind === "study_appraisal"
      ? "Map each appraisal domain to the key of the assertion that reports it (domains), or null when the study did not report it."
      : "",
    `Sources:\n${docs}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

// ---------------------------------------------------------------------------------------------------------------
// Support judges (paid: gpt-6-luna judge, newest Sonnet second-family judge; T0: label-recorded verdicts).
// ---------------------------------------------------------------------------------------------------------------
const VERDICTS = [
  "full_support",
  "qualified_support",
  "partial_or_context_only",
  "contradiction",
  "conflict",
  "insufficient_evidence",
  "unable_to_assess",
] as const;
const FACETS = [
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
] as const;
export const JUDGE_SCHEMA = obj({
  verdict: enumOf(VERDICTS),
  citedFragmentIds: arr(str),
  contradictingFragmentIds: arr(str),
  unsupportedFacets: arr(enumOf(FACETS)),
  qualification: nullable(str),
  rationale: str,
});
export const JUDGE_SYSTEM = [
  "You are an evidence-only support judge. You receive one proposition with its qualifiers and the exact quoted evidence fragments cited for it, plus any contrary fragments retained with it.",
  "Judge ONLY whether the fragments, read literally, support the proposition including every qualifier shown (entity, quantity, unit, negation, configuration, population, design, appraisal domain and judgment). Never use outside knowledge.",
  "Verdicts: full_support (every facet stated); qualified_support (supported with a qualification you state); partial_or_context_only; contradiction (a fragment states the opposite: name it in contradictingFragmentIds); conflict (fragments disagree with each other); insufficient_evidence; unable_to_assess.",
  "For an appraisal judgment (low, some_concerns, high) the evidence supports it when the reported conduct implies that risk-of-bias level.",
  "citedFragmentIds lists the fragment ids your verdict rests on. Keep the rationale to two sentences.",
].join("\n");

export interface JudgeInput {
  readonly scope: AuthScope;
  readonly assertion: AssertionVersion;
  readonly set: SupportSet;
  readonly fragments: ReadonlyMap<string, EvidenceFragment>;
  readonly quotes: ReadonlyMap<string, { source: string; quote: string; header: string | null }>;
  readonly obligations: readonly string[];
  readonly clock: { now(): string };
}

export function judgeUser(input: JudgeInput): string {
  const q = Object.fromEntries(
    Object.entries(input.assertion.qualifiers).filter(([key, value]) => key !== "profile" && value !== null),
  );
  const show = (ref: Ref<"fragment">) => {
    const quote = input.quotes.get(ref.id);
    return `- ${ref.id} (source ${quote?.source ?? "?"}${quote?.header ? `, section "${quote.header}"` : ""}): "${quote?.quote ?? ""}"`;
  };
  return [
    `Proposition: ${input.assertion.proposition}`,
    `Value: ${JSON.stringify(input.assertion.value)}`,
    `Qualifiers: ${JSON.stringify(q)}`,
    `Cited evidence fragments:\n${input.set.required.flatMap((premise) => premise.evidence.map(show)).join("\n")}`,
    input.set.contrary.length > 0
      ? `Contrary fragments retained:\n${input.set.contrary.map(show).join("\n")}`
      : "Contrary fragments retained: none",
  ].join("\n\n");
}

/** Map a judge's JSON to a valid K02 support outcome; every coercion is recorded, never silent. */
export function supportOutcome(
  input: JudgeInput,
  raw: {
    verdict: string;
    citedFragmentIds: string[];
    contradictingFragmentIds: string[];
    unsupportedFacets: string[];
    qualification: string | null;
  },
): { outcome: Record<string, unknown>; coercions: string[] } {
  const coercions: string[] = [];
  const required = input.set.required.flatMap((premise) => premise.evidence);
  const all = [...required, ...input.set.contrary];
  const byId = (ids: string[]) => all.filter((ref) => ids.includes(ref.id));
  let verdict = (VERDICTS as readonly string[]).includes(raw.verdict) ? raw.verdict : "unable_to_assess";
  if (verdict !== raw.verdict) coercions.push(`verdict ${raw.verdict} -> unable_to_assess`);
  let cited = byId(raw.citedFragmentIds);
  let contradicting = byId(raw.contradictingFragmentIds);
  const facets = raw.unsupportedFacets.filter((facet) => (FACETS as readonly string[]).includes(facet));
  let qualification = raw.qualification?.trim() ? raw.qualification.slice(0, 500) : null;
  if ((verdict === "full_support" || verdict === "qualified_support") && cited.length === 0) {
    cited = required;
    coercions.push("accepting verdict cited no known fragment: cited = the set's required fragments");
  }
  if (verdict === "full_support" && (facets.length > 0 || qualification !== null)) {
    verdict = "qualified_support";
    qualification = qualification ?? `unsupported facets: ${facets.join(", ")}`;
    coercions.push("full_support with facets/qualification -> qualified_support");
  }
  if (verdict === "qualified_support" && qualification === null) {
    qualification = "qualified by the judge without a stated qualification";
    coercions.push("qualified_support without qualification: placeholder qualification");
  }
  if (verdict === "contradiction" && contradicting.length === 0) {
    if (input.set.contrary.length > 0) {
      contradicting = [...input.set.contrary];
      coercions.push("contradiction named no known fragment: contradicting = the set's contrary fragments");
    } else {
      verdict = "conflict";
      coercions.push("contradiction named no known fragment and the set has none: -> conflict");
    }
  }
  return {
    outcome: {
      verdict,
      premise: null,
      citedFragments: verdict === "full_support" || verdict === "qualified_support" ? cited : cited,
      contradictingFragments: contradicting,
      unsupportedFacets: facets,
      qualification:
        verdict === "qualified_support" ? qualification : verdict === "full_support" ? null : qualification,
    },
    coercions,
  };
}

export function evaluatorFor(
  role: EvaluatorIdentity["role"],
  model: { provider: string; model: string } | null,
  methodVersion: string,
  promptDigest: Digest | null,
  config: JsonValue,
): EvaluatorIdentity {
  return {
    role,
    kind: model === null ? "deterministic" : "model",
    provider: model?.provider ?? null,
    family: model === null ? null : model.provider === "openai" ? "gpt-6" : "claude-sonnet",
    model: model?.model ?? null,
    deployment: null,
    reviewerId: null,
    methodVersion,
    promptDigest,
    configDigest: digestCanonical(config),
  };
}

export function supportObservation(input: {
  judge: JudgeInput;
  id: string;
  evaluator: EvaluatorIdentity;
  outcome: Record<string, unknown>;
  rationale: string;
  limitations: string[];
  rawResponse: Ref<"artifact"> | null;
  usage: { providerCalls: number; tokens: number; costUsd: string };
  inputDigest: Digest;
}): VerificationObservation {
  const { judge } = input;
  const outcome = input.outcome as { citedFragments: Ref<"fragment">[]; contradictingFragments: Ref<"fragment">[] };
  return VerificationObservationSchema.parse({
    schemaVersion: OBSERVATION_SCHEMA_VERSION,
    id: input.id,
    tenant: judge.scope.tenant,
    binding: judge.scope.binding,
    target: recordRef("support_set", judge.set),
    inputDigest: input.inputDigest,
    qualifiersDigest: qualifiersDigest(judge.assertion.qualifiers),
    method: {
      kind: "method",
      id: "sv09-support-judge",
      version: input.evaluator.methodVersion,
      digest: input.evaluator.configDigest,
      tenant: judge.scope.tenant,
      binding: judge.scope.binding,
    },
    evaluator: input.evaluator,
    rationale: input.rationale.slice(0, 4000) || "no rationale",
    limitations: input.limitations.map((item) => item.slice(0, 500)),
    evidence: [
      ...new Map([...outcome.citedFragments, ...outcome.contradictingFragments].map((r) => [r.id, r])).values(),
    ],
    rawResponse: input.rawResponse,
    usage: input.usage,
    recordedAt: judge.clock.now(),
    property: "support",
    outcome: input.outcome,
  });
}

/** USD as a K01 decimal string (at most 6 fraction digits, no trailing zeros). */
export function usd(value: number): string {
  const fixed = value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  return fixed === "" || fixed === "-0" ? "0" : fixed;
}

/** T0 label judge: verdicts recorded in the fixture labels, no model call. */
export function labelVerdict(labels: Labels, obligations: readonly string[], set: SupportSet) {
  const mustHold = obligations.some((id) => labels.obligations[id]?.expected === "must_hold");
  if (mustHold) {
    return set.contrary.length > 0
      ? {
          verdict: "contradiction",
          citedFragmentIds: [],
          contradictingFragmentIds: set.contrary.map((r) => r.id),
          unsupportedFacets: [],
          qualification: null,
        }
      : {
          verdict: "conflict",
          citedFragmentIds: [],
          contradictingFragmentIds: [],
          unsupportedFacets: [],
          qualification: null,
        };
  }
  return {
    verdict: "full_support",
    citedFragmentIds: set.required.flatMap((p) => p.evidence.map((r) => r.id)),
    contradictingFragmentIds: [],
    unsupportedFacets: [],
    qualification: null,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Auditor census discovery (paid: newest Sonnet in the auditor role; T0: the scripted auditor from the labels).
// ---------------------------------------------------------------------------------------------------------------
export const AUDITOR_SCHEMA = obj({
  occurrences: arr(obj({ unitPath: str, quote: str, assertionId: nullable(str), negated: bool, interrogative: bool })),
  unitExplanations: arr(obj({ path: str, reason: str })),
});
export const AUDITOR_SYSTEM = [
  "You are the independent final-census auditor. You receive the exact frozen text of a report, its structural units (path, kind, whether the author marked the unit factual, and its exact text) and comparison assertions (id and proposition). You never see the author's own occurrence ledger.",
  "Find every statement of fact anywhere in the report, including headings, table cells, captions and units the author marked nonfactual. Return each as an exact quote copied character-for-character from one unit's text, with that unit's path.",
  "Map each quote to the comparison assertion it states (by id) or null when none states it. Set negated when the statement is negative and interrogative when it is a question.",
  "For a unit marked factual that states no fact (for example a bare label), return a unit explanation with a short reason. Never explain away a factual statement that no assertion covers. Citation markers are not facts.",
].join("\n");

export interface AuditRecord {
  discovery: DiscoveryResult;
  dropped: { unitPath: string; quote: string; reason: string }[];
  call: CallRecord | null;
}

export class ModelAuditorDiscovery implements AuditorDiscovery {
  readonly audits: AuditRecord[] = [];
  constructor(
    private readonly context: CallContext,
    private readonly pinned: { provider: "anthropic" | "openai"; model: string },
    private readonly custody: CustodyStore,
    private readonly callId: string,
  ) {}

  async discover(scope: AuthScope, input: DiscoveryInput): Promise<DiscoveryResult> {
    const units = input.units
      .filter((unit) => unit.span !== null)
      .map((unit) => ({
        path: unit.path,
        kind: unit.kind,
        factual: unit.factual,
        text: input.body.text.slice((unit.span as { start: number }).start, (unit.span as { end: number }).end),
      }));
    const user = [
      `Report body (exact frozen text):\n<body>\n${input.body.text}</body>`,
      `Structural units:\n${JSON.stringify(units, null, 1)}`,
      `Comparison assertions:\n${input.assertions.map((a) => `- ${a.logicalId}: ${a.proposition}`).join("\n")}`,
    ].join("\n\n");
    const config = { model: this.pinned.model, schema: AUDITOR_SCHEMA, effort: "low", maxOutputTokens: 6000 };
    const result = await callJson(this.context, {
      id: this.callId,
      provider: this.pinned.provider,
      model: this.pinned.model,
      role: "auditor",
      system: AUDITOR_SYSTEM,
      user,
      schemaName: "census_discovery",
      schema: AUDITOR_SCHEMA,
      maxOutputTokens: 6000,
      effort: "low",
    });
    if (result.json === null)
      throw new Error(`AUDITOR_CALL_FAILED: ${result.record.status} ${result.record.error ?? ""}`);
    const parsed = result.json as {
      occurrences: {
        unitPath: string;
        quote: string;
        assertionId: string | null;
        negated: boolean;
        interrogative: boolean;
      }[];
      unitExplanations: { path: string; reason: string }[];
    };
    const rawRef = await this.custody.put(scope, result.rawBytes, "application/json");
    const occurrences: DiscoveredOccurrence[] = [];
    const dropped: AuditRecord["dropped"] = [];
    const used = new Set<string>();
    parsed.occurrences.forEach((entry, index) => {
      const unit = input.units.find((candidate) => candidate.path === entry.unitPath && candidate.span !== null);
      if (unit === undefined || unit.span === null) {
        dropped.push({ ...entry, reason: "unknown_unit" });
        return;
      }
      const unitText = input.body.text.slice(unit.span.start, unit.span.end);
      let at = unitText.indexOf(entry.quote);
      while (at >= 0 && used.has(`${unit.path}:${at}`)) at = unitText.indexOf(entry.quote, at + 1);
      if (entry.quote.length === 0 || at < 0) {
        dropped.push({ ...entry, reason: "quote_not_in_unit" });
        return;
      }
      used.add(`${unit.path}:${at}`);
      const start = unit.span.start + at;
      const located = span(start, start + entry.quote.length);
      const mapped =
        entry.assertionId === null ? null : (input.assertions.find((a) => a.logicalId === entry.assertionId) ?? null);
      occurrences.push(
        DiscoveredOccurrenceSchema.parse({
          schemaVersion: DISCOVERED_OCCURRENCE_SCHEMA_VERSION,
          id: `aud-${index}-${start}`,
          body: input.body.ref,
          span: located,
          blockPath: unit.path,
          quoteDigest: quoteDigest(input.body.text, located),
          candidateAssertion: entry.quote.slice(0, 4000),
          assertion: mapped === null ? null : recordRef("assertion", mapped),
          negated: entry.negated,
          interrogative: entry.interrogative,
        } satisfies DiscoveredOccurrence),
      );
    });
    const knownPaths = new Set(input.units.map((unit) => unit.path));
    const discovery: DiscoveryResult = {
      evaluator: evaluatorFor(
        "auditor",
        this.pinned,
        "sv09-census-discovery.v1",
        digestBytes(AUDITOR_SYSTEM),
        config as unknown as JsonValue,
      ),
      method: {
        kind: "method",
        id: "sv09-census-discovery",
        version: "sv09-census-discovery.v1",
        digest: digestCanonical(config as unknown as JsonValue),
        tenant: scope.tenant,
        binding: scope.binding,
      },
      occurrences,
      explanations: [],
      unitExplanations: parsed.unitExplanations
        .filter((explanation) => knownPaths.has(explanation.path) && explanation.reason.trim().length > 0)
        .map((explanation) => ({ path: explanation.path, reason: explanation.reason.slice(0, 500) })),
      recall: {
        label: "unmeasured",
        reason: "control slice: recall is measured offline against synthetic fixture labels, not calibrated",
      },
      rationale: `model discovery of ${occurrences.length} occurrence(s); ${dropped.length} quote(s) dropped (not found verbatim in the named unit)`,
      limitations: [
        "single model pass; synthetic fixture labels only",
        ...(dropped.length > 0
          ? [`${dropped.length} discovered quote(s) were not verbatim in their unit and were dropped`]
          : []),
      ],
      usage: {
        providerCalls: 1,
        tokens: result.record.usage.inputTokens + result.record.usage.outputTokens,
        costUsd: usd(result.record.costUsd),
      },
      rawResponse: rawRef,
    };
    this.audits.push({ discovery, dropped, call: result.record });
    return discovery;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Authority and challenge: recorded fakes only (no paid frontier calls, no network).
// ---------------------------------------------------------------------------------------------------------------
export function recordedResolver(scope: AuthScope, sources: ReadonlyMap<string, SourceDoc>): SourceAuthorityResolver {
  const config = [...sources.values()].map((source) => ({ id: source.id, authority: source.provenance.authorityFake }));
  const configDigest = digestCanonical(config as unknown as JsonValue);
  return {
    evaluator: evaluatorFor("auditor", null, "sv09-recorded-source-registry.v1", null, config as unknown as JsonValue),
    method: {
      kind: "method",
      id: "sv09-recorded-source-registry",
      version: "source-authority.v1",
      digest: configDigest,
      tenant: scope.tenant,
      binding: scope.binding,
    },
    describe: async (_scope, fragment) => {
      const id = fragment.sourceVersion.split("-")[0] as string;
      const fake = sources.get(id)?.provenance.authorityFake;
      if (fake === undefined) {
        return {
          verifiedOriginFamily: null,
          doi: null,
          sourceKind: null,
          studyDesign: null,
          directness: "unknown",
          freshness: "unknown",
          qualifiers: {},
        };
      }
      return { ...fake, studyDesign: fake.studyDesign as never };
    },
  };
}

export function recordedCrossrefFetch(sources: ReadonlyMap<string, SourceDoc>): FetchLike & { calls: string[] } {
  const calls: string[] = [];
  const fetchLike = (async (url: string) => {
    calls.push(url);
    const doi = decodeURIComponent(url.split("/works/")[1] ?? "").toLowerCase();
    const source = [...sources.values()].find(
      (candidate) => candidate.provenance.authorityFake.doi?.toLowerCase() === doi,
    );
    const fake = source?.provenance.revisionFrontierFake;
    return { status: fake?.status ?? 404, json: async () => fake?.body ?? {} };
  }) as unknown as FetchLike & { calls: string[] };
  fetchLike.calls = calls;
  return fetchLike;
}

export function recordedChallenge(
  scope: AuthScope,
  labels: Labels,
  obligationsFor: (assertion: AssertionVersion) => readonly string[],
  contraryFor: (assertion: AssertionVersion) => readonly EvidenceFragment[],
): CounterevidenceSearch {
  const config = {
    labels: labels.task,
    rule: "must_hold obligations report a material conflict with the retained contrary fragments",
  };
  return {
    evaluator: evaluatorFor("auditor", null, "sv09-recorded-challenge.v1", null, config as unknown as JsonValue),
    method: {
      kind: "method",
      id: "sv09-recorded-challenge",
      version: "challenge.v1",
      digest: digestCanonical(config as unknown as JsonValue),
      tenant: scope.tenant,
      binding: scope.binding,
    },
    search: async (_scope, { assertion }) => {
      const mustHold = obligationsFor(assertion).some((id) => labels.obligations[id]?.expected === "must_hold");
      // The search re-finds the contrary source as its own fragment record (a new id): the binding's putFragment
      // refuses a second put of an already-registered fragment id (duplicate key), so the fake never re-puts one.
      const contrary = mustHold
        ? contraryFor(assertion).map((fragment) => ({ ...fragment, id: `${fragment.id}-chal`.slice(0, 200) }))
        : [];
      return {
        status: "searched",
        queries: [`recorded fixture search: "${assertion.subject ?? assertion.logicalId}" contrary evidence`],
        counterevidence: contrary,
        materialConflict: mustHold,
        frontier: {
          exhausted: true,
          searchedScopes: ["sv09 locked fixture corpus"],
          limits: ["recorded fake; no live index"],
          unsearchedScopes: ["everything outside the locked fixture corpus"],
        },
        rationale: mustHold
          ? "the locked corpus holds a contrary source for this conclusion"
          : "no contrary source in the locked corpus",
        usage: { providerCalls: 0, tokens: 0, costUsd: "0" },
      };
    },
  };
}

/** Scripted (T0) census discovery script from the fixture labels. */
export function labelScript(labels: Labels, logicalIdFor: (key: string) => string) {
  return {
    entries: labels.census.occurrences.map((occurrence) => ({
      quote: occurrence.quote,
      assertionLogicalId: occurrence.assertionKey === null ? null : logicalIdFor(occurrence.assertionKey),
      negated: isNegatedText(occurrence.quote),
      interrogative: isInterrogativeText(occurrence.quote),
    })),
    unitExplanations: labels.census.expectedUnitExplanations.map((path) => ({
      path,
      reason: "appraisal domain label",
    })),
  };
}

export type { ProducerDraft };
