import { type JsonValue, type Ref, digestCanonical } from "@aiengineer/knowledge-operation-protocol";
import {
  type AssertionVersion,
  type AuthScope,
  type AuthorityOutcome,
  type EvidenceFragment,
  OBSERVATION_SCHEMA_VERSION,
  type SourceDescription,
  type SupportSet,
  type VerificationObservation,
  VerificationObservationSchema,
  appraiseSource,
  qualifiersDigest,
  recordRef,
  rulesDigest,
} from "@aiengineer/knowledge-research-core";
import type { Clock } from "./coordinator.js";
import { ResearchCoordinatorError } from "./coordinator.js";
import type {
  CounterevidenceSearch,
  ResearchBinding,
  RevisionFrontier,
  RevisionStatus,
  RunContext,
  SourceAuthorityResolver,
} from "./ports.js";
import type { SourceAuthorityCatalog } from "./source-authority.js";

/**
 * SV-07 authority and bounded challenge (design §3.1 judgments 2 and 3). Both steps append observations to an open
 * run; neither decides use. Aggregation gates on them (critical risk, or scientific + official/consequential use).
 *
 * - `recordAuthority`: per support set, the proposed vs verified origin families (three reports of one study = one
 *   verified family; unknown stays unknown), fitness and applicability by the profile's pinned K08 rules, and the
 *   revision frontier checked on demand through a `RevisionFrontier` port (Crossref adapter; never a live feed).
 * - `recordChallenge`: per assertion, a bounded counterevidence search recording its exact queries, limits and what
 *   was not searched; contrary fragments are registered and retained by the support algebra; `materialConflict` holds.
 */
const FITNESS_ORDER = ["unfit", "unknown", "fit_with_limitations", "fit"] as const;
const APPLICABILITY_ORDER = ["not_applicable", "unknown", "partially_applicable", "applicable"] as const;
const DIRECTNESS_ORDER = ["unknown", "indirect", "direct"] as const;
const FRESHNESS_ORDER = ["superseded", "unknown", "stale", "current"] as const;
const REVISION_ORDER: readonly RevisionStatus[] = ["retracted", "withdrawn", "unknown", "corrected", "current"];

const rank = <T extends string>(order: readonly T[], value: T) => order.indexOf(value);
const worst = <T extends string>(order: readonly T[], values: readonly T[], empty: T): T =>
  values.length === 0 ? empty : values.reduce((acc, value) => (rank(order, value) < rank(order, acc) ? value : acc));
const best = <T extends string>(order: readonly T[], values: readonly T[], empty: T): T =>
  values.length === 0 ? empty : values.reduce((acc, value) => (rank(order, value) > rank(order, acc) ? value : acc));

export class AuthorityChallengeService {
  constructor(
    private readonly binding: ResearchBinding,
    private readonly clock: Clock,
    private readonly catalog: SourceAuthorityCatalog,
  ) {}

  private async openContext(scope: AuthScope, runId: string): Promise<RunContext> {
    const context = await this.binding.loadRunContext(scope, runId);
    if (context.state === "sealed" || context.state === "superseded") {
      throw new ResearchCoordinatorError("RUN_ALREADY_SEALED", "authority and challenge observe an open run");
    }
    return context;
  }

  async recordAuthority(
    scope: AuthScope,
    input: { runId: string; resolver: SourceAuthorityResolver; frontier?: RevisionFrontier | null },
  ): Promise<Ref<"observation">[]> {
    const context = await this.openContext(scope, input.runId);
    const refs: Ref<"observation">[] = [];
    for (const set of context.supportSets) {
      const assertion = context.assertions.find(
        (candidate) => recordRef("assertion", candidate).digest === set.assertion.digest,
      );
      if (assertion === undefined || set.qualifiersDigest !== qualifiersDigest(assertion.qualifiers)) continue;
      const rules = this.catalog.rulesFor(assertion.qualifiers.profile);
      if (rules === null) {
        throw new ResearchCoordinatorError(
          "SCHEMA_UNSUPPORTED",
          `no source authority rules for ${assertion.qualifiers.profile}`,
        );
      }
      const observation = await this.authorityFor(scope, { set, assertion, rules, ...input });
      refs.push(await this.binding.appendObservation(scope, input.runId, observation));
    }
    return refs;
  }

