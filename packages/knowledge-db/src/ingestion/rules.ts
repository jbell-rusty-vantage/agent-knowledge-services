import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { sha256Hex } from "../db-read/index.js";
import { WORKSPACE_FILES, type Workspace } from "../schema-workspace/index.js";
import type { Proposal } from "./intent.js";
import { priceSlotAliases } from "./temporal.js";

/**
 * Ingestion rules are data (`workspace/rules/ingestion-rules.v1.json`). A rule matches a
 * proposal by kind and vocabulary codes and applies one action: `rewrite` (fill fields),
 * `reject`, `hold`, `stage` (route to review), or `note`.
 *
 * Two authoring shapes are accepted: the executor's machine shape (`when` + `set`) and the
 * db-contract renderer's shape (`applies_to` + `detail`). A reject/hold/stage rule without a
 * machine-checkable condition is demoted to `note` so prose rules never blanket-reject a kind.
 * A rewrite whose id names a built-in rewriter is executed by that rewriter, which may consult
 * the current head (`RuleFacts`); any other rewrite fills fields from `set`.
 * Absent or unrecognized files run with zero rules, and the plan says so.
 */
const Selector = z.union([z.string(), z.array(z.string())]).optional();
const RuleSchema = z.looseObject({
  id: z.string().min(1),
  basis: z.enum(["enforced", "curated", "vocabulary"]).default("curated"),
  action: z.enum(["rewrite", "reject", "hold", "stage", "note"]),
  when: z
    .looseObject({
      kind: Selector,
      streamKind: Selector,
      relationshipKind: Selector,
      eventKind: Selector,
      missing: z.array(z.string()).default([]),
      equals: z.record(z.string(), z.unknown()).default({}),
    })
    .optional(),
  applies_to: z
    .looseObject({ proposal_kind: Selector, stream_kind: Selector, relationship_kind: Selector, event_kind: Selector })
    .optional(),
  set: z.record(z.string(), z.unknown()).optional(),
  note: z.string().optional(),
  message: z.string().optional(),
  title: z.string().optional(),
  detail: z.string().optional(),
});
type RawRule = z.infer<typeof RuleSchema>;

export interface RuleCondition {
  readonly kind?: readonly string[];
  readonly streamKind?: readonly string[];
  readonly relationshipKind?: readonly string[];
  readonly eventKind?: readonly string[];
  readonly missing: readonly string[];
  readonly equals: Readonly<Record<string, unknown>>;
}
export interface IngestionRule {
  readonly id: string;
  readonly basis: "enforced" | "curated" | "vocabulary";
  readonly action: "rewrite" | "reject" | "hold" | "stage" | "note";
  readonly when: RuleCondition;
  readonly set: Readonly<Record<string, unknown>>;
  readonly message: string | undefined;
  readonly demoted: boolean;
}

const RulesFileSchema = z.looseObject({
  schemaVersion: z.literal("ingestion-rules.v1").optional(),
  migrationHead: z.string().optional(),
  rules: z.array(RuleSchema),
});

/** What a rewrite rule may consult about the current head for one proposal. */
export interface RuleFacts {
  /** The `scope_key` under which the subject already has a current series of the proposal's stream kind and unit. */
  readonly existingSeriesKey?: string;
}

export interface Rewrite {
  readonly rule: string;
  readonly field: string;
  readonly from: unknown;
  readonly to: unknown;
  readonly reason?: string;
}
type FieldRewrite = Omit<Rewrite, "rule" | "from">;
type Rewriter = (proposal: Proposal, facts: RuleFacts) => readonly FieldRewrite[];

const EXISTING_SERIES_REUSED = "existing_series_reused";
const field = (proposal: Proposal, name: string): unknown => (proposal as unknown as Record<string, unknown>)[name];

