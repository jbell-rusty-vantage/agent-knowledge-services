import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ReportAssessmentService,
  ReportKindCatalog,
  ResearchCoordinator,
  ScriptedAuditorDiscovery,
  SourceAuthorityCatalog,
  systemClock,
  testSealKeys,
} from "../../../packages/application/dist/index.js";
import {
  ComponentDatabase,
  PostgresResearchBinding,
  pinSealSigningKey,
} from "../../../packages/bindings/aiengineer-postgres/dist/index.js";
import {
  AdmissionInstallationError,
  ExactUseAdmissionError,
  admitExactUseWithin,
  aidbGuardStatus,
  recordExactUseReceipt,
} from "../../../packages/knowledge-db/dist/index.js";
import {
  type Digest,
  type JsonValue,
  type Origin,
  type Ref,
  bindEffect,
  canonicalJson,
  digestBytes,
  digestCanonical,
  originDigest,
} from "../../../packages/knowledge-operation-protocol/dist/index.js";
import {
  ASSERTION_SCHEMA_VERSION,
  type AssertionVersion,
  AssertionVersionSchema,
  type AuthScope,
  DomainMappingSchema,
  ENGINEERING_RUBRIC_VERSION,
  type EvidenceFragment,
  EvidenceFragmentSchema,
  FRAGMENT_SCHEMA_VERSION,
  MAPPING_SCHEMA_VERSION,
  type NormalizedValues,
  OBSERVATION_SCHEMA_VERSION,
  SUPPORT_SET_SCHEMA_VERSION,
  type StructuredBody,
  type SupportSet,
  SupportSetSchema,
  TASK_SCHEMA_VERSION,
  type UseDecision,
  type VerificationObservation,
  VerificationObservationSchema,
  type VerificationTaskContract,
  VerificationTaskContractSchema,
  authoritativeObservations,
  censusHoldReasons,
  escapeMarkdown,
  evaluateSupport,
  normalizedValuesDigest,
  qualifiersDigest,
  recordRef,
  reportDerive,
} from "../../../packages/research-core/dist/index.js";

/**
 * Build 08 loop 6 (Knowledge Services side): the first legitimate `verified` claims of the AI Engineer knowledge base.
 * Drives the KS application directly (ResearchCoordinator + PostgresResearchBinding) on the DISPOSABLE lab database
 * (AIDB schema + knowledge_verification component in one Postgres): captured probe outputs -> custody -> fragments /
 * assertions / support sets -> report -> L0 integrity (deterministic) + support (deterministic probe verdict + recorded
 * human confirmation) -> scripted census -> seal (lab test key) -> derive -> per-assertion use decisions -> native
 * write in ONE transaction per admitted decision (bind effect, component rule + AIDB guard, AIDB
 * verification.record_admitted_claim_verification, component effect receipt). Negative controls: tampered bytes and a
 * cross-claim decision. No model calls; every evaluator is deterministic or a recorded human confirmation.
 *
 *   corepack pnpm exec tsx scripts/experiments/build08-probe-admission/run.ts --pack <admission-pack.json> --out <dir>
 */
