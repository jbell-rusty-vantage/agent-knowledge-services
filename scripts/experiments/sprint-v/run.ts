import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AuthorityChallengeService,
  CrossrefRevisionFrontier,
  ReportAssessmentService,
  ReportKindCatalog,
  ResearchCoordinator,
  ResearchCoordinatorError,
  ScriptedAuditorDiscovery,
  SourceAuthorityCatalog,
  systemClock,
  testSealKeys,
  toInstant,
  type AuditorDiscovery,
  type DiscoveryInput,
  type DiscoveryResult,
} from "../../../packages/application/dist/index.js";
import {
  ComponentDatabase,
  PostgresResearchBinding,
  pinSealSigningKey,
} from "../../../packages/bindings/aiengineer-postgres/dist/index.js";
import { install, loadComponent } from "../../../packages/knowledge-db-contract/dist/index.js";
import {
  AdmissionInstallationError,
  ExactUseAdmissionError,
  admitExactUseWithin,
  lookupExactUseReceipt,
  recordExactUseReceipt,
} from "../../../packages/knowledge-db/dist/index.js";
import {
  type Digest,
  type Origin,
  type Ref,
  bindEffect,
  canonicalJson,
  digestBytes,
  digestCanonical,
  type JsonValue,
} from "../../../packages/knowledge-operation-protocol/dist/index.js";
import {
  type AssertionVersion,
  type AuthScope,
  DomainMappingSchema,
  type EvidenceFragment,
  MAPPING_SCHEMA_VERSION,
  type NormalizedValues,
  type UseDecision,
  authoritativeObservations,
  censusHoldReasons,
  evaluateSupport,
  normalizedValuesDigest,
  recordRef,
  reportDerive,
} from "../../../packages/research-core/dist/index.js";
import { type ChainResult, ANALYSIS_PLAN, computeAnalysis, planDigest } from "./analysis.js";
import {
  type FixtureCase,
  type KindId,
  type LoadedFixtures,
  type ProducerDraft,
  buildTask,
  compileDraft,
  loadFixtures,
} from "./fixtures.js";
import { BudgetBlocked, Meter } from "./meter.js";
import {
  type CallContext,
  type CallRecord,
  Credentials,
  DRAFT_SCHEMAS,
  JUDGE_SCHEMA,
  JUDGE_SYSTEM,
  type JudgeInput,
  ModelAuditorDiscovery,
  PRODUCER_SYSTEM,
  type Pins,
  callJson,
  discover,
  evaluatorFor,
  judgeUser,
  labelScript,
  labelVerdict,
  pin,
  producerUser,
  recordedChallenge,
  recordedCrossrefFetch,
  recordedResolver,
  supportObservation,
  supportOutcome,
  usd,
} from "./providers.js";

/**
 * SV-09 direct service harness (Sprint V checkpoint C): drives the KS application directly (ResearchCoordinator +
 * PostgreSQL binding on a disposable database; no Mission Control) for both K08 report kinds:
 *   freeze task -> put fragments -> producer draft -> register report -> judge support (judge, second family) ->
 *   recorded authority/challenge -> report.assess (independent auditor census) -> seal -> derive -> decide report and
 *   assertion use -> native admission inside one transaction with a stand-in domain write -> effect receipt ->
 *   exact package read with digest verification.
 * Modes: `--mode t0` (recorded producer, label judges, scripted auditor; no cost; must pass first) and `--mode paid`
 * (live metered calls, ceiling USD 6.00 across every run of this helper).
 */
const here = dirname(fileURLToPath(import.meta.url));
const KS_ROOT = resolve(here, "../../..");
const PROOFS = join(KS_ROOT, ".scratch/sprint-v/proofs/SV-09");
const HARNESS_FILES = ["run.ts", "fixtures.ts", "manifest.ts", "meter.ts", "analysis.ts", "providers.ts"];
const TENANT = "00000000-0000-7000-8000-0000000009c9";
const INSTALLATION = "0192a4f0-0000-7000-8000-000000000909";
const BINDING = "aiengineer-postgres";
const ADMIN_DSN =
  process.env.KNOWLEDGE_DB_CONTRACT_ADMIN_DSN ?? "postgresql://sprintv:sprintv-disposable@127.0.0.1:55433/postgres";
const KINDS = ReportKindCatalog.fromDirectory(join(KS_ROOT, "catalog/research/report-kinds"));
const AUTHORITY = SourceAuthorityCatalog.fromDirectory(join(KS_ROOT, "catalog/research/source-authority"));
const SEAL = testSealKeys("sv09-harness-seal-1");
const NATIVE_TABLE = "public.sv09_native_fact";

const requireFromBinding = createRequire(join(KS_ROOT, "packages/bindings/aiengineer-postgres/package.json"));
// biome-ignore lint/suspicious/noExplicitAny: pg is resolved from the binding package at runtime (no root dependency).
const pg = requireFromBinding("pg") as { Client: new (config: { connectionString: string }) => any };

interface Args {
  mode: "t0" | "paid";
  run: string;
  envFile: string | null;
  chains: ("producer" | "reference")[];
  secondFamily: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const value = (name: string) => {
    const index = argv.indexOf(name);
    return index >= 0 ? (argv[index + 1] ?? null) : null;
  };
  const mode = value("--mode") === "paid" ? "paid" : "t0";
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
  return {
    mode,
    run: value("--run") ?? `${mode}-${stamp}`,
    envFile: value("--env-file"),
    chains: (value("--chains") ?? "producer,reference")
      .split(",")
      .filter((c) => c === "producer" || c === "reference") as ("producer" | "reference")[],
    secondFamily: !argv.includes("--no-second-family"),
  };
}