/** A new series defaults `scopeKey` to the unit; an existing series for the same subject, stream kind, and unit keeps its key. */
const scopeKeyOfUnitSeries: Rewriter = (proposal, facts) => {
  const given = field(proposal, "scopeKey");
  const unit = field(proposal, "unit");
  if (
    typeof given === "string" &&
    given !== "" &&
    (typeof unit !== "string" || !priceSlotAliases(unit).includes(given))
  )
    return [];
  if (facts.existingSeriesKey !== undefined)
    return given === facts.existingSeriesKey
      ? []
      : [{ field: "scopeKey", to: facts.existingSeriesKey, reason: EXISTING_SERIES_REUSED }];
  return given === undefined ? [{ field: "scopeKey", to: field(proposal, "unit") }] : [];
};

/** Rules whose semantics the executor implements; they decide when to rewrite, so `when.missing` and `set` authored under the same id are ignored. */
const BUILTIN_REWRITERS: Readonly<Record<string, Rewriter>> = {
  "price.scope_key_is_unit": scopeKeyOfUnitSeries,
};

/** `$field` in a `set` value copies another field of the same proposal. */
const substitute = (proposal: Proposal, value: unknown): unknown =>
  typeof value === "string" && value.startsWith("$") ? field(proposal, value.slice(1)) : value;

const setRewriter =
  (set: Readonly<Record<string, unknown>>): Rewriter =>
  (proposal) =>
    Object.entries(set).map(([name, raw]) => ({ field: name, to: substitute(proposal, raw) }));

function rewriterOf(rule: Pick<IngestionRule, "id" | "set">): Rewriter | undefined {
  const builtin = BUILTIN_REWRITERS[rule.id];
  if (builtin) return builtin;
  return Object.keys(rule.set).length > 0 ? setRewriter(rule.set) : undefined;
}

export interface RuleSet {
  readonly rulesVersion: string;
  readonly loaded: boolean;
  readonly note?: string;
  readonly rules: readonly IngestionRule[];
}

export const NO_RULES: RuleSet = {
  rulesVersion: "ingestion-rules.v1@none",
  loaded: false,
  note: "rules file absent; zero rules applied",
  rules: [],
};

const asList = (value: string | string[] | undefined): string[] | undefined =>
  value === undefined ? undefined : Array.isArray(value) ? value : [value];

function normalize(raw: RawRule): IngestionRule {
  const builtin = raw.action === "rewrite" && BUILTIN_REWRITERS[raw.id] !== undefined;
  const when: RuleCondition = {
    ...pick(asList(raw.when?.kind ?? raw.applies_to?.proposal_kind), "kind"),
    ...pick(asList(raw.when?.streamKind ?? raw.applies_to?.stream_kind), "streamKind"),
    ...pick(asList(raw.when?.relationshipKind ?? raw.applies_to?.relationship_kind), "relationshipKind"),
    ...pick(asList(raw.when?.eventKind ?? raw.applies_to?.event_kind), "eventKind"),
    missing: builtin ? [] : (raw.when?.missing ?? []),
    equals: raw.when?.equals ?? {},
  };
  const set = raw.set ?? {};
  const conditional = when.missing.length > 0 || Object.keys(when.equals).length > 0;
  const machineEvaluable =
    raw.action === "note" || (raw.action === "rewrite" ? rewriterOf({ id: raw.id, set }) !== undefined : conditional);
  const message = raw.message ?? raw.note ?? raw.title ?? raw.detail?.split("\n")[0];
  return {
    id: raw.id,
    basis: raw.basis,
    action: machineEvaluable ? raw.action : "note",
    when,
    set,
    message: machineEvaluable
      ? message
      : `${message ?? raw.id} (documented rule; not machine-evaluated by this executor)`,
    demoted: !machineEvaluable,
  };
}

const pick = <K extends string>(value: string[] | undefined, key: K): Partial<Record<K, string[]>> =>
  (value === undefined ? {} : { [key]: value }) as Partial<Record<K, string[]>>;

