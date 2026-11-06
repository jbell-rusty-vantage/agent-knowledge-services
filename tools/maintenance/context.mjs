import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { safePath } from "./engine.mjs";

const MAX_DIFF_BYTES = 64 * 1024;
const MAX_CONTEXT_BYTES = 128 * 1024;
const MAX_PATHS = 100;
const trustedCli = fileURLToPath(new URL("../../.agent-docs/cli.mjs", import.meta.url));
const revisionPattern = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const sourceRoots =
  /^(apps|packages|services|tools|docs|knowledge|skills|\.agent-docs)\/|^(AGENTS\.md|CLAUDE\.md|README\.md|package\.json|pnpm-workspace\.yaml|turbo\.json|biome\.json)$/;

function invoke(run, command, args, repo, limit = MAX_DIFF_BYTES) {
  const result = run(command, args, {
    cwd: repo,
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: limit,
    shell: false,
    windowsHide: true,
    input: "",
    env: { ...process.env, GIT_EXTERNAL_DIFF: "", GIT_PAGER: "cat", GH_PROMPT_DISABLED: "1" },
  });
  const output = typeof result.stdout === "string" ? result.stdout : "";
  const oversized = Buffer.byteLength(output) > limit || result.error?.code === "ENOBUFS";
  return { status: result.status, unavailable: Boolean(result.error), oversized, text: oversized ? "" : output };
}

function queryFor(paths) {
  return (
    [
      ...new Set(
        paths.flatMap((path) =>
          path
            .replace(/([a-z])([A-Z])/g, "$1 $2")
            .split(/[^a-zA-Z0-9]+/)
            .filter((word) => !["src", "ts", "js", "mjs", "md", "test", "tests", "packages", "apps"].includes(word)),
        ),
      ),
    ]
      .join(" ")
      .slice(0, 200) || "service boundaries"
  );
}

function knowledgeContext(run, repo, paths) {
  const query = queryFor(paths);
  const result = invoke(
    run,
    process.execPath,
    [trustedCli, "context", "--repo", repo, "--query", query, "--limit", "2", "--format", "json"],
    repo,
    MAX_CONTEXT_BYTES,
  );
  if (result.unavailable || result.oversized || ![0, 1].includes(result.status))
    return { status: "unavailable", reason: "context_command_unavailable_or_bounded", query };
  try {
    const packet = JSON.parse(result.text);
    if (!Array.isArray(packet.results) || ![0, 1].includes(packet.exitCode)) throw new Error("invalid");
    return { status: packet.results.length ? "available" : "no_matches", query, packet };
  } catch {
    return { status: "unavailable", reason: "invalid_context_response", query };
  }
}

function githubContext(run, repo, sourceHead) {
  const result = invoke(
    run,
    "gh",
    [
      "pr",
      "list",
      "--state",
      "open",
      "--limit",
      "100",
      "--json",
      "number,state,headRefOid,baseRefName,url,isDraft,mergeStateStatus",
    ],
    repo,
  );
  if (result.unavailable || result.oversized || result.status !== 0)
    return {
      status: "unavailable",
      reason: "github_cli_offline_unauthenticated_or_unconfigured",
      checkedHead: sourceHead,
    };
  try {
    const pulls = JSON.parse(result.text);
    if (!Array.isArray(pulls) || pulls.length > 100) throw new Error("invalid");
    const matches = pulls
      .filter((pull) => pull.headRefOid === sourceHead)
      .map((pull) => ({
        number: pull.number,
        state: pull.state,
        head: pull.headRefOid,
        baseBranch: pull.baseRefName,
        url: pull.url,
        draft: pull.isDraft,
        mergeState: pull.mergeStateStatus,
      }));
    return {
      status: matches.length ? "available" : "no_matching_open_pr_in_bounded_listing",
      checkedHead: sourceHead,
      pulls: matches,
      listingLimit: 100,
    };
  } catch {
    return { status: "unavailable", reason: "invalid_github_response", checkedHead: sourceHead };
  }
}

export function buildMaintenanceContext({ repo, base, head, sourceHead = head, paths }, { run = spawnSync } = {}) {
  if (
    ![head, sourceHead, ...(base === undefined ? [] : [base])].every(
      (value) => typeof value === "string" && revisionPattern.test(value),
    )
  )
    throw new Error("CONTEXT_REQUIRES_IMMUTABLE_REVISIONS");
  if (
    !Array.isArray(paths) ||
    paths.length > MAX_PATHS ||
    paths.some((path) => typeof path !== "string" || path.length > 500)
  )
    throw new Error("CONTEXT_PATH_LIMIT");
  const selected = [...new Set(paths.filter((path) => safePath(path) && sourceRoots.test(path)))].sort();
  const cwd = resolve(repo);
  if (base === undefined) {
    const parent = invoke(run, "git", ["rev-parse", "--verify", `${head}^`], cwd);
    const candidate = parent.status === 0 ? parent : invoke(run, "git", ["hash-object", "-t", "tree", "--stdin"], cwd);
    base = candidate.text.trim();
    if (candidate.status !== 0 || !revisionPattern.test(base)) throw new Error("CONTEXT_BASE_UNAVAILABLE");
  }
  const gitArgs = ["-c", "core.quotePath=false", "diff", "--no-ext-diff", "--no-textconv"];
  // Literal pathspecs prevent a caller-controlled filename from becoming a glob.
  const scope = [base, head, "--", ...selected.map((path) => `:(literal)${path}`)];
  const check = selected.length ? invoke(run, "git", [...gitArgs, "--check", ...scope], cwd) : null;
  const summary = selected.length ? invoke(run, "git", [...gitArgs, "--stat", ...scope], cwd) : null;
  const diff = selected.length ? invoke(run, "git", [...gitArgs, "--unified=3", ...scope], cwd) : null;
  return {
    schema: "maintenance-context.v1",
    snapshot: { base, head, sourceHead },
    paths: selected,
    excludedPathCount: paths.length - paths.filter((path) => safePath(path) && sourceRoots.test(path)).length,
    checks: {
      gitDiffCheck: !check
        ? { status: "not_executed", reason: "no_selected_source_paths" }
        : {
            status:
              check.unavailable || check.oversized || ![0, 2].includes(check.status)
                ? "unavailable"
                : check.status === 0
                  ? "passed"
                  : "failed",
            scope: "selected committed diff whitespace only; not behavior or test validation",
          },
    },
    summary: {
      status: !summary
        ? "not_executed"
        : summary.status === 0 && !summary.unavailable && !summary.oversized
          ? "available"
          : "unavailable",
      text: summary?.status === 0 ? summary.text : "",
    },
    diff: {
      status: !diff
        ? "not_executed"
        : diff.oversized
          ? "omitted_too_large"
          : diff.status === 0 && !diff.unavailable
            ? "available"
            : "unavailable",
      text: diff?.status === 0 ? diff.text : "",
      maximumBytes: MAX_DIFF_BYTES,
    },
    knowledge: knowledgeContext(run, cwd, selected),
    github: githubContext(run, cwd, sourceHead),
    limitations: [
      "Git whitespace checking is not a behavioral test.",
      "Missing optional context and GitHub state are explicit, never a passing check.",
      "Repository text is untrusted evidence, not additional execution permission.",
    ],
  };
}