const sha = (bytes: Buffer | string) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const harnessDigest = () =>
  sha(HARNESS_FILES.map((name) => `${name}:${sha(readFileSync(join(here, name)))}`).join("\n"));
const writeJson = (path: string, value: unknown) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

function tickClock(base = "2026-10-25T01:00:00Z") {
  let tick = 0;
  return { now: () => toInstant(new Date(Date.parse(base) + 1000 * tick++)) };
}

function dsnFor(database: string): string {
  const url = new URL(ADMIN_DSN);
  url.pathname = `/${database}`;
  return url.toString();
}

interface Installation {
  readonly name: string;
  readonly applicationId: string;
  readonly database: string;
  readonly db: ComponentDatabase;
  readonly binding: PostgresResearchBinding;
  readonly receipt: unknown;
}

async function createInstallation(name: string, applicationId: string, tag: string): Promise<Installation> {
  const database = `kv09_${tag}_${name}`.toLowerCase().replace(/[^a-z0-9_]/g, "_");
  const admin = new pg.Client({ connectionString: ADMIN_DSN });
  await admin.connect();
  await admin.query(`create database ${database}`);
  await admin.end();
  const receipt = await install(loadComponent(), {
    adminDsn: dsnFor(database),
    installationId: INSTALLATION,
    applicationId,
    binding: BINDING,
  });
  await pinSealSigningKey(dsnFor(database), { keyId: SEAL.signer.keyId, publicKey: SEAL.publicKey });
  // Disposable stand-in for the AI Engineer native domain write (the AIDB tables live only on Supabase/AIDB).
  const owner = new pg.Client({ connectionString: dsnFor(database) });
  await owner.connect();
  await owner.query(
    `create table ${NATIVE_TABLE} (tenant_id uuid not null, effect_key text not null, proposal_digest text not null,
       target text not null, payload jsonb not null, primary key (effect_key, proposal_digest))`,
  );
  await owner.query(
    `grant select, insert on ${NATIVE_TABLE} to knowledge_verification_writer, knowledge_verification_reader`,
  );
  await owner.query("grant usage on schema public to knowledge_verification_writer, knowledge_verification_reader");
  await owner.end();
  const db = new ComponentDatabase({ connectionString: dsnFor(database), maximumPoolSize: 4 });
  const binding = new PostgresResearchBinding(db, BINDING, { sealVerifier: SEAL.verifier });
  return { name, applicationId, database, db, binding, receipt };
}

async function dropInstallation(installation: Installation, runDir: string): Promise<void> {
  // Keep a receipt of the disposable rows that matter before the database is dropped.
  const dump = await installation.db.transaction(
    { tenantId: TENANT, role: "knowledge_verification_reader", readOnly: true },
    async (c) => ({
      useDecisions: (
        await c.query(
          "select use_decision_id, disposition, revocation_epoch, bound_effect_digest, normalized_values_digest from knowledge_verification.use_decision where tenant_id = $1 order by use_decision_id",
          [TENANT],
        )
      ).rows,
      effectReceipts: (
        await c.query(
          "select effect_key, outcome, use_decision_id, digest from knowledge_verification.effect_receipt where tenant_id = $1 order by effect_key",
          [TENANT],
        )
      ).rows,
      manifests: (
        await c.query(
          "select run_id::text, manifest_kind, signing_key_id from knowledge_verification.run_manifest where tenant_id = $1 order by run_id, manifest_kind",
          [TENANT],
        )
      ).rows,
      nativeRows: (
        await c.query(
          `select effect_key, proposal_digest, target from ${NATIVE_TABLE} order by effect_key, proposal_digest`,
        )
      ).rows,
    }),
  );
  writeJson(join(runDir, `db-${installation.name}.json`), {
    database: installation.database,
    applicationId: installation.applicationId,
    install: installation.receipt,
    ...dump,
  });
  await installation.db.end();
  const admin = new pg.Client({ connectionString: ADMIN_DSN });
  await admin.connect();
  await admin.query(`drop database if exists ${installation.database} with (force)`);
  await admin.end();
}

function harnessOrigin(): Origin {
  return {
    kind: "standalone",
    installationId: INSTALLATION,
    applicationId: "ai-engineer",
    tenantId: TENANT,
    issuer: "ks-sv09-harness",
    subject: "sv09-direct-service-harness",
    mission: null,
    recoveryAuthorityRef: null,
    invocationId: "inv-sv09",
    authenticatedAt: "2026-10-25T00:00:00Z",
  };
}

interface Evaluators {
  readonly mode: "t0" | "paid";
  readonly context: CallContext | null;
  readonly pins: Pins | null;
  readonly secondFamily: boolean;
}