  private async authorityFor(
    scope: AuthScope,
    input: {
      set: SupportSet;
      assertion: AssertionVersion;
      rules: NonNullable<ReturnType<SourceAuthorityCatalog["rulesFor"]>>;
      resolver: SourceAuthorityResolver;
      frontier?: RevisionFrontier | null;
    },
  ): Promise<VerificationObservation> {
    const premiseRefs = input.set.required.map((premise) => premise.evidence);
    const fragments = await this.binding.loadFragments(scope, premiseRefs.flat());
    const described = new Map<string, { fragment: EvidenceFragment; description: SourceDescription }>();
    for (const fragment of fragments) {
      described.set(recordRef("fragment", fragment).digest, {
        fragment,
        description: await input.resolver.describe(scope, fragment),
      });
    }
    const missing = premiseRefs.flat().filter((ref) => !described.has(ref.digest));
    // Per premise the best-supported fragment counts; across the conjunctive premises the weakest premise decides.
    const premiseAppraisals = premiseRefs.map((refs) =>
      refs.flatMap((ref) => {
        const entry = described.get(ref.digest);
        return entry === undefined
          ? []
          : [{ ...entry, appraisal: appraiseSource(input.rules, input.assertion, entry.description) }];
      }),
    );
    const per = <T extends string>(
      order: readonly T[],
      pick: (entry: (typeof premiseAppraisals)[number][number]) => T,
      empty: T,
    ) =>
      worst(
        order,
        premiseAppraisals.map((entries) => best(order, entries.map(pick), empty)),
        empty,
      );
    const fitness = per(FITNESS_ORDER, (entry) => entry.appraisal.fitness, "unknown");
    const applicability = per(APPLICABILITY_ORDER, (entry) => entry.appraisal.applicability, "unknown");
    const directness = per(DIRECTNESS_ORDER, (entry) => entry.description.directness, "unknown");
    const freshness = per(FRESHNESS_ORDER, (entry) => entry.description.freshness, "unknown");
    const fitnessRule =
      premiseAppraisals.flat().find((entry) => entry.appraisal.fitness === fitness)?.appraisal.fitnessRule ?? null;

    // Origin families: grouped by VERIFIED family; an unverified fragment stays its own unknown entry.
    const families = new Map<string, { family: string | null; proposed: Set<string>; fragments: Ref<"fragment">[] }>();
    for (const { fragment, description } of described.values()) {
      const key = description.verifiedOriginFamily ?? `unknown:${fragment.id}`;
      const entry = families.get(key) ?? {
        family: description.verifiedOriginFamily,
        proposed: new Set(),
        fragments: [],
      };
      if (fragment.originFamily !== null) entry.proposed.add(fragment.originFamily);
      entry.fragments.push(recordRef("fragment", fragment));
      families.set(key, entry);
    }
    const unknownOriginFrontier = [
      ...[...described.values()]
        .filter((entry) => entry.description.verifiedOriginFamily === null)
        .map((entry) => `origin family unverified: ${entry.fragment.id}`),
      ...missing.map((ref) => `fragment not in custody: ${ref.id}`),
    ];

    // Revision frontier, on demand only (never a live feed).
    const checked: { identifier: string; status: RevisionStatus; noticeIdentifiers: string[] }[] = [];
    const unchecked: string[] = [];
    for (const { fragment, description } of described.values()) {
      if (description.doi === null) {
        unchecked.push(`no scholarly identifier: ${fragment.id}`);
        continue;
      }
      if (!input.frontier) {
        unchecked.push(`frontier not consulted: ${description.doi}`);
        continue;
      }
      const result = await input.frontier.check(scope, description.doi);
      checked.push({ identifier: description.doi, status: result.status, noticeIdentifiers: [...result.notices] });
    }
    const statuses = checked.map((entry) => entry.status);
    const revisionStatus: RevisionStatus =
      unchecked.length > 0 && input.rules.revisionFrontierRequired
        ? worst(REVISION_ORDER, [...statuses, "unknown"], "unknown")
        : worst(REVISION_ORDER, statuses, input.rules.revisionFrontierRequired ? "unknown" : "current");
    const verifiedFamilies = new Set(
      [...families.values()].flatMap((entry) => (entry.family === null ? [] : [entry.family])),
    );
    const outcome: AuthorityOutcome = {
      originFamilies: [...families.values()]
        .map((entry) => ({ family: entry.family, proposed: [...entry.proposed].sort(), fragments: entry.fragments }))
        .sort((a, b) => ((a.family ?? "~") < (b.family ?? "~") ? -1 : 1)),
      distinctOrigins: verifiedFamilies.size,
      unknownOriginFrontier,
      applicability,
      directness,
      freshness,
      fitness,
      fitnessRule,
      rules: { id: input.rules.id, version: input.rules.version, digest: rulesDigest(input.rules) },
      revisionFrontier: {
        status: revisionStatus,
        checkedAt: checked.length > 0 ? this.clock.now() : null,
        notices: [],
        checked,
        unchecked,
      },
    };
    const setRef = recordRef("support_set", input.set);
    const inputDigest = digestCanonical({
      set: setRef.digest,
      rules: outcome.rules.digest,
      sources: [...described.entries()].map(([digest, entry]) => ({ digest, description: entry.description })),
    } as unknown as JsonValue);
    return VerificationObservationSchema.parse({
      schemaVersion: OBSERVATION_SCHEMA_VERSION,
      id: `authority-${input.set.id}-${inputDigest.slice(7, 23)}`,
      tenant: scope.tenant,
      binding: scope.binding,
      target: setRef,
      inputDigest,
      qualifiersDigest: qualifiersDigest(input.assertion.qualifiers),
      method: input.resolver.method,
      evaluator: input.resolver.evaluator,
      rationale: `source authority by ${input.rules.id}@${input.rules.version}: fitness ${fitness}, applicability ${applicability}, revision ${revisionStatus}`,
      limitations: [...unknownOriginFrontier, ...unchecked].slice(0, 50),
      evidence: [...described.values()].map((entry) => recordRef("fragment", entry.fragment)),
      rawResponse: null,
      usage: { providerCalls: 0, tokens: 0, costUsd: "0" },
      recordedAt: this.clock.now(),
      property: "authority",
      outcome,
    });
  }