const here = dirname(fileURLToPath(import.meta.url));
const KS_ROOT = resolve(here, "../../..");
const LAB = resolve(KS_ROOT, "../ai-engineer-research-2026-11-02/11-build04-lab/knowledge-loop-6");
const TENANT = "00000000-0000-7000-8000-000000000001";
const INSTALLATION = "0195f0a0-5b08-7000-8000-0000000c1a1d";
const BINDING = "aiengineer-postgres";
const APPLICATION = "ai-engineer";
const SEAL_KEY_ID = "build08-loop6-lab-seal-1";
const USE = "knowledge_ingestion.claim_verification";
const AUDIENCE = "internal";
const RISK = "medium" as const;
const TARGET_SCHEMA = "aieng.claim-verification.v1";
const NATIVE_ROLE = "executor_service" as const;
// Dates are the run's own (loop 6 hard-coded 2026-11-13, which made the task deadline expire on later runs).
const RUN_STARTED = new Date();
const NOW_ISO = RUN_STARTED.toISOString().replace(/\.\d{3}Z$/, "Z");
const DEADLINE_ISO = new Date(RUN_STARTED.getTime() + 24 * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * Polarity, read by the harness author from each statement (not inferred from the census cue list): `negative` claims
 * assert a negative fact (negation qualifier true); `subclause` claims are affirmative propositions whose wording
 * carries a negative cue in a subordinate clause (the scripted census reads them affirmative and says why).
 */
const POLARITY: Readonly<Record<string, { negative: boolean; note?: string }>> = {
  "9d09bf5f-b014-4b74-b057-70599525f47e": { negative: true },
  "c45fb074-ab67-4dcc-8d61-c13c2168e8ce": { negative: true },
  "cea13074-01e0-4366-98fe-8b4af240d9b6": { negative: true },
  "a3f65124-1c84-49f9-bab4-f0e57ae8400c": {
    negative: false,
    note: "affirmative resolution fact; 'Without a version pin' states the condition",
  },
  "c38d2c6d-9992-4e5a-9d57-28672963936b": {
    negative: false,
    note: "affirmative naming fact (the node is named model); 'not agent' contrasts the old name",
  },
  "7c931eed-ae43-41e9-abda-43e004f5bdbc": {
    negative: false,
    note: "affirmative link-target fact; 'not the deprecated LangGraph prebuilt' contrasts the documented function",
  },
};
const KINDS = ReportKindCatalog.fromDirectory(join(KS_ROOT, "catalog/research/report-kinds"));
const AUTHORITY = SourceAuthorityCatalog.fromDirectory(join(KS_ROOT, "catalog/research/source-authority"));
const SEAL = testSealKeys(SEAL_KEY_ID);

const requireFromBinding = createRequire(join(KS_ROOT, "packages/bindings/aiengineer-postgres/package.json"));
// biome-ignore lint/suspicious/noExplicitAny: pg is resolved from the binding package at runtime (no root dependency).
const pg = requireFromBinding("pg") as { Client: new (config: { connectionString: string }) => any };

// ---------------------------------------------------------------------------------------------------------------------
// Input pack
// ---------------------------------------------------------------------------------------------------------------------
interface PackRun {
  run_id: string;
  cell_label: string;
  capture_id: string;
  content_sha256: string;
  media_type: string;
  request_url: string;
  file: string;
  quotes: string[];
  outcome?: string;
  lock_sha256?: string;
}
interface PackClaim {
  claim_id: string;
  statement: string;
  statement_sha256: string;
  claim_type: string;
  probe: string;
  probe_id: string;
  probe_kind: string;
  verdict: string;
  verdict_id: string;
  review_state: string;
  rationale: string;
  stated_by: string;
  channel: string | null;
  script_path: string | null;
  script_sha256: string | null;
  runs: PackRun[];
  /** Loop 7 (D-80): the polarity reading and the owner confirmation travel with the claim in the pack. */
  polarity?: { negative: boolean; note?: string };
  confirmation?: { instrument: string; rationale: string; decided_by?: string };
}
const polarityOf = (claim: { claim_id: string; polarity?: { negative: boolean; note?: string } }) =>
  POLARITY[claim.claim_id] ?? claim.polarity;
interface Pack {
  schema: string;
  tenant: string;
  made_at: string;
  use: string;
  policy: string;
  offered: PackClaim[];
  not_offered: unknown[];
}

function parseArgs() {
  const argv = process.argv.slice(2);
  const value = (name: string) => {
    const index = argv.indexOf(name);
    return index >= 0 ? (argv[index + 1] ?? null) : null;
  };
  return {
    pack: value("--pack") ?? join(LAB, "admission-pack.json"),
    out: value("--out") ?? join(LAB, "ks-run"),
    dsn: value("--dsn") ?? "postgresql://postgres:postgres@127.0.0.1:55622/postgres",
  };
}

const hex = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const short = (text: string) => hex(text).slice(0, 10);
const writeJson = (path: string, value: unknown) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const errorText = (error: unknown) => {
  const e = error as { code?: string; message?: string; detail?: string };
  return { sqlstate: e?.code ?? null, message: e?.message ?? String(error), detail: e?.detail ?? null };
};
const harnessDigest = () => `sha256:${hex(readFileSync(join(here, "run.ts")))}`;

function harnessOrigin(): Origin {
  return {
    kind: "standalone",
    installationId: INSTALLATION,
    applicationId: APPLICATION,
    tenantId: TENANT,
    issuer: "ks-build08-loop6-harness",
    subject: "build08-probe-admission",
    mission: null,
    recoveryAuthorityRef: null,
    invocationId: "inv-build08-loop6",
    authenticatedAt: NOW_ISO,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// AIDB reads (raw SQL reads are fine; writes only through admission + the AIDB function)
// ---------------------------------------------------------------------------------------------------------------------
// biome-ignore lint/suspicious/noExplicitAny: pg client
async function withAdmin<T>(dsn: string, work: (c: any) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: dsn });
  await client.connect();
  try {
    await client.query("select set_config('app.tenant_id', $1, false)", [TENANT]);
    return await work(client);
  } finally {
    await client.end();
  }
}

interface ClaimState {
  id: string;
  status: string;
  statementSha256: string;
}

async function claimStates(dsn: string, ids: readonly string[]): Promise<Map<string, ClaimState>> {
  return withAdmin(dsn, async (c) => {
    const rows = await c.query(
      `select id::text, status::text, encode(extensions.digest(convert_to(statement, 'utf8'), 'sha256'), 'hex') as sha
         from evidence.claim where tenant_id = $1 and id = any($2::uuid[])`,
      [TENANT, ids],
    );
    return new Map(
      rows.rows.map((r: { id: string; status: string; sha: string }) => [
        r.id,
        { id: r.id, status: r.status, statementSha256: r.sha },
      ]),
    );
  });
}

async function captureDigests(dsn: string, ids: readonly string[]): Promise<Map<string, string>> {
  return withAdmin(dsn, async (c) => {
    const rows = await c.query(
      "select id::text, content_sha256 from evidence.source_capture where tenant_id = $1 and id = any($2::uuid[])",
      [TENANT, ids],
    );
    return new Map(rows.rows.map((r: { id: string; content_sha256: string }) => [r.id, r.content_sha256]));
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Deterministic compilation of the pack into K02 records
// ---------------------------------------------------------------------------------------------------------------------
interface Capture {
  readonly captureId: string;
  readonly bytes: Buffer;
  /** The AIDB evidence.source_capture.content_sha256 (the authority for these bytes). */
  readonly expectedSha256: string;
  readonly ref: Ref<"artifact">;
  readonly tampered: boolean;
}

interface Located {
  readonly fragment: EvidenceFragment;
  readonly start: number;
  readonly end: number;
  readonly quote: string;
  readonly captureId: string;
}

interface CompiledClaim {
  readonly claim: PackClaim;
  readonly key: string;
  readonly obligation: string;
  readonly assertion: AssertionVersion;
  readonly set: SupportSet;
  readonly located: Located[];
}

/** The byte span of one run cell inside a probe report capture (`{"cell": "<label>", ...}` up to the next cell). */
function cellSpan(bytes: Buffer, label: string): { start: number; end: number } {
  const marker = Buffer.from(`{"cell": ${JSON.stringify(label)}`, "utf8");
  const start = bytes.indexOf(marker);
  if (start < 0) throw new Error(`CELL_NOT_FOUND: ${label}`);
  if (bytes.indexOf(marker, start + 1) >= 0) throw new Error(`CELL_NOT_UNIQUE: ${label}`);
  const next = bytes.indexOf(Buffer.from('{"cell": ', "utf8"), start + marker.length);
  return { start, end: next < 0 ? bytes.length : next };
}

function locate(bytes: Buffer, label: string, quote: string): { start: number; end: number } {
  const cell = cellSpan(bytes, label);
  const needle = Buffer.from(quote, "utf8");
  const region = bytes.subarray(cell.start, cell.end);
  const first = region.indexOf(needle);
  if (first < 0) throw new Error(`QUOTE_NOT_IN_CELL: ${label}: ${quote}`);
  if (region.indexOf(needle, first + 1) >= 0) throw new Error(`QUOTE_NOT_UNIQUE_IN_CELL: ${label}: ${quote}`);
  return { start: cell.start + first, end: cell.start + first + needle.length };
}

function buildTask(
  scope: AuthScope,
  id: string,
  originalTask: Ref<"artifact">,
  obligations: { id: string; description: string; weight: number; required: boolean }[],
): VerificationTaskContract {
  const ref = <K extends Ref["kind"]>(kind: K, refId: string, version: string): Ref<K> =>
    ({
      kind,
      id: refId,
      version,
      digest: digestBytes(`${kind}:${refId}:${version}`),
      tenant: scope.tenant,
      binding: scope.binding,
    }) as Ref<K>;
  return VerificationTaskContractSchema.parse({
    schemaVersion: TASK_SCHEMA_VERSION,
    id,
    tenant: scope.tenant,
    binding: scope.binding,
    domain: "engineering",
    originalTask,
    use: USE,
    audience: AUDIENCE,
    obligations,
    asOf: NOW_ISO,
    permittedMedia: ["application_json"],
    rubric: ref("rubric", "rubric-engineering", ENGINEERING_RUBRIC_VERSION),
    policy: ref("policy", "policy-ai-engineer", "research-policy.ai-engineer.v2"),
    minimumRisk: RISK,
    limits: { calls: 0, tokens: 0, costUsd: "0", deadline: DEADLINE_ISO },
  });
}

function compileClaims(input: {
  scope: AuthScope;
  prefix: string;
  claims: readonly PackClaim[];
  captures: ReadonlyMap<string, Capture>;
  origin: Origin;
}): CompiledClaim[] {
  const { scope } = input;
  return input.claims.map((claim, index) => {
    const key = `c${String(index + 1).padStart(2, "0")}`;
    const obligation = `finding.${key}`;
    const assertion = AssertionVersionSchema.parse({
      schemaVersion: ASSERTION_SCHEMA_VERSION,
      id: `${input.prefix}-${key}`,
      tenant: scope.tenant,
      binding: scope.binding,
      logicalId: `aieng.claim.${claim.claim_id}`,
      proposition: claim.statement,
      kind: "world_fact",
      value: { type: "none" },
      subject: null,
      object: null,
      qualifiers: {
        profile: "engineering.v2",
        entity: null,
        population: null,
        time: null,
        unit: null,
        jurisdiction: null,
        baseline: null,
        negation: polarityOf(claim)?.negative ?? false,
        modality: "asserted",
        comparison: null,
        runtime: null,
        softwareVersion: null,
        configuration: null,
        benchmarkEnvironment: null,
        denominator: null,
        repositoryCommit: null,
      },
      riskReasons: [],
      producer: input.origin,
      premises: [],
    } satisfies AssertionVersion);
    const located: Located[] = [];
    const premises = claim.runs.map((run, runIndex) => {
      const capture = input.captures.get(run.capture_id);
      if (!capture) throw new Error(`CAPTURE_MISSING: ${run.capture_id}`);
      const fragments = [...new Set(run.quotes)].map((quote) => {
        const at = locate(capture.bytes, run.cell_label, quote);
        const cell = cellSpan(capture.bytes, run.cell_label);
        const fragment = EvidenceFragmentSchema.parse({
          schemaVersion: FRAGMENT_SCHEMA_VERSION,
          id: `${input.prefix}-${key}-r${runIndex + 1}-q${short(quote)}`,
          tenant: scope.tenant,
          binding: scope.binding,
          sourceVersion: `capture-${run.capture_id}`,
          capture: capture.ref,
          representation: capture.ref,
          selector: {
            kind: "text_position",
            value: JSON.stringify({ cell: run.cell_label, byteStart: at.start, byteEnd: at.end }),
            resolverVersion: "probe-cell-byte-range.v1",
            normalizationVersion: "bytes-identity.v1",
          },
          selectedDigest: digestBytes(quote),
          selectedSize: Buffer.byteLength(quote, "utf8"),
          context: {
            header: `probe ${claim.probe} cell ${run.cell_label} run ${run.run_id}`.slice(0, 200),
            footnotes: [],
            surroundingDigest: digestBytes(capture.bytes.subarray(cell.start, cell.end)),
          },
          parserLineage: ["probe-report-json.v1"],
          captureCompleteness: "complete",
          access: { rights: "private", limits: ["lab probe capture (disposable lab)"] },
          originFamily: `probe:${claim.probe}`,
        } satisfies EvidenceFragment);
        located.push({ fragment, start: at.start, end: at.end, quote, captureId: run.capture_id });
        return fragment;
      });
      return {
        premise: `r${runIndex + 1}`,
        evidence: fragments.map((f) => recordRef("fragment", f)),
        derivedFrom: [],
      };
    });
    const set = SupportSetSchema.parse({
      schemaVersion: SUPPORT_SET_SCHEMA_VERSION,
      id: `ss-${assertion.id}`,
      tenant: scope.tenant,
      binding: scope.binding,
      assertion: recordRef("assertion", assertion),
      qualifiersDigest: qualifiersDigest(assertion.qualifiers),
      provenance: "declared_citation",
      required: premises,
      contrary: [],
    } satisfies SupportSet);
    return { claim, key, obligation, assertion, set, located };
  });
}

function structuredBody(compiled: readonly CompiledClaim[], scopeText: string, limitations: string[]): StructuredBody {
  const text = (value: string) => ({ type: "text" as const, text: value });
  let citeIndex = 0;
  const cite = (fragment: EvidenceFragment) => {
    citeIndex += 1;
    return { type: "citation" as const, label: `c${citeIndex}`, fragment: recordRef("fragment", fragment) };
  };
  return {
    schemaVersion: "research-core.structured_body.v2",
    sections: [
      {
        id: "scope",
        heading: [text("Scope")],
        headingExcludedReason: "section title",
        blocks: [{ type: "paragraph", id: "p1", inlines: [text(scopeText)], excludedReason: "scope statement" }],
      },
      {
        id: "findings",
        heading: [text("Findings")],
        headingExcludedReason: "section title",
        blocks: compiled.map((item, index) => ({
          type: "paragraph" as const,
          id: `p${index + 1}`,
          inlines: [
            {
              type: "claim" as const,
              occurrenceId: `occ-${item.key}`,
              assertion: recordRef("assertion", item.assertion),
              text: item.assertion.proposition,
              obligations: [item.obligation],
              attribution: null,
            },
            ...item.located.flatMap((l) => [text(" "), cite(l.fragment)]),
          ],
          excludedReason: null,
        })),
      },
      {
        id: "evidence",
        heading: [text("Evidence")],
        headingExcludedReason: "section title",
        blocks: [
          {
            type: "paragraph",
            id: "p1",
            inlines: [
              text("Each finding cites byte ranges of the captured probe output it rests on."),
              ...compiled.flatMap((item) => item.located.slice(0, 1).flatMap((l) => [text(" "), cite(l.fragment)])),
            ],
            excludedReason: "citation summary",
          },
        ],
      },
      {
        id: "limitations",
        heading: [text("Limitations")],
        headingExcludedReason: "section title",
        blocks: [
          {
            type: "list",
            id: "l1",
            ordered: false,
            items: limitations.map((item) => [text(item)]),
            excludedReason: "limitation statement",
          },
        ],
      },
    ],
  } as StructuredBody;
}

// ---------------------------------------------------------------------------------------------------------------------
// Observations (all deterministic or recorded human; no model calls)
// ---------------------------------------------------------------------------------------------------------------------
function method(scope: AuthScope, id: string, version: string, config: JsonValue): Ref<"method"> {
  return {
    kind: "method",
    id,
    version,
    digest: digestCanonical(config),
    tenant: scope.tenant,
    binding: scope.binding,
  } as Ref<"method">;
}

function observation(input: {
  scope: AuthScope;
  id: string;
  target: Ref;
  qualifiers: string | null;
  method: Ref<"method">;
  evaluator: VerificationObservation["evaluator"];
  rationale: string;
  limitations: string[];
  evidence: Ref<"fragment">[];
  rawResponse: Ref<"artifact"> | null;
  property: VerificationObservation["property"];
  outcome: unknown;
}): VerificationObservation {
  return VerificationObservationSchema.parse({
    schemaVersion: OBSERVATION_SCHEMA_VERSION,
    id: input.id.slice(0, 200),
    tenant: input.scope.tenant,
    binding: input.scope.binding,
    target: input.target,
    inputDigest: digestCanonical({ target: input.target.digest, method: input.method.digest } as unknown as JsonValue),
    qualifiersDigest: input.qualifiers,
    method: input.method,
    evaluator: input.evaluator,
    rationale: input.rationale.slice(0, 4000),
    limitations: input.limitations.map((l) => l.slice(0, 500)),
    evidence: input.evidence,
    rawResponse: input.rawResponse,
    usage: { providerCalls: 0, tokens: 0, costUsd: "0" },
    recordedAt: systemClock.now(),
    property: input.property,
    outcome: input.outcome,
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// One verification run (main or tamper control) up to the decisions
// ---------------------------------------------------------------------------------------------------------------------
interface ClaimDecision {
  claimId: string;
  key: string;
  assertionId: string;
  decision: UseDecision;
  effectKey: string;
  payload: Record<string, JsonValue>;
  payloadJson: string;
  binding: ReturnType<typeof bindEffect>;
  normalized: NormalizedValues;
  integrity: { result: string; failureCodes: string[] };
}

interface RunOutcome {
  runId: string;
  taskId: string;
  reportDecision: { id: string; disposition: string; conditions: readonly string[] };
  census: { holds: string[]; occurrences: number; auditor: string };
  manifests: { kind: string; keyId: string | null }[];
  derive: { proposals: number; held: { assertion: string; reason: string }[] };
  useClass: unknown;
  decisions: ClaimDecision[];
  timings: Record<string, number>;
}

async function verificationRun(input: {
  label: string;
  tag: string;
  scope: AuthScope;
  binding: PostgresResearchBinding;
  claims: readonly PackClaim[];
  captures: ReadonlyMap<string, Capture>;
  log: (line: string) => void;
}): Promise<RunOutcome> {
  const { scope, binding } = input;
  const origin = harnessOrigin();
  const timings: Record<string, number> = {};
  const mark = (name: string, started: number) => {
    timings[name] = Date.now() - started;
  };
  let t = Date.now();
  const prefix = `l6-${input.tag}-${input.label}`;
  const compiled = compileClaims({ scope, prefix, claims: input.claims, captures: input.captures, origin });
  // Obligation weights: one required finding per claim, the remainder to an optional limitation (sum 10000 bp).
  const each = Math.floor(9000 / compiled.length);
  const obligations = [
    ...compiled.map((item) => ({
      id: item.obligation,
      description: `State, with the captured probe evidence, that: ${item.claim.statement}`.slice(0, 4000),
      weight: each,
      required: true,
    })),
    {
      id: "limitation.lab",
      description: "State the limits of the probe evidence (disposable lab, pinned environments).",
      weight: 10000 - each * compiled.length,
      required: false,
    },
  ];
  const taskSpec = {
    schema: "build08-loop6-task.v1",
    label: input.label,
    question:
      "Build 08 loop 6: admit probe-verified claims about the create_react_agent -> create_agent migration (and the LangChain v1 / Deep Agents environment facts the probes measured).",
    use: USE,
    audience: AUDIENCE,
    risk: RISK,
    claims: input.claims.map((c) => ({ claim_id: c.claim_id, statement_sha256: c.statement_sha256, probe: c.probe })),
  };
  const taskArtifact = await binding.custody.put(
    scope,
    Buffer.from(canonicalJson(taskSpec as unknown as JsonValue), "utf8"),
    "application/json",
  );
  const task = buildTask(scope, `build08-loop6.${input.tag}.${input.label}`, taskArtifact, obligations);
  const coordinator = new ResearchCoordinator(binding, systemClock, KINDS, {
    signer: SEAL.signer,
    authority: AUTHORITY,
  });
  const useClass = coordinator.useClassFor(task, USE, AUDIENCE);
  const { runId } = await coordinator.openRun(scope, { task, originatingOrigin: origin });
  mark("open", t);
  input.log(`[${input.label}] run ${runId} opened; use class ${JSON.stringify(useClass)}`);

  t = Date.now();
  await coordinator.registerEvidence(scope, {
    fragments: compiled.flatMap((item) => item.located.map((l) => l.fragment)),
    assertions: compiled.map((item) => item.assertion),
    supportSets: compiled.map((item) => item.set),
  });
  const registered = await coordinator.registerReport(scope, {
    runId,
    reportId: `${prefix}-report`,
    revision: 1,
    kind: KINDS.ref(scope, "evidence_report"),
    structuredBody: structuredBody(
      compiled,
      "AI Engineer knowledge base, tenant workspace (internal). Each finding is one proposed AIDB claim whose deterministic probe verdict is directly_supported and human-confirmed; the evidence is the exact captured probe output.",
      [
        "Probe outputs were captured on the disposable lab under pinned, dated environments; a finding holds for the cells the probe ran.",
        "The human confirmation is the owner's recorded written acceptance named on each finding, not a separate review session.",
      ],
    ),
    assertions: compiled.map((item) => recordRef("assertion", item.assertion)),
    timeCoverage: { world: null, observed: null, knowledgeHead: null },
    supersedes: null,
  });
  mark("register", t);

  // L0 integrity (deterministic): custody bytes vs AIDB evidence.source_capture.content_sha256, and every selector's
  // byte range re-read from custody equals its quote.
  t = Date.now();
  const integrityMethod = method(scope, "build08-l0-capture-integrity", "build08-l0-capture-integrity.v1", {
    rule: "sha256(custody bytes) == evidence.source_capture.content_sha256; bytes[byteStart:byteEnd] == quote",
  } as unknown as JsonValue);
  const integrityEvaluator = {
    role: "auditor" as const,
    kind: "deterministic" as const,
    provider: null,
    family: null,
    model: null,
    deployment: null,
    reviewerId: null,
    methodVersion: "build08-l0-capture-integrity.v1",
    promptDigest: null,
    configDigest: integrityMethod.digest,
  };
  const integrityByKey = new Map<string, { result: string; failureCodes: string[] }>();
  for (const item of compiled) {
    const codes = new Set<string>();
    for (const l of item.located) {
      const capture = input.captures.get(l.captureId) as Capture;
      const stored = Buffer.from(await binding.custody.get(scope, capture.ref));
      if (`sha256:${hex(stored)}` !== capture.ref.digest || hex(stored) !== capture.expectedSha256)
        codes.add("capture_digest_mismatch");
      if (stored.subarray(l.start, l.end).toString("utf8") !== l.quote) codes.add("selector_unresolved");
    }
    const outcome =
      codes.size === 0 ? { result: "pass" } : { result: "fail", failureCodes: [...codes].sort() as string[] };
    integrityByKey.set(item.key, { result: outcome.result, failureCodes: [...codes].sort() });
    await coordinator.observe(
      scope,
      runId,
      observation({
        scope,
        id: `obs-l0-${item.set.id}`,
        target: recordRef("support_set", item.set),
        qualifiers: null,
        method: integrityMethod,
        evaluator: integrityEvaluator,
        rationale:
          codes.size === 0
            ? "every cited byte range resolves in custody bytes whose sha256 equals the AIDB capture digest"
            : `L0 failure: ${[...codes].join(", ")}`,
        limitations: [],
        evidence: item.located.map((l) => recordRef("fragment", l.fragment)),
        rawResponse: null,
        property: "integrity",
        outcome,
      }),
    );
  }

  // Support: the deterministic probe verdict (judge role) and the recorded human confirmation (human_reviewer).
  for (const item of compiled) {
    const claim = item.claim;
    const scripts = [
      ...new Set(
        claim.runs.map((run) => {
          const capture = input.captures.get(run.capture_id) as Capture;
          try {
            const report = JSON.parse(capture.bytes.toString("utf8")) as {
              runs?: { cell?: string; script_sha256?: string }[];
            };
            return report.runs?.find((r) => r.cell === run.cell_label)?.script_sha256 ?? null;
          } catch {
            return null;
          }
        }),
      ),
    ].filter((s): s is string => s !== null);
    const probeConfig = {
      probe: claim.probe,
      probe_id: claim.probe_id,
      probe_kind: claim.probe_kind,
      script_path: claim.script_path,
      script_sha256: claim.script_sha256 ?? (scripts.length > 0 ? scripts : null),
      verdict_id: claim.verdict_id,
      runs: claim.runs.map((r) => r.run_id),
    };
    const methodVersion = `${claim.probe.toLowerCase().replace(/[^a-z0-9_.-]/g, "-")}.v1`;
    const probeMethod = method(scope, `probe:${claim.probe}`, methodVersion, probeConfig as unknown as JsonValue);
    const verdictRecord = await binding.custody.put(
      scope,
      Buffer.from(
        canonicalJson({
          schema: "build08-loop6-probe-verdict.v1",
          claim_id: claim.claim_id,
          verdict_id: claim.verdict_id,
          verdict: claim.verdict,
          review_state: claim.review_state,
          rationale: claim.rationale,
          runs: claim.runs.map((r) => ({
            run_id: r.run_id,
            cell: r.cell_label,
            capture_id: r.capture_id,
            content_sha256: r.content_sha256,
            quotes: r.quotes,
          })),
        } as unknown as JsonValue),
        "utf8",
      ),
      "application/json",
    );
    if (claim.verdict !== "directly_supported") throw new Error(`VERDICT_NOT_OFFERABLE: ${claim.claim_id}`);
    const cited = item.located.map((l) => recordRef("fragment", l.fragment));
    const outcome = {
      verdict: "full_support",
      premise: null,
      citedFragments: cited,
      contradictingFragments: [],
      unsupportedFacets: [],
      qualification: null,
    };
    await coordinator.observe(
      scope,
      runId,
      observation({
        scope,
        id: `obs-probe-${item.set.id}`,
        target: recordRef("support_set", item.set),
        qualifiers: qualifiersDigest(item.assertion.qualifiers),
        method: probeMethod,
        evaluator: {
          role: "judge",
          kind: "deterministic",
          provider: null,
          family: null,
          model: null,
          deployment: null,
          reviewerId: null,
          methodVersion,
          promptDigest: null,
          configDigest: probeMethod.digest,
        },
        rationale: `deterministic probe ${claim.probe} (${claim.probe_kind}) verdict directly_supported: ${claim.rationale}`,
        limitations: ["the probe verdict holds for the dated, pinned environment cells it ran"],
        evidence: cited,
        rawResponse: verdictRecord,
        property: "support",
        outcome,
      }),
    );
    if (claim.review_state !== "human_confirmed") continue;
    const humanConfig = {
      reviewer: "owner.john",
      instrument:
        claim.confirmation?.instrument ??
        "written instruction, matrix row 2A, 2026-11-13: loop-4 verdicts accepted as proposed",
      verdict_id: claim.verdict_id,
    };
    const humanMethod = method(scope, "owner-written-confirmation", "owner-written-confirmation.v1", humanConfig);
    await coordinator.observe(
      scope,
      runId,
      observation({
        scope,
        id: `obs-human-${item.set.id}`,
        target: recordRef("support_set", item.set),
        qualifiers: qualifiersDigest(item.assertion.qualifiers),
        method: humanMethod,
        evaluator: {
          role: "human_reviewer",
          kind: "human",
          provider: null,
          family: null,
          model: null,
          deployment: null,
          reviewerId: "owner.john",
          methodVersion: "owner-written-confirmation.v1",
          promptDigest: null,
          configDigest: humanMethod.digest,
        },
        rationale: `Human confirmation recorded from the admission pack: ${
          claim.confirmation?.rationale ??
          "John accepted the loop-4 verdicts as proposed (matrix row 2A, written instruction, 2026-11-13)."
        }`,
        limitations: [
          "transcribed by the harness from the owner's written instruction; not a separate interactive review session",
        ],
        evidence: cited,
        rawResponse: verdictRecord,
        property: "support",
        outcome,
      }),
    );
  }
  mark("observe", t);

  // Census through report.assess: a SCRIPTED census (the harness maps each finding sentence to its own assertion).
  t = Date.now();
  const text = registered.frozen.text;
  const entries = compiled.map((item) => {
    const candidates = [escapeMarkdown(item.claim.statement, true), escapeMarkdown(item.claim.statement, false)];
    const quote = candidates.find((candidate) => text.includes(candidate)) ?? item.claim.statement;
    const polarity = polarityOf(item.claim);
    return {
      quote,
      assertionLogicalId: item.assertion.logicalId,
      negated: polarity?.negative ?? false,
      ...(polarity?.note ? { explanation: `scripted census reading: ${polarity.note}` } : {}),
    };
  });
  const auditor = new ScriptedAuditorDiscovery({ entries, unitExplanations: [] });
  const service = new ReportAssessmentService({
    binding,
    coordinator,
    operations: binding.operations,
    auditor,
    clock: systemClock,
  });
  const handle = await service.start(scope, { runId, reportRef: registered.report, requestId: `req-${prefix}` });
  const assessed = await service.run(scope, handle);
  if (assessed.error) input.log(`[${input.label}] report.assess ${assessed.state}: ${JSON.stringify(assessed.error)}`);
  const openContext = await binding.loadRunContext(scope, runId);
  const censusObservation = [...openContext.observations].reverse().find((o) => o.property === "census");
  const holds =
    censusObservation && censusObservation.property === "census" ? censusHoldReasons(censusObservation.outcome) : [];
  mark("assess", t);

  t = Date.now();
  await coordinator.sealVerificationSnapshot(scope, {
    runId,
    build: {
      buildId: `build08-loop6-${harnessDigest().slice(7, 19)}`,
      runtime: `node${process.versions.node}`,
      dirty: true,
    },
    signer: "ks-build08-loop6-harness",
  });
  const sealed = await binding.loadRunContext(scope, runId);
  mark("seal", t);

  t = Date.now();
  const authoritative = authoritativeObservations(sealed.observations);
  const support = sealed.assertions.map((assertion) =>
    evaluateSupport({
      scope: { tenant: TENANT, binding: BINDING },
      assertion,
      assertions: sealed.assertions,
      supportSets: sealed.supportSets,
      observations: authoritative,
    }),
  );
  const mapping = DomainMappingSchema.parse({
    schemaVersion: MAPPING_SCHEMA_VERSION,
    id: "build08-loop6-claim-verification",
    tenant: TENANT,
    binding: BINDING,
    targetSchema: TARGET_SCHEMA,
    rules: [
      {
        ruleId: "claim-verification",
        assertionKinds: ["world_fact"],
        target: "evidence.claim",
        includeValue: false,
        qualifierFields: [],
        requiresEntity: false,
        requiresTime: false,
      },
    ],
    entityResolutions: [],
  });
  const revision = sealed.report?.revision;
  if (!revision) throw new Error("sealed run has no report");
  const derived = reportDerive({ revision, assertions: sealed.assertions, support, mapping });

  const origin0 = harnessOrigin();
  const reportPayload = canonicalJson({
    schema: "build08-loop6-report-use.v1",
    run_id: runId,
    native_write: "none (per-claim decisions carry the native writes)",
  } as unknown as JsonValue);
  const reportBinding = bindEffect({
    effectKey: `${prefix}-report-use`,
    nativePayload: reportPayload,
    originatingOrigin: origin0,
  });
  const reportDecision = await coordinator.decideReportUse(scope, {
    runId,
    use: USE,
    audience: AUDIENCE,
    boundEffectDigest: reportBinding.boundEffectDigest as Digest,
    targetSchema: TARGET_SCHEMA,
    normalizedValues: { claim_count: String(compiled.length) },
    policy: task.policy,
    rubric: task.rubric,
  });

  const decisions: ClaimDecision[] = [];
  for (const item of compiled) {
    const claim = item.claim;
    const proposals = derived.proposals.filter((p) => p.assertion.id === item.assertion.id);
    const capturesUsed = [...new Map(claim.runs.map((r) => [r.capture_id, r.content_sha256])).entries()];
    const payload: Record<string, JsonValue> = {
      schema: TARGET_SCHEMA,
      claim_id: claim.claim_id,
      statement_sha256: claim.statement_sha256,
      probe: claim.probe,
      probe_id: claim.probe_id,
      verdict_id: claim.verdict_id,
      verdict: claim.verdict,
      review_state: claim.review_state,
      run_ids: claim.runs.map((r) => r.run_id),
      captures: capturesUsed.map(([capture_id, content_sha256]) => ({ capture_id, content_sha256 })),
      ks: {
        run_id: runId,
        assertion_id: item.assertion.id,
        support_set_id: item.set.id,
        proposal_digests: proposals.map((p) => p.proposalDigest),
        installation_id: INSTALLATION,
      },
    };
    const payloadJson = canonicalJson(payload as unknown as JsonValue);
    const effectKey = `aieng.claim-verify:${claim.claim_id}:${input.tag}-${input.label}`;
    const effectBinding = bindEffect({ effectKey, nativePayload: payloadJson, originatingOrigin: origin0 });
    const normalized: NormalizedValues = {
      claim_id: claim.claim_id,
      statement_sha256: claim.statement_sha256,
      payload_digest: digestBytes(payloadJson),
    };
    const decided = await coordinator.decideAssertionUse(scope, {
      runId,
      assertion: recordRef("assertion", item.assertion),
      use: USE,
      audience: AUDIENCE,
      boundEffectDigest: effectBinding.boundEffectDigest as Digest,
      targetSchema: TARGET_SCHEMA,
      normalizedValues: normalized,
      policy: task.policy,
      rubric: task.rubric,
    });
    decisions.push({
      claimId: claim.claim_id,
      key: item.key,
      assertionId: item.assertion.id,
      decision: decided.decision,
      effectKey,
      payload,
      payloadJson,
      binding: effectBinding,
      normalized,
      integrity: integrityByKey.get(item.key) ?? { result: "unknown", failureCodes: [] },
    });
  }
  mark("decide", t);
  const manifests = await withAdminFor(binding, runId);
  return {
    runId,
    taskId: task.id,
    reportDecision: {
      id: reportDecision.decision.id,
      disposition: reportDecision.decision.disposition,
      conditions: reportDecision.decision.conditions,
    },
    census: { holds, occurrences: entries.length, auditor: "scripted (harness reading; not an independent auditor)" },
    manifests,
    derive: {
      proposals: derived.proposals.length,
      held: derived.held.map((h) => ({ assertion: h.assertion.id, reason: h.reason })),
    },
    useClass,
    decisions,
    timings,
  };
}

let ADMIN_DSN = "";
async function withAdminFor(_binding: PostgresResearchBinding, runId: string) {
  return withAdmin(ADMIN_DSN, async (c) => {
    const rows = await c.query(
      "select manifest_kind, signing_key_id from knowledge_verification.run_manifest where tenant_id = $1 and run_id = $2::uuid order by manifest_kind",
      [TENANT, runId],
    );
    return rows.rows.map((r: { manifest_kind: string; signing_key_id: string | null }) => ({
      kind: r.manifest_kind,
      keyId: r.signing_key_id,
    }));
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Native admission: ONE transaction per decision
// ---------------------------------------------------------------------------------------------------------------------
class Rollback extends Error {
  constructor(readonly value: unknown) {
    super("ROLLBACK_REQUESTED");
  }
}

async function nativeAttempt(input: {
  db: ComponentDatabase;
  decision: ClaimDecision;
  claimId: string;
  payloadJson?: string;
  executor: string;
  rollback: boolean;
}): Promise<Record<string, unknown>> {
  const origin = harnessOrigin();
  const { decision } = input;
  const started = Date.now();
  try {
    const value = await input.db.transaction({ tenantId: TENANT, role: NATIVE_ROLE }, async (c) => {
      const admitted = await admitExactUseWithin(
        c,
        TENANT,
        {
          useDecisionId: decision.decision.id,
          boundEffectDigest: decision.binding.boundEffectDigest,
          processedEpoch: decision.decision.revocationEpoch,
          normalizedValuesDigest: normalizedValuesDigest(decision.decision.normalizedValues),
        },
        {
          effect: {
            effectKey: decision.effectKey,
            semanticPayloadDigest: decision.binding.semanticPayloadDigest,
            originatingOrigin: origin,
          },
        },
      );
      const recorded = await c.query<{ receipt_id: string }>(
        "select verification.record_admitted_claim_verification($1::uuid, $2, $3, $4, $5, $6, $7::text, $8)::text as receipt_id",
        [
          input.claimId,
          decision.decision.id,
          decision.binding.boundEffectDigest,
          decision.decision.revocationEpoch,
          normalizedValuesDigest(decision.decision.normalizedValues),
          originDigest(origin),
          input.payloadJson ?? decision.payloadJson,
          input.executor,
        ],
      );
      const receiptId = recorded.rows[0]?.receipt_id ?? null;
      const receipt = await recordExactUseReceipt(c, TENANT, {
        effectKey: decision.effectKey,
        outcome: "applied",
        nativeReceiptRef: {
          schema: "orchestration",
          table: "operation_receipt",
          receipt_id: receiptId,
          claim_id: input.claimId,
        },
        processedEpoch: decision.decision.revocationEpoch,
        useDecisionId: decision.decision.id,
      });
      const status = await c.query<{ status: string }>("select status::text from evidence.claim where id = $1::uuid", [
        input.claimId,
      ]);
      const result = {
        path: admitted.path,
        receiptId,
        effectReceiptDigest: receipt.digest,
        claimStatusInTransaction: status.rows[0]?.status ?? null,
      };
      if (input.rollback) throw new Rollback(result);
      return result;
    });
    return { outcome: "committed", ...value, ms: Date.now() - started };
  } catch (error) {
    if (error instanceof Rollback)
      return { outcome: "accepted_then_rolled_back", ...(error.value as object), ms: Date.now() - started };
    const code =
      error instanceof ExactUseAdmissionError
        ? `${error.code}:${error.reason}`
        : error instanceof AdmissionInstallationError
          ? error.code
          : null;
    return { outcome: "refused_rolled_back", code, error: errorText(error), ms: Date.now() - started };
  }
}

// ---------------------------------------------------------------------------------------------------------------------
async function main(): Promise<void> {
  const args = parseArgs();
  ADMIN_DSN = args.dsn;
  mkdirSync(args.out, { recursive: true });
  const lines: string[] = [];
  const log = (line: string) => {
    lines.push(line);
    process.stdout.write(`${line}\n`);
  };
  const started = Date.now();
  const tag = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "t");
  const pack = JSON.parse(readFileSync(args.pack, "utf8")) as Pack;
  if (pack.schema !== "aieng.claim-admission-pack.v1") throw new Error(`PACK_SCHEMA: ${pack.schema}`);
  if (pack.tenant !== TENANT) throw new Error("PACK_TENANT_MISMATCH");
  if (pack.use !== USE) throw new Error(`PACK_USE_MISMATCH: ${pack.use}`);

  const ids = pack.offered.map((c) => c.claim_id);
  const before = await claimStates(args.dsn, ids);
  const skipped: { claimId: string; status: string }[] = [];
  const pending: PackClaim[] = [];
  for (const claim of pack.offered) {
    const state = before.get(claim.claim_id);
    if (!state) throw new Error(`CLAIM_NOT_FOUND: ${claim.claim_id}`);
    if (state.statementSha256 !== claim.statement_sha256 || hex(claim.statement) !== claim.statement_sha256)
      throw new Error(`STATEMENT_DIGEST_MISMATCH: ${claim.claim_id}`);
    if (state.status === "verified") skipped.push({ claimId: claim.claim_id, status: state.status });
    else if (state.status === "proposed") pending.push(claim);
    else throw new Error(`CLAIM_NOT_PROPOSED: ${claim.claim_id} ${state.status}`);
  }
  log(`pack: ${pack.offered.length} offered, ${pending.length} proposed, ${skipped.length} already verified (skipped)`);

  // Seal key: a LAB TEST KEY (deterministic seed, testSealKeys), pinned through the binding's key ceremony.
  await pinSealSigningKey(args.dsn, { keyId: SEAL.signer.keyId, publicKey: SEAL.publicKey });
  const db = new ComponentDatabase({ connectionString: args.dsn, maximumPoolSize: 4 });
  const binding = new PostgresResearchBinding(db, BINDING, { sealVerifier: SEAL.verifier });
  const origin = harnessOrigin();
  const scope: AuthScope = {
    tenant: TENANT,
    application: APPLICATION,
    binding: BINDING,
    origin,
    grants: ["research.write"],
  };
  const guard = await db.transaction({ tenantId: TENANT, role: NATIVE_ROLE, readOnly: true }, (c) =>
    aidbGuardStatus(c),
  );
  log(`AIDB guard: ${JSON.stringify(guard)}`);
  const executor = `ks-build08-probe-admission@${harnessDigest().slice(7, 19)}`;

  const result: Record<string, unknown> = {
    schema: "build08-loop6-ks-run.v1",
    startedAt: new Date(started).toISOString(),
    tag,
    database: "disposable lab supabase_db_disposable-aieng-build04 (DSN not recorded)",
    harnessDigest: harnessDigest(),
    sealKey: { keyId: SEAL_KEY_ID, kind: "LAB TEST KEY (testSealKeys deterministic seed; not a production key)" },
    use: USE,
    audience: AUDIENCE,
    risk: RISK,
    nativeRole: NATIVE_ROLE,
    aidbGuard: guard,
    skippedAlreadyVerified: skipped,
  };
  try {
    if (pending.length === 0) {
      log("nothing to verify: every offered claim is already verified");
      result.main = null;
      result.negativeControls = { skipped: "no proposed offered claim left (controls need a fresh admitted decision)" };
    } else {
      // Captures: exact bytes from the pack's files; sha256 must equal the pack digest AND the AIDB capture digest.
      const captureIds = [...new Set(pending.flatMap((c) => c.runs.map((r) => r.capture_id)))];
      const aidbDigests = await captureDigests(args.dsn, captureIds);
      const captures = new Map<string, Capture>();
      for (const claim of pending) {
        for (const run of claim.runs) {
          if (captures.has(run.capture_id)) continue;
          const bytes = readFileSync(run.file);
          const expected = aidbDigests.get(run.capture_id);
          if (expected === undefined) throw new Error(`CAPTURE_NOT_IN_AIDB: ${run.capture_id}`);
          if (hex(bytes) !== run.content_sha256 || expected !== run.content_sha256)
            throw new Error(`CAPTURE_DIGEST_MISMATCH: ${run.capture_id}`);
          if (run.media_type !== "application/json") throw new Error(`MEDIA_TYPE: ${run.media_type}`);
          const ref = await binding.custody.put(scope, bytes, "application/json");
          captures.set(run.capture_id, {
            captureId: run.capture_id,
            bytes,
            expectedSha256: expected,
            ref,
            tampered: false,
          });
        }
      }
      log(`captures: ${captures.size} put into custody (sha256 verified against the pack and evidence.source_capture)`);

      // 1. Main run through the decisions.
      const main = await verificationRun({ label: "main", tag, scope, binding, claims: pending, captures, log });
      for (const d of main.decisions)
        log(
          `[main] ${d.key} ${d.claimId} decision ${d.decision.id} ${d.decision.disposition} [${d.decision.conditions.join(",")}]`,
        );
      log(
        `[main] report decision ${main.reportDecision.disposition} [${main.reportDecision.conditions.join(",")}]; census holds [${main.census.holds.join(",")}]`,
      );

      // 2. Negative control (a): tampered bytes, its own run. The harness pre-check refuses it (digest != AIDB capture
      // digest); the control then proceeds deliberately through KS to show the component also refuses to admit.
      const tamperClaim = pending[0] as PackClaim;
      const tamperRun = tamperClaim.runs[0] as PackRun;
      const original = captures.get(tamperRun.capture_id) as Capture;
      const tamperedBytes = Buffer.from(original.bytes);
      const flipAt = tamperedBytes.indexOf(Buffer.from('"probe"', "utf8")) + 1; // the p of the first "probe" key
      tamperedBytes[flipAt] = "q".charCodeAt(0);
      const preCheck = {
        sha256: hex(tamperedBytes),
        expected: original.expectedSha256,
        refusedByPreCheck: hex(tamperedBytes) !== original.expectedSha256,
        flippedByte: flipAt,
      };
      const tamperRef = await binding.custody.put(scope, tamperedBytes, "application/json");
      const tamperCaptures = new Map<string, Capture>(captures);
      tamperCaptures.set(tamperRun.capture_id, {
        captureId: tamperRun.capture_id,
        bytes: tamperedBytes,
        expectedSha256: original.expectedSha256,
        ref: tamperRef,
        tampered: true,
      });
      const tamperOnly: PackClaim = { ...tamperClaim, runs: [tamperRun] };
      const tamper = await verificationRun({
        label: "tamper",
        tag,
        scope,
        binding,
        claims: [tamperOnly],
        captures: tamperCaptures,
        log,
      });
      const tamperDecision = tamper.decisions[0] as ClaimDecision;
      const tamperNative = await nativeAttempt({
        db,
        decision: tamperDecision,
        claimId: tamperClaim.claim_id,
        executor,
        rollback: true,
      });
      log(
        `[control a] tampered: precheck refused=${preCheck.refusedByPreCheck}; decision ${tamperDecision.decision.disposition} [${tamperDecision.decision.conditions.join(",")}]; native ${tamperNative.outcome} ${tamperNative.code ?? ""}`,
      );

      // 3. Negative control (b): claim A's admitted decision presented for claim B (both still proposed), rolled back.
      const admitted = main.decisions.filter((d) => d.decision.disposition === "admitted");
      const controls: Record<string, unknown> = {
        a_tampered_bytes: {
          claimId: tamperClaim.claim_id,
          captureId: tamperRun.capture_id,
          preCheck,
          runId: tamper.runId,
          integrity: tamperDecision.integrity,
          decision: {
            id: tamperDecision.decision.id,
            disposition: tamperDecision.decision.disposition,
            conditions: tamperDecision.decision.conditions,
          },
          native: tamperNative,
          note: "KS rows of the control run (task, run, observations, seal, held decision) persist in the component; the native attempt is in its own transaction",
        },
      };
      if (admitted.length >= 2) {
        const a = admitted[0] as ClaimDecision;
        const b = admitted[1] as ClaimDecision;
        controls.b1_cross_claim_same_payload = {
          decisionOf: a.claimId,
          presentedFor: b.claimId,
          native: await nativeAttempt({ db, decision: a, claimId: b.claimId, executor, rollback: true }),
        };
        const forged = canonicalJson({
          ...a.payload,
          claim_id: b.claimId,
          statement_sha256: b.payload.statement_sha256,
        } as JsonValue);
        controls.b2_cross_claim_payload_rewritten_for_b = {
          decisionOf: a.claimId,
          presentedFor: b.claimId,
          note: "A's decision and bound effect digest, with a payload rewritten to name B; always rolled back",
          native: await nativeAttempt({
            db,
            decision: a,
            claimId: b.claimId,
            payloadJson: forged,
            executor,
            rollback: true,
          }),
        };
        log(`[control b1] ${JSON.stringify((controls.b1_cross_claim_same_payload as { native: unknown }).native)}`);
        log(
          `[control b2] ${JSON.stringify((controls.b2_cross_claim_payload_rewritten_for_b as { native: unknown }).native)}`,
        );
      } else {
        controls.b = { skipped: `needs two admitted decisions; have ${admitted.length}` };
      }

      // 4. The native writes: one transaction per admitted decision.
      const native: Record<string, unknown>[] = [];
      for (const d of main.decisions) {
        if (d.decision.disposition !== "admitted") {
          native.push({ claimId: d.claimId, outcome: "not_attempted", reason: `decision ${d.decision.disposition}` });
          continue;
        }
        const attempt = await nativeAttempt({ db, decision: d, claimId: d.claimId, executor, rollback: false });
        native.push({ claimId: d.claimId, decisionId: d.decision.id, ...attempt });
        log(
          `[native] ${d.key} ${d.claimId} ${attempt.outcome} receipt=${attempt.receiptId ?? "-"} ${attempt.code ?? ""}`,
        );
      }

      // 5. Control (c): A's decision for an already verified B (rolled back): does the AIDB idempotent path check it?
      const committed = main.decisions.filter((d) =>
        native.some((n) => n.claimId === d.claimId && n.outcome === "committed"),
      );
      if (committed.length >= 2) {
        const a = committed[0] as ClaimDecision;
        const b = committed[1] as ClaimDecision;
        controls.c_cross_claim_on_already_verified = {
          decisionOf: a.claimId,
          presentedFor: b.claimId,
          native: await nativeAttempt({ db, decision: a, claimId: b.claimId, executor, rollback: true }),
        };
        log(
          `[control c] ${JSON.stringify((controls.c_cross_claim_on_already_verified as { native: unknown }).native)}`,
        );
      }

      result.main = {
        runId: main.runId,
        taskId: main.taskId,
        useClass: main.useClass,
        sealManifests: main.manifests,
        census: main.census,
        derive: main.derive,
        reportDecision: main.reportDecision,
        claims: main.decisions.map((d) => ({
          key: d.key,
          claimId: d.claimId,
          assertionId: d.assertionId,
          integrity: d.integrity,
          decisionId: d.decision.id,
          disposition: d.decision.disposition,
          conditions: d.decision.conditions,
          revocationEpoch: d.decision.revocationEpoch,
          effectKey: d.effectKey,
          boundEffectDigest: d.binding.boundEffectDigest,
          native: native.find((n) => n.claimId === d.claimId) ?? null,
        })),
        timings: main.timings,
      };
      result.tamperRun = {
        runId: tamper.runId,
        sealManifests: tamper.manifests,
        census: tamper.census,
        timings: tamper.timings,
      };
      result.negativeControls = controls;
    }
    const after = await withAdmin(args.dsn, async (c) => ({
      verifiedCount: Number(
        (
          await c.query("select count(*)::int n from evidence.claim where tenant_id = $1 and status = 'verified'", [
            TENANT,
          ])
        ).rows[0].n,
      ),
      offeredStatus: (
        await c.query("select id::text, status::text from evidence.claim where id = any($1::uuid[]) order by id", [ids])
      ).rows,
      apiVerifiedClaims: (
        await c.query(
          "select claim_id::text, receipt_id::text, use_decision_id, bound_effect_digest, executor_version, verified_at from api.verified_claims order by claim_id",
        )
      ).rows,
      statusCounts: (
        await c.query(
          "select status::text, count(*)::int n from evidence.claim where tenant_id = $1 group by 1 order by 1",
          [TENANT],
        )
      ).rows,
    }));
    result.after = after;
    log(`after: verified=${after.verifiedCount}; api.verified_claims rows=${after.apiVerifiedClaims.length}`);
  } catch (error) {
    result.error = { ...errorText(error), stack: (error as Error).stack ?? null };
    log(`ERROR ${(error as Error).stack ?? String(error)}`);
    process.exitCode = 1;
  } finally {
    await db.end();
    result.finishedAt = new Date().toISOString();
    result.totalMs = Date.now() - started;
    writeJson(join(args.out, "result.json"), result);
    writeFileSync(join(args.out, "run.log"), `${lines.join("\n")}\n`);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
  process.exitCode = 2;
});