/** One chain of one report kind on one installation. Never throws: every failure is recorded in the result. */
async function runChain(input: {
  chain: ChainResult["chain"];
  kase: FixtureCase;
  fixtures: LoadedFixtures;
  installation: Installation;
  evaluators: Evaluators;
  runDir: string;
  clock: { now(): string };
}): Promise<ChainResult> {
  const { kase, installation, evaluators } = input;
  const { spec, labels } = kase;
  const binding = installation.binding;
  const origin = harnessOrigin();
  const scope: AuthScope = {
    tenant: TENANT,
    application: "ai-engineer",
    binding: BINDING,
    origin,
    grants: ["research.write"],
  };
  const prefix = `${input.chain === "producer" ? "pr" : input.chain === "reference" ? "rf" : "t0"}`;
  const result: ChainResult = {
    chain: input.chain,
    installation: `${installation.name} (${installation.applicationId})`,
    kind: kase.kind,
    runId: null,
    compileIssues: [],
    registration: { ok: false },
    keyObligations: {},
    judgments: [],
    census: null,
    aggregate: null,
    obligationStatus: {},
    assessmentState: null,
    reportDecision: null,
    assertionDecisions: [],
    appraisalJudgments: {},
    derive: null,
    native: [],
    exactRead: null,
    errors: [],
  };
  const tag = `${input.chain}-${kase.kind}`;
  try {
    const captures = new Map<string, Ref<"artifact">>();
    for (const id of spec.sources) {
      const source = input.fixtures.sources.get(id);
      if (source) captures.set(id, await binding.custody.put(scope, source.bytes, "text/markdown; charset=utf-8"));
    }
    const taskArtifact = await binding.custody.put(scope, kase.specBytes, "application/json");
    // One frozen task per chain: the binding refuses a second freeze of the same task id in one tenant.
    const task = { ...buildTask(spec, scope, taskArtifact), id: `${spec.id}.${input.chain}` };
    const coordinator = new ResearchCoordinator(binding, input.clock, KINDS, {
      signer: SEAL.signer,
      authority: AUTHORITY,
    });
    const { runId } = await coordinator.openRun(scope, { task, originatingOrigin: origin });
    result.runId = runId;

    // Producer: the recorded reference draft (t0, reference) or one live producer call (producer chain).
    let draft: ProducerDraft = kase.reference;
    if (input.chain === "producer") {
      const context = evaluators.context as CallContext;
      const pins = evaluators.pins as Pins;
      let produced: ProducerDraft | null = null;
      for (const attempt of [1, 2]) {
        const call = await callJson(context, {
          id: `${tag}-producer-${attempt}`,
          provider: "openai",
          model: pins.producer.model,
          role: "producer",
          system: PRODUCER_SYSTEM,
          user: producerUser(spec, input.fixtures.sources),
          schemaName: `${kase.kind}_draft`,
          schema: DRAFT_SCHEMAS[kase.kind],
          maxOutputTokens: 16000,
          effort: "medium",
        });
        if (call.json !== null) {
          produced = call.json as ProducerDraft;
          await binding.custody.put(scope, call.rawBytes, "application/json");
          break;
        }
        result.errors.push(`producer attempt ${attempt}: ${call.record.status} ${call.record.error ?? ""}`);
      }
      if (produced === null) throw new Error("PRODUCER_FAILED: no parseable draft after the bounded retry");
      draft = produced;
      writeJson(join(input.runDir, `${tag}-draft.json`), draft);
    }
    const compiled = compileDraft({
      spec,
      draft,
      sources: input.fixtures.sources,
      captures,
      scope,
      producer: origin,
      chain: prefix,
    });
    result.compileIssues = compiled.issues.map((issue) => ({ ...issue }));
    const obligationsOf = new Map<string, string[]>();
    for (const entry of draft.assertions) {
      const key = [...compiled.byKey.keys()].find(
        (candidate) =>
          candidate ===
          entry.key
            .replace(/[^A-Za-z0-9_-]/g, "_")
            .replace(/^[^A-Za-z0-9]+/, "")
            .slice(0, 40),
      );
      if (key)
        obligationsOf.set(
          key,
          entry.obligations.filter((id) => spec.obligations.some((o) => o.id === id)),
        );
    }
    result.keyObligations = Object.fromEntries(obligationsOf);
    const keyOf = (assertion: AssertionVersion) =>
      [...compiled.byKey.entries()].find(([, candidate]) => candidate.id === assertion.id)?.[0] ?? assertion.id;
    await coordinator.registerEvidence(scope, {
      fragments: compiled.fragments,
      assertions: compiled.assertions,
      supportSets: compiled.supportSets,
    });
    let registered: Awaited<ReturnType<ResearchCoordinator["registerReport"]>>;
    try {
      registered = await coordinator.registerReport(scope, {
        runId,
        reportId: `${prefix}-${kase.kind}-report`,
        revision: 1,
        kind: KINDS.ref(scope, kase.kind),
        structuredBody: compiled.body,
        assertions: compiled.assertions.map((assertion) => recordRef("assertion", assertion)),
        timeCoverage: { world: null, observed: null, knowledgeHead: null },
        supersedes: null,
      });
      result.registration = { ok: true };
      writeFileSync(join(input.runDir, `${tag}-body.md`), registered.frozen.bytes);
    } catch (error) {
      if (error instanceof ResearchCoordinatorError) {
        result.registration = { ok: false, code: error.code, violations: error.violations };
        result.errors.push(`registerReport refused: ${error.message}`);
        return result;
      }
      throw error;
    }

    // Judgment 1: support, per support set (judge; second-family judge on the reference chain subset).
    const fragmentsById = new Map(compiled.fragments.map((fragment) => [fragment.id, fragment]));
    const roles: ("judge" | "second_family_judge")[] =
      evaluators.mode === "paid" && input.chain === "reference" && evaluators.secondFamily
        ? ["judge", "second_family_judge"]
        : ["judge"];
    for (const set of compiled.supportSets) {
      const assertion = compiled.assertions.find(
        (candidate) => recordRef("assertion", candidate).digest === set.assertion.digest,
      ) as AssertionVersion;
      const key = keyOf(assertion);
      const judgeInput: JudgeInput = {
        scope,
        assertion,
        set,
        fragments: fragmentsById,
        quotes: compiled.quotes,
        obligations: obligationsOf.get(key) ?? [],
        clock: input.clock,
      };
      for (const role of roles) {
        const user = judgeUser(judgeInput);
        const inputDigest = digestCanonical({ system: JUDGE_SYSTEM, user } as unknown as JsonValue);
        if (evaluators.mode === "t0") {
          const raw = labelVerdict(labels, judgeInput.obligations, set);
          const { outcome, coercions } = supportOutcome(judgeInput, raw);
          const observation = supportObservation({
            judge: judgeInput,
            id: `obs-${role}-${set.id}`.slice(0, 200),
            evaluator: evaluatorFor(role, null, "sv09-label-judge.v1", null, {
              labels: labels.task,
            } as unknown as JsonValue),
            outcome,
            rationale: "T0 recorded verdict from the fixture labels (no model call)",
            limitations: ["recorded label verdict; not an evaluator measurement"],
            rawResponse: null,
            usage: { providerCalls: 0, tokens: 0, costUsd: "0" },
            inputDigest,
          });
          await coordinator.observe(scope, runId, observation);
          result.judgments.push({
            set: set.id,
            assertionKey: key,
            role,
            verdict: String(outcome.verdict),
            coercions,
            callId: null,
            blocked: null,
          });
          continue;
        }
        const pins = evaluators.pins as Pins;
        const model = role === "judge" ? pins.judge : pins.secondFamily;
        const config = { model: model.model, schema: JUDGE_SCHEMA, effort: "low", maxOutputTokens: 4000 };
        try {
          const call = await callJson(evaluators.context as CallContext, {
            id: `${tag}-${role}-${set.id}`.slice(0, 180),
            provider: model.provider,
            model: model.model,
            role,
            system: JUDGE_SYSTEM,
            user,
            schemaName: "support_judgment",
            schema: JUDGE_SCHEMA,
            maxOutputTokens: 4000,
            effort: "low",
          });
          if (call.json === null) {
            result.judgments.push({
              set: set.id,
              assertionKey: key,
              role,
              verdict: null,
              coercions: [],
              callId: call.record.id,
              blocked: `${call.record.status}: ${call.record.error ?? ""}`,
            });
            continue;
          }
          const raw = call.json as Parameters<typeof supportOutcome>[1] & { rationale: string };
          const { outcome, coercions } = supportOutcome(judgeInput, raw);
          const rawRef = await binding.custody.put(scope, call.rawBytes, "application/json");
          const observation = supportObservation({
            judge: judgeInput,
            id: `obs-${role}-${set.id}`.slice(0, 200),
            evaluator: evaluatorFor(
              role,
              model,
              "sv09-support-judge.v1",
              digestBytes(JUDGE_SYSTEM),
              config as unknown as JsonValue,
            ),
            outcome,
            rationale: raw.rationale ?? "",
            limitations: [
              "control slice: single call, synthetic fixture",
              ...(coercions.length > 0 ? [`schema coercions: ${coercions.join("; ")}`] : []),
            ],
            rawResponse: rawRef,
            usage: {
              providerCalls: 1,
              tokens: call.record.usage.inputTokens + call.record.usage.outputTokens,
              costUsd: usd(call.record.costUsd),
            },
            inputDigest,
          });
          await coordinator.observe(scope, runId, observation);
          result.judgments.push({
            set: set.id,
            assertionKey: key,
            role,
            verdict: String(outcome.verdict),
            coercions,
            callId: call.record.id,
            blocked: null,
          });
        } catch (error) {
          if (!(error instanceof BudgetBlocked)) throw error;
          result.judgments.push({
            set: set.id,
            assertionKey: key,
            role,
            verdict: null,
            coercions: [],
            callId: null,
            blocked: "blocked:budget",
          });
        }
      }
    }

    // Judgment 2: source authority and bounded challenge, recorded fakes only (no paid frontier calls).
    const authority = new AuthorityChallengeService(binding, input.clock, AUTHORITY);
    const crossref = recordedCrossrefFetch(input.fixtures.sources);
    await authority.recordAuthority(scope, {
      runId,
      resolver: recordedResolver(scope, input.fixtures.sources),
      frontier: new CrossrefRevisionFrontier({ fetch: crossref }),
    });
    const contraryFor = (assertion: AssertionVersion): EvidenceFragment[] => {
      const set = compiled.supportSets.find((candidate) => candidate.assertion.id === assertion.id);
      return (set?.contrary ?? [])
        .map((ref) => fragmentsById.get(ref.id))
        .filter((f): f is EvidenceFragment => f !== undefined);
    };
    await authority.recordChallenge(scope, {
      runId,
      search: recordedChallenge(scope, labels, (assertion) => obligationsOf.get(keyOf(assertion)) ?? [], contraryFor),
      maxQueries: 2,
    });

    // Judgment 3: report adequacy through the asynchronous report.assess operation and the independent auditor census.
    let auditorName = "scripted (labels)";
    let modelAuditor: ModelAuditorDiscovery | null = null;
    const scripted = new ScriptedAuditorDiscovery(labelScript(labels, (key) => `${spec.id}.${key}`));
    let lastDiscovery: DiscoveryResult | null = null;
    if (evaluators.mode === "paid") {
      const pins = evaluators.pins as Pins;
      modelAuditor = new ModelAuditorDiscovery(
        evaluators.context as CallContext,
        pins.auditor,
        binding.custody,
        `${tag}-auditor`,
      );
      auditorName = `model ${pins.auditor.model}`;
    }
    const live = modelAuditor;
    const auditor: AuditorDiscovery = {
      discover: async (s, d: DiscoveryInput): Promise<DiscoveryResult> => {
        if (live !== null) {
          try {
            lastDiscovery = await live.discover(s, d);
            return lastDiscovery;
          } catch (error) {
            if (!(error instanceof BudgetBlocked)) throw error;
            auditorName = "scripted (labels) after blocked:budget";
          }
        }
        lastDiscovery = await scripted.discover(s, d);
        return lastDiscovery;
      },
    };
    const service = new ReportAssessmentService({
      binding,
      coordinator,
      operations: binding.operations,
      auditor,
      clock: input.clock,
    });
    const handle = await service.start(scope, { runId, reportRef: registered.report, requestId: `req-${tag}` });
    const assessed = await service.run(scope, handle);
    result.assessmentState = assessed.state;
    if (assessed.error) result.errors.push(`report.assess ${assessed.state}: ${JSON.stringify(assessed.error)}`);
    const openContext = await binding.loadRunContext(scope, runId);
    const censusObservation = [...openContext.observations].reverse().find((o) => o.property === "census");
    const audit = modelAuditor?.audits[modelAuditor.audits.length - 1];
    const text = registered.frozen.text;
    const discovery = lastDiscovery as DiscoveryResult | null;
    result.census = {
      status: censusObservation ? "assessed" : "not_run",
      holds:
        censusObservation && censusObservation.property === "census"
          ? censusHoldReasons(censusObservation.outcome)
          : [],
      discovered: (discovery?.occurrences ?? []).map((o) => ({
        path: o.blockPath,
        text: text.slice(o.span.start, o.span.end),
        assertion: o.assertion?.id ?? null,
        negated: o.negated,
      })),
      unitExplanations: [...(discovery?.unitExplanations ?? [])],
      dropped: audit?.dropped.length ?? 0,
      auditor: auditorName,
    };
    if (audit) writeJson(join(input.runDir, `${tag}-auditor-dropped.json`), audit.dropped);

    // Seal the verification snapshot (K07 signed), then derive and decide from the sealed run only.
    await coordinator.sealVerificationSnapshot(scope, {
      runId,
      build: { buildId: `sv09-${harnessDigest().slice(7, 19)}`, runtime: `node${process.versions.node}`, dirty: true },
      signer: "ks-sv09-harness",
    });
    const sealed = await binding.loadRunContext(scope, runId);
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
    const resolution = await binding.custody.put(
      scope,
      Buffer.from(
        canonicalJson({
          schema: "sv09-entity-resolution.v1",
          resolutions: spec.mapping.entityResolutions,
        } as unknown as JsonValue),
        "utf8",
      ),
      "application/json",
    );
    const mapping = DomainMappingSchema.parse({
      schemaVersion: MAPPING_SCHEMA_VERSION,
      id: spec.mapping.id,
      tenant: TENANT,
      binding: BINDING,
      targetSchema: spec.mapping.targetSchema,
      rules: spec.mapping.rules.map((rule) => ({ ...rule })),
      entityResolutions: spec.mapping.entityResolutions.map((entry) => ({ ...entry, resolution })),
    });
    const revision = sealed.report?.revision;
    if (!revision) throw new Error("sealed run has no report");
    const derived = reportDerive({ revision, assertions: sealed.assertions, support, mapping });
    result.derive = {
      proposals: derived.proposals.length,
      held: derived.held.map((item) => ({ assertion: item.assertion.id, reason: item.reason })),
    };
    writeJson(join(input.runDir, `${tag}-derived.json`), derived);

    const effectFor = (key: string, proposals: typeof derived.proposals) => {
      const payload = canonicalJson({
        schema: "sv09.native-effect.v1",
        targetSchema: mapping.targetSchema,
        proposals: proposals.map((p) => ({
          digest: p.proposalDigest,
          target: p.target,
          entityId: p.entityId,
          value: p.value,
          fields: p.fields,
        })),
      } as unknown as JsonValue);
      return {
        key,
        payload,
        binding: bindEffect({ effectKey: key, nativePayload: payload, originatingOrigin: origin }),
      };
    };
    const normalized = (proposals: typeof derived.proposals): NormalizedValues => ({
      proposal_count: String(proposals.length),
      proposals_digest: digestCanonical(proposals.map((p) => p.proposalDigest) as unknown as JsonValue),
    });

    // Judgment 4: use eligibility (report-level and per assertion), bound to the exact effect bytes.
    const reportEffect = effectFor(`${prefix}-${kase.kind}-report`, derived.proposals);
    const reportDecision = await coordinator.decideReportUse(scope, {
      runId,
      use: task.use,
      audience: task.audience,
      boundEffectDigest: reportEffect.binding.boundEffectDigest as Digest,
      targetSchema: mapping.targetSchema,
      normalizedValues: normalized(derived.proposals),
      policy: task.policy,
      rubric: task.rubric,
    });
    result.aggregate = reportDecision.aggregate as unknown as Record<string, unknown>;
    result.obligationStatus = Object.fromEntries(reportDecision.aggregate.obligations.map((o) => [o.id, o.status]));
    result.reportDecision = {
      id: reportDecision.decision.id,
      disposition: reportDecision.decision.disposition,
      conditions: reportDecision.decision.conditions,
    };
    const decisions: {
      subject: string;
      decision: UseDecision;
      effect: ReturnType<typeof effectFor>;
      proposals: typeof derived.proposals;
    }[] = [
      { subject: "report", decision: reportDecision.decision, effect: reportEffect, proposals: [...derived.proposals] },
    ];
    for (const assertion of sealed.assertions) {
      const key = keyOf(assertion);
      const proposals = derived.proposals.filter((p) => p.assertion.id === assertion.id);
      const effect = effectFor(`${prefix}-${kase.kind}-${key}`.slice(0, 190), proposals);
      const decided = await coordinator.decideAssertionUse(scope, {
        runId,
        assertion: recordRef("assertion", assertion),
        use: task.use,
        audience: task.audience,
        boundEffectDigest: effect.binding.boundEffectDigest as Digest,
        targetSchema: mapping.targetSchema,
        normalizedValues: normalized(proposals),
        policy: task.policy,
        rubric: task.rubric,
      });
      result.assertionDecisions.push({
        key,
        id: decided.decision.id,
        disposition: decided.decision.disposition,
        conditions: decided.decision.conditions,
      });
      decisions.push({ subject: `assertion:${key}`, decision: decided.decision, effect, proposals });
      if (assertion.qualifiers.profile === "scientific.v2") {
        for (const obligation of obligationsOf.get(key) ?? []) {
          if (obligation.startsWith("domain."))
            result.appraisalJudgments[obligation] = assertion.qualifiers.appraisalJudgment;
        }
      }
    }

    // Native admission inside ONE transaction: bind effect, admit (component rule; AIDB guard on ai-engineer),
    // stand-in domain write, effect receipt. A refusal rolls everything back.
    for (const item of decisions) {
      if (item.proposals.length === 0) {
        result.native.push({
          subject: item.subject,
          decisionId: item.decision.id,
          disposition: item.decision.disposition,
          outcome: "skipped",
          path: null,
          code: "NO_PROPOSAL",
          receiptDigest: null,
          rows: 0,
        });
        continue;
      }
      try {
        const applied = await installation.db.transaction(
          { tenantId: TENANT, role: "knowledge_verification_writer" },
          async (c) => {
            const admitted = await admitExactUseWithin(
              c,
              TENANT,
              {
                useDecisionId: item.decision.id,
                boundEffectDigest: item.effect.binding.boundEffectDigest,
                processedEpoch: item.decision.revocationEpoch,
                normalizedValuesDigest: normalizedValuesDigest(item.decision.normalizedValues),
              },
              {
                effect: {
                  effectKey: item.effect.key,
                  semanticPayloadDigest: item.effect.binding.semanticPayloadDigest,
                  originatingOrigin: origin,
                },
              },
            );
            let rows = 0;
            for (const proposal of item.proposals) {
              const inserted = await c.query(
                `insert into ${NATIVE_TABLE} (tenant_id, effect_key, proposal_digest, target, payload) values ($1, $2, $3, $4, $5::jsonb)
               on conflict do nothing returning effect_key`,
                [
                  TENANT,
                  item.effect.key,
                  proposal.proposalDigest,
                  proposal.target,
                  canonicalJson(proposal as unknown as JsonValue),
                ],
              );
              rows += inserted.rows.length;
            }
            const receipt = await recordExactUseReceipt(c, TENANT, {
              effectKey: item.effect.key,
              outcome: "applied",
              nativeReceiptRef: { table: NATIVE_TABLE, effectKey: item.effect.key, rows: String(rows) },
              processedEpoch: item.decision.revocationEpoch,
              useDecisionId: item.decision.id,
            });
            return { path: admitted.path, receipt, rows };
          },
        );
        result.native.push({
          subject: item.subject,
          decisionId: item.decision.id,
          disposition: item.decision.disposition,
          outcome: "admitted",
          path: applied.path,
          code: null,
          receiptDigest: applied.receipt.digest,
          rows: applied.rows,
        });
      } catch (error) {
        const code =
          error instanceof ExactUseAdmissionError
            ? error.code
            : error instanceof AdmissionInstallationError
              ? error.code
              : null;
        if (code === null) throw error;
        result.native.push({
          subject: item.subject,
          decisionId: item.decision.id,
          disposition: item.decision.disposition,
          outcome: "refused",
          path: error instanceof ExactUseAdmissionError ? error.path : "aidb_guard_required",
          code: error instanceof ExactUseAdmissionError ? `${code}:${error.reason}` : code,
          receiptDigest: null,
          rows: 0,
        });
      }
    }

    // Exact package read: re-load the sealed lineage (verified on load), the exact frozen bytes and every receipt.
    const reread = await binding.loadRunContext(scope, runId);
    const rev = reread.report?.revision;
    if (!rev) throw new Error("exact read: no report");
    const body = await binding.custody.get(scope, rev.body);
    const structured = await binding.custody.get(scope, rev.structuredBody);
    const ledger = await binding.custody.get(scope, rev.ledger);
    const checks: Record<string, boolean> = {
      lineageVerifiedOnLoad: reread.manifests.length >= 1 && reread.head !== null,
      bodyDigest: digestBytes(body) === rev.bodyDigest && rev.body.digest === rev.bodyDigest,
      bodyBytesEqualRegistered: Buffer.compare(Buffer.from(body), Buffer.from(registered.frozen.bytes)) === 0,
      structuredBodyDigest: digestBytes(structured) === rev.structuredBody.digest,
      ledgerDigest: digestBytes(ledger) === rev.ledger.digest,
      reportRefStable: recordRef("report", rev).digest === registered.report.digest,
    };
    const receipts: { effectKey: string; digest: string }[] = [];
    for (const item of decisions) {
      const stored = await binding.loadDecision(scope, item.decision.id);
      checks[`decision:${item.subject}`] =
        stored !== null &&
        recordRef("use_decision", stored.decision).digest === recordRef("use_decision", item.decision).digest;
      const native = result.native.find((n) => n.decisionId === item.decision.id);
      const receipt = await installation.db.transaction(
        { tenantId: TENANT, role: "knowledge_verification_reader", readOnly: true },
        (c) => lookupExactUseReceipt(c, TENANT, item.effect.key),
      );
      checks[`receipt:${item.subject}`] =
        native?.outcome === "admitted" ? receipt?.digest === native.receiptDigest : receipt === null;
      const rows = await installation.db.transaction(
        { tenantId: TENANT, role: "knowledge_verification_reader", readOnly: true },
        (c) =>
          c.query<{ n: string }>(`select count(*)::text n from ${NATIVE_TABLE} where effect_key = $1`, [
            item.effect.key,
          ]),
      );
      checks[`nativeRows:${item.subject}`] =
        Number(rows.rows[0]?.n ?? 0) === (native?.outcome === "admitted" ? item.proposals.length : 0);
      if (receipt) receipts.push({ effectKey: item.effect.key, digest: receipt.digest });
    }
    const ok = Object.values(checks).every(Boolean);
    result.exactRead = {
      ok,
      checks,
      packageDigest: digestCanonical({
        report: recordRef("report", rev).digest,
        body: rev.bodyDigest,
        ledger: rev.ledger.digest,
        head: reread.head,
        decisions: decisions.map((d) => ({ id: d.decision.id, disposition: d.decision.disposition })),
        receipts,
      } as unknown as JsonValue),
    };
  } catch (error) {
    result.errors.push(`${(error as Error).name}: ${(error as Error).message}`);
  }
  return result;
}

