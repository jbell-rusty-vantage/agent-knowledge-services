#!/usr/bin/env node
/**
 * Writes src/operations/guide-pages.generated.ts: every file of every skill, and the jobs of skills/manifest.json.
 * `guide` serves these pages (the MCP tool knowledge_guide, GET /v1/guide and `ks guide`), so a deployed server
 * answers without the skills directory and an agent with no filesystem reads the same files a sandboxed agent has.
 *
 * Sources: skills/manifest.json (the skill catalog and `guide.jobs`) and the skill shipped with the executor
 * (apps/verification-executor/skills/manifest.json entries whose path stays inside that directory). Text is stored
 * with LF line endings whatever the checkout uses.
 *
 *   node scripts/generate-guide-pages.mjs           # rewrite the module
 *   node scripts/generate-guide-pages.mjs --check   # exit 1 when the module is out of date
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageRoot, "../..");
const skillsRoot = join(repoRoot, "skills");
const executorSkillsRoot = join(repoRoot, "apps/verification-executor/skills");
const target = join(packageRoot, "src/operations/guide-pages.generated.ts");
const manifestPath = join(skillsRoot, "manifest.json");

if (!existsSync(manifestPath)) {
  // A build context without the skills directory keeps the committed module.
  console.warn("skills/manifest.json not found; keeping the committed guide pages");
  process.exit(0);
}

const TEXT_FILE = /\.(md|mjs|js|json|txt|ya?ml)$/u;
const read = (path) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

/** Every text file under `directory`, as sorted paths relative to it, SKILL.md first. */
function filesOf(directory) {
  const found = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (TEXT_FILE.test(entry.name)) found.push(relative(directory, path).split("\\").join("/"));
    }
  };
  walk(directory);
  return found.sort((left, right) =>
    left === "SKILL.md" ? -1 : right === "SKILL.md" ? 1 : left < right ? -1 : left > right ? 1 : 0,
  );
}

/** The `description` scalar of a SKILL.md frontmatter block: plain, quoted or folded (`>-`, `|`). */
function description(markdown, id) {
  const block = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(markdown);
  if (!block) throw new Error(`${id}: SKILL.md has no YAML frontmatter`);
  const lines = block[1].split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const top = /^description:(?:[ \t]+(.*))?$/.exec(lines[index]);
    if (!top) continue;
    let value = (top[1] ?? "").trim();
    if (value === "" || /^[>|][+-]?$/.test(value)) {
      const continuation = [];
      while (index + 1 < lines.length && /^(?:[ \t]+\S|[ \t]*$)/.test(lines[index + 1]))
        continuation.push(lines[++index].trim());
      value = continuation.filter(Boolean).join(" ");
    }
    value = value.replace(/^(["'])([\s\S]*)\1$/, "$2").trim();
    if (value) return value;
  }
  throw new Error(`${id}: SKILL.md frontmatter has no description`);
}

const manifest = JSON.parse(read(manifestPath));
const executorManifest = existsSync(join(executorSkillsRoot, "manifest.json"))
  ? JSON.parse(read(join(executorSkillsRoot, "manifest.json")))
  : { skills: [] };

const sources = [
  ...manifest.skills.map((skill) => ({ skill, home: "catalog", directory: join(skillsRoot, skill.id) })),
  // The executor manifest also points at catalog skills (`../../../skills/...`); only its own skills are added.
  ...executorManifest.skills
    .filter((skill) => !skill.path.startsWith(".."))
    .map((skill) => ({ skill, home: "executor", directory: join(executorSkillsRoot, skill.id) })),
];

const skills = [];
const files = {};
for (const { skill, home, directory } of sources) {
  if (skills.some((item) => item.name === skill.id)) throw new Error(`${skill.id}: declared by two manifests`);
  const paths = filesOf(directory);
  if (paths[0] !== "SKILL.md") throw new Error(`${skill.id}: SKILL.md missing`);
  for (const path of paths) files[`${skill.id}/${path}`] = read(join(directory, path));
  skills.push({
    name: skill.id,
    version: skill.version,
    description: description(files[`${skill.id}/SKILL.md`], skill.id),
    home,
    files: paths,
  });
}

const guide = manifest.guide;
if (!guide || !Array.isArray(guide.jobs)) throw new Error("skills/manifest.json has no guide.jobs");
const names = (value) => (Array.isArray(value) ? value : []);
const jobs = guide.jobs.map((job) => {
  for (const name of names(job.skills))
    if (!skills.some((skill) => skill.name === name)) throw new Error(`guide job ${job.id}: unknown skill ${name}`);
  return { id: job.id, skills: names(job.skills), executor: names(job.executor), jev: names(job.jev) };
});
const unassigned = { executor: names(guide.unassigned?.executor), reason: guide.unassigned?.reason ?? "" };

const source = `// GENERATED by scripts/generate-guide-pages.mjs from skills/ and the skill shipped with the executor.
// Do not edit: change the skill or skills/manifest.json, then run
// \`corepack pnpm --filter @aiengineer/knowledge-contracts generate\`.

/** One skill whose files the guide serves. */
export interface GuideSkillEntry {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  /** \`catalog\` for a skill of skills/, \`executor\` for the skill shipped with the executor. */
  readonly home: "catalog" | "executor";
  /** The files of the skill, relative to its directory, SKILL.md first. */
  readonly files: readonly string[];
}

/** One job of skills/manifest.json \`guide.jobs\`: the skills to read and the tools the other servers hold for it. */
export interface GuideJobEntry {
  readonly id: string;
  readonly skills: readonly string[];
  /** Tools of the executor server. */
  readonly executor: readonly string[];
  /** Tools of the Jev server. */
  readonly jev: readonly string[];
}

export const GUIDE_SKILLS: readonly GuideSkillEntry[] = ${JSON.stringify(skills, null, 2)};

export const GUIDE_JOBS: readonly GuideJobEntry[] = ${JSON.stringify(jobs, null, 2)};

/** Executor tools that belong to no job, and why. */
export const GUIDE_UNASSIGNED: { readonly executor: readonly string[]; readonly reason: string } = ${JSON.stringify(unassigned, null, 2)};

/** The text of every skill file, by \`<skill>/<path>\`. */
export const GUIDE_FILES: Readonly<Record<string, string>> = ${JSON.stringify(files, null, 2)};
`;

if (process.argv.includes("--check")) {
  const current = existsSync(target) ? read(target) : "";
  if (current !== source) {
    console.error("guide pages are out of date; run the contracts generator");
    process.exit(1);
  }
} else if (!existsSync(target) || read(target) !== source) {
  writeFileSync(target, source);
}