export function loadRules(workspace: Workspace): RuleSet {
  const path = join(workspace.dir, WORKSPACE_FILES.rules);
  if (!existsSync(path)) return NO_RULES;
  const text = readFileSync(path, "utf8");
  const parsed = RulesFileSchema.safeParse(safeJson(text));
  const published = (workspace.manifest.build as { rules_version?: string }).rules_version;
  const rulesVersion = published ?? `ingestion-rules.v1@sha256:${sha256Hex(text)}`;
  if (!parsed.success)
    return {
      rulesVersion,
      loaded: false,
      note: "rules file present but not in ingestion-rules.v1 shape; zero rules applied",
      rules: [],
    };
  const rules = parsed.data.rules.map(normalize);
  const demoted = rules.filter((rule) => rule.demoted).length;
  return {
    rulesVersion,
    loaded: true,
    rules,
    ...(demoted
      ? {
          note: `${demoted} prose rule(s) recorded as notes; they are enforced by the database or validator, not re-evaluated here`,
        }
      : {}),
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export interface RuleCheck {
  readonly rule: string;
  readonly basis: IngestionRule["basis"];
  readonly result: "pass" | "rewrite" | "reject" | "hold" | "stage" | "note";
  readonly proposalId: string;
  readonly message?: string;
}
export interface RuleApplication {
  readonly proposal: Proposal;
  readonly rewrites: readonly Rewrite[];
  readonly checks: readonly RuleCheck[];
  readonly verdict: "admit" | "reject" | "hold" | "stage";
}

function matches(rule: IngestionRule, proposal: Proposal): boolean {
  const { when } = rule;
  if (when.kind && !when.kind.includes(proposal.kind)) return false;
  if (when.streamKind && !when.streamKind.includes(String(field(proposal, "streamKind")))) return false;
  if (when.relationshipKind && !when.relationshipKind.includes(String(field(proposal, "relationshipKind"))))
    return false;
  if (when.eventKind && !when.eventKind.includes(String(field(proposal, "eventKind")))) return false;
  if (when.missing.some((name) => field(proposal, name) !== undefined)) return false;
  return Object.entries(when.equals).every(([name, expected]) => field(proposal, name) === expected);
}

/** A rewrite rule that matches but changes nothing leaves no trace, so an already-correct proposal plans identically with or without the rule. */
export function applyRules(rules: RuleSet, proposal: Proposal, facts: RuleFacts = {}): RuleApplication {
  let current = proposal;
  const rewrites: Rewrite[] = [];
  const checks: RuleCheck[] = [];
  let verdict: RuleApplication["verdict"] = "admit";
  for (const rule of rules.rules) {
    if (!matches(rule, current)) continue;
    const check = (result: RuleCheck["result"]): RuleCheck => ({
      rule: rule.id,
      basis: rule.basis,
      result,
      proposalId: proposal.proposalId,
      ...(rule.message ? { message: rule.message } : {}),
    });
    switch (rule.action) {
      case "rewrite": {
        const fieldRewrites = rewriterOf(rule)?.(current, facts) ?? [];
        for (const rewrite of fieldRewrites) {
          rewrites.push({
            rule: rule.id,
            field: rewrite.field,
            from: field(current, rewrite.field) ?? null,
            to: rewrite.to ?? null,
            ...(rewrite.reason ? { reason: rewrite.reason } : {}),
          });
          current = { ...current, [rewrite.field]: rewrite.to } as Proposal;
        }
        if (fieldRewrites.length > 0) checks.push(check("rewrite"));
        break;
      }
      case "reject":
        verdict = "reject";
        checks.push(check("reject"));
        break;
      case "hold":
        if (verdict === "admit") verdict = "hold";
        checks.push(check("hold"));
        break;
      case "stage":
        if (verdict === "admit") verdict = "stage";
        checks.push(check("stage"));
        break;
      case "note":
        checks.push(check("note"));
        break;
    }
  }
  return { proposal: current, rewrites, checks, verdict };
}