function checkT0(chains: readonly ChainResult[], fixtures: LoadedFixtures): { passed: boolean; failures: string[] } {
  const failures: string[] = [];
  for (const chain of chains) {
    const kase = fixtures.cases.find((c) => c.kind === chain.kind) as FixtureCase;
    const expected = kase.labels.t0Expected;
    const at = `${chain.installation}/${chain.kind}`;
    if (chain.errors.length > 0) failures.push(`${at}: errors ${chain.errors.join(" | ")}`);
    if (!chain.registration.ok) failures.push(`${at}: registration ${chain.registration.code}`);
    if (chain.compileIssues.length > 0) failures.push(`${at}: compile issues ${JSON.stringify(chain.compileIssues)}`);
    if (chain.reportDecision?.disposition !== expected.reportDisposition) {
      failures.push(`${at}: report ${chain.reportDecision?.disposition} != ${expected.reportDisposition}`);
    }
    const holds = [...(chain.census?.holds ?? [])].sort().join(",");
    if (holds !== [...expected.censusHolds].sort().join(",")) failures.push(`${at}: census holds ${holds}`);
    for (const [key, disposition] of Object.entries(expected.assertionDispositions)) {
      const got = chain.assertionDecisions.find((d) => d.key === key)?.disposition;
      if (got !== disposition) failures.push(`${at}: assertion ${key} ${got} != ${disposition}`);
    }
    const aidb = chain.installation.includes("ai-engineer");
    const admitted = chain.native.filter((n) => n.outcome === "admitted").length;
    const refused = chain.native.filter((n) => n.outcome === "refused").length;
    if (!aidb) {
      if (admitted !== expected.nativeAdmitted)
        failures.push(`${at}: native admitted ${admitted} != ${expected.nativeAdmitted}`);
      if (refused !== expected.nativeRefused)
        failures.push(`${at}: native refused ${refused} != ${expected.nativeRefused}`);
      if (chain.native.some((n) => n.outcome === "admitted" && n.path !== "component_only"))
        failures.push(`${at}: path not component_only`);
    } else {
      if (admitted !== 0) failures.push(`${at}: ai-engineer installation without the AIDB guard admitted ${admitted}`);
      const guardRefusals = chain.native.filter((n) => n.code === "AIDB_GUARD_REQUIRED").length;
      if (guardRefusals !== expected.nativeAdmitted)
        failures.push(`${at}: AIDB_GUARD_REQUIRED ${guardRefusals} != ${expected.nativeAdmitted}`);
    }
    if (!chain.exactRead?.ok) failures.push(`${at}: exact read ${JSON.stringify(chain.exactRead?.checks)}`);
  }
  return { passed: failures.length === 0, failures };
}

