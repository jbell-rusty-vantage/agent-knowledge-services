import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  JUDGMENT_POLICIES_SCHEMA_VERSION,
  type JudgmentPolicyRegistry,
  type RiskClass,
  SOURCE_AUTHORITY_SCHEMA_VERSION,
  type SourceAuthorityRules,
  USE_CLASSES_SCHEMA_VERSION,
  type UseClassRegistry,
  type UseClassResolution,
  loadJudgmentPolicyRegistry,
  loadSourceAuthorityRules,
  loadUseClassRegistry,
  useClassOf,
} from "@aiengineer/knowledge-research-core";

/**
 * The pinned K08 source-authority catalogue an installation serves (`catalog/research/source-authority/*.json`):
 * one rules document per qualifier profile, plus the use-class registry (`catalog/research/use-classes.json`, the
 * sibling of the directory by default; the same document the ingestion executor's use-class policy loads). Pure data;
 * no code branch per domain.
 */
export class SourceAuthorityCatalog {
  private readonly rules: ReadonlyMap<string, SourceAuthorityRules>;

  constructor(
    rules: readonly SourceAuthorityRules[],
    readonly useClasses: UseClassRegistry | null,
    /** K08 judgment policies (WI-03); `null` keeps every non-entailed assertion out of official coverage (OQ4). */
    readonly judgmentPolicies: JudgmentPolicyRegistry | null = null,
  ) {
    const byProfile = new Map<string, SourceAuthorityRules>();
    for (const document of rules) {
      if (byProfile.has(document.profile)) throw new Error(`SOURCE_AUTHORITY_DUPLICATE: ${document.profile}`);
      byProfile.set(document.profile, document);
    }
    this.rules = byProfile;
  }

  static fromDirectory(
    directory: string,
    useClassesFile: string | null = resolve(directory, "..", "use-classes.json"),
    judgmentPoliciesFile: string | null = resolve(directory, "..", "judgment-policies.json"),
  ): SourceAuthorityCatalog {
    const rules: SourceAuthorityRules[] = [];
    for (const name of readdirSync(directory)
      .filter((file) => file.endsWith(".json"))
      .sort()) {
      const json = JSON.parse(readFileSync(resolve(directory, name), "utf8")) as { schemaVersion?: unknown };
      if (json.schemaVersion === SOURCE_AUTHORITY_SCHEMA_VERSION) rules.push(loadSourceAuthorityRules(json));
      else throw new Error(`SCHEMA_UNSUPPORTED: ${name}`);
    }
    const useClasses =
      useClassesFile !== null && existsSync(useClassesFile) ? loadUseClassesFile(useClassesFile) : null;
    const judgmentPolicies =
      judgmentPoliciesFile !== null && existsSync(judgmentPoliciesFile)
        ? loadJudgmentPoliciesFile(judgmentPoliciesFile)
        : null;
    return new SourceAuthorityCatalog(rules, useClasses, judgmentPolicies);
  }

  rulesFor(profile: string): SourceAuthorityRules | null {
    return this.rules.get(profile) ?? null;
  }

  useClass(input: { use: string; audience: string; risk: RiskClass }): UseClassResolution {
    return useClassOf(this.useClasses, input);
  }
}

/** Load the K08 use-class registry document (`catalog/research/use-classes.json`); refuses any other schema. */
export function loadUseClassesFile(file: string): UseClassRegistry {
  const json = JSON.parse(readFileSync(file, "utf8")) as { schemaVersion?: unknown };
  if (json.schemaVersion !== USE_CLASSES_SCHEMA_VERSION) throw new Error(`SCHEMA_UNSUPPORTED: ${file}`);
  return loadUseClassRegistry(json);
}

/** Load the K08 judgment-policy registry (`catalog/research/judgment-policies.json`); refuses any other schema. */
export function loadJudgmentPoliciesFile(file: string): JudgmentPolicyRegistry {
  const json = JSON.parse(readFileSync(file, "utf8")) as { schemaVersion?: unknown };
  if (json.schemaVersion !== JUDGMENT_POLICIES_SCHEMA_VERSION) throw new Error(`SCHEMA_UNSUPPORTED: ${file}`);
  return loadJudgmentPolicyRegistry(json);
}