  async recordChallenge(
    scope: AuthScope,
    input: { runId: string; search: CounterevidenceSearch; maxQueries?: number },
  ): Promise<Ref<"observation">[]> {
    const context = await this.openContext(scope, input.runId);
    const maxQueries = Math.max(1, Math.min(input.maxQueries ?? 3, context.task.limits.calls));
    const refs: Ref<"observation">[] = [];
    for (const assertion of context.assertions) {
      const result = await input.search.search(scope, { task: context.task, assertion, maxQueries });
      if (result.status === "searched" && result.queries.length > maxQueries) {
        throw new ResearchCoordinatorError("SCHEMA_UNSUPPORTED", `search exceeded its bound of ${maxQueries} queries`);
      }
      for (const fragment of result.counterevidence) await this.binding.putFragment(scope, fragment);
      const counterevidence = result.counterevidence.map((fragment) => recordRef("fragment", fragment));
      const outcome =
        result.status === "not_searched"
          ? { status: "not_searched" as const, reason: result.reason ?? "search not run" }
          : {
              status: "searched" as const,
              queries: [...result.queries],
              counterevidence,
              materialConflict: result.materialConflict,
              frontier: {
                exhausted: result.frontier.exhausted,
                searchedScopes: [...result.frontier.searchedScopes],
                limits: [...result.frontier.limits, `max ${maxQueries} queries`],
                unsearchedScopes: [...result.frontier.unsearchedScopes],
              },
            };
      const assertionRef = recordRef("assertion", assertion);
      const inputDigest = digestCanonical({ assertion: assertionRef.digest, outcome } as unknown as JsonValue);
      const observation = VerificationObservationSchema.parse({
        schemaVersion: OBSERVATION_SCHEMA_VERSION,
        id: `challenge-${assertion.id}-${inputDigest.slice(7, 23)}`,
        tenant: scope.tenant,
        binding: scope.binding,
        target: assertionRef,
        inputDigest,
        qualifiersDigest: qualifiersDigest(assertion.qualifiers),
        method: input.search.method,
        evaluator: input.search.evaluator,
        rationale: result.rationale,
        limitations:
          outcome.status === "searched"
            ? [...outcome.frontier.unsearchedScopes.map((s) => `not searched: ${s}`)]
            : [outcome.reason],
        evidence: counterevidence,
        rawResponse: null,
        usage: result.usage,
        recordedAt: this.clock.now(),
        property: "challenge",
        outcome,
      });
      refs.push(await this.binding.appendObservation(scope, input.runId, observation));
    }
    return refs;
  }
}