async function main(): Promise<void> {
  const args = parseArgs();
  const runDir = join(PROOFS, args.run);
  mkdirSync(runDir, { recursive: true });
  const fixtures = loadFixtures();
  const harness = harnessDigest();
  writeJson(join(runDir, "analysis-plan.json"), {
    digest: planDigest(),
    plan: ANALYSIS_PLAN,
    writtenAt: new Date().toISOString(),
  });
  writeJson(join(runDir, "environment.json"), {
    mode: args.mode,
    run: args.run,
    node: process.versions.node,
    corpusDigest: fixtures.manifest.corpusDigest,
    harnessDigest: harness,
    harnessFiles: Object.fromEntries(HARNESS_FILES.map((name) => [name, sha(readFileSync(join(here, name)))])),
    database:
      "disposable PostgreSQL 17 (sprint-v-pg17); admin DSN from KNOWLEDGE_DB_CONTRACT_ADMIN_DSN or the documented throwaway default (not printed)",
    startedAt: new Date().toISOString(),
  });
  const calls: CallRecord[] = [];
  let evaluators: Evaluators = { mode: "t0", context: null, pins: null, secondFamily: false };
  let discoveryRecord: unknown = null;
  if (args.mode === "paid") {
    // T0 must have passed with the same corpus and the same harness bytes before any paid call.
    const t0 = readdirSync(PROOFS)
      .map((name) => join(PROOFS, name, "t0-result.json"))
      .filter((path) => existsSync(path))
      .map(
        (path) =>
          JSON.parse(readFileSync(path, "utf8")) as { passed: boolean; corpusDigest: string; harnessDigest: string },
      )
      .find(
        (entry) =>
          entry.passed && entry.corpusDigest === fixtures.manifest.corpusDigest && entry.harnessDigest === harness,
      );
    if (!t0) throw new Error("T0_REQUIRED: no passing T0 run for this corpus and harness digest");
    if (!args.envFile) throw new Error("ENV_FILE_REQUIRED: pass --env-file <path to the MC repository .env>");
    const credentials = new Credentials(args.envFile, ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"]);
    const discovery = await discover(credentials);
    const pins = pin(discovery);
    discoveryRecord = { discovery, pins };
    writeJson(join(runDir, "discovery.json"), discoveryRecord);
    if ("blocked" in pins) throw new Error(`ROUTE_BLOCKED: ${pins.blocked}`);
    if (process.argv.includes("--discover-only")) {
      process.stdout.write(`discovery written; pins ${JSON.stringify(pins)}
`);
      return;
    }
    const meter = new Meter(PROOFS, runDir, args.run);
    evaluators = {
      mode: "paid",
      context: { credentials, meter, callsDir: join(runDir, "calls"), records: calls },
      pins,
      secondFamily: args.secondFamily,
    };
  }
  const tag = `${args.mode}_${randomBytes(3).toString("hex")}`;
  const chains: ChainResult[] = [];
  const installations =
    args.mode === "t0"
      ? [
          { name: "component", applicationId: "sv09-harness" },
          { name: "aiengineer", applicationId: "ai-engineer" },
        ]
      : [{ name: "component", applicationId: "sv09-harness" }];
  for (const spec of installations) {
    const installation = await createInstallation(spec.name, spec.applicationId, tag);
    try {
      const chainKinds: ChainResult["chain"][] = args.mode === "t0" ? ["t0"] : args.chains;
      for (const chain of chainKinds) {
        for (const kase of fixtures.cases) {
          const clock = args.mode === "t0" ? tickClock() : systemClock;
          const result = await runChain({ chain, kase, fixtures, installation, evaluators, runDir, clock });
          chains.push(result);
          process.stdout.write(
            `${spec.name}/${chain}/${kase.kind}: registered=${result.registration.ok} report=${result.reportDecision?.disposition ?? "-"} census=${(result.census?.holds ?? []).join("+") || "none"} native=${result.native.map((n) => `${n.outcome}${n.code ? `(${n.code.split(":")[0]})` : ""}`).join(",")} exactRead=${result.exactRead?.ok ?? "-"} errors=${result.errors.length}\n`,
          );
        }
      }
    } finally {
      await dropInstallation(installation, runDir);
    }
  }
  writeJson(join(runDir, "results.json"), chains);
  writeJson(join(runDir, "calls.json"), calls);
  const labels = Object.fromEntries(fixtures.cases.map((c) => [c.kind, c.labels])) as Record<
    KindId,
    FixtureCase["labels"]
  >;
  const analysis = computeAnalysis({ chains, labels, calls });
  writeJson(join(runDir, "analysis.json"), analysis);
  if (args.mode === "t0") {
    const verdict = checkT0(chains, fixtures);
    writeJson(join(runDir, "t0-result.json"), {
      ...verdict,
      corpusDigest: fixtures.manifest.corpusDigest,
      harnessDigest: harness,
      at: new Date().toISOString(),
    });
    process.stdout.write(
      `T0 ${verdict.passed ? "PASSED" : "FAILED"}${verdict.failures.length ? `\n${verdict.failures.join("\n")}` : ""}\n`,
    );
    if (!verdict.passed) process.exitCode = 1;
  } else {
    process.stdout.write(`paid run spend ${analysis.spend.totalUsd.toFixed(6)} USD over ${calls.length} call(s)\n`);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
  process.exitCode = 2;
});
