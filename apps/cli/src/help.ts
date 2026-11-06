import { KS_COMMANDS, KS_GROUPS, type KsCommand, type KsCommandName, type KsGroup } from "./ks-commands.js";
import { REMOTE_ENVIRONMENT } from "./remote.js";

const PROFILE: Record<KsCommand["profile"], string> = { remote: "remote", local: "local", utility: "offline" };

const SHARED = `Profiles (chosen by the command, never by a failure)
  remote   the service through KnowledgeClient: --base-url or ${REMOTE_ENVIRONMENT.url}, bearer in ${REMOTE_ENVIRONMENT.token};
           options --context '<OperationContext>' --input '<json>' [--timeout-ms N] [--wait] [--human]
  local    the local profile over a file store, loaded only for these commands: --store <dir> or KNOWLEDGE_LOCAL_STORE_DIR
           (default .knowledge-store); identity --tenant-id, --producer-deployment-id, --verifier-deployment-id,
           --producer-attempt-id, --verifier-attempt-id, --principal-salt, --git-sha (or KNOWLEDGE_LOCAL_<NAME>);
           providers only when named: --providers capture,semantic or KNOWLEDGE_LOCAL_PROVIDERS, with
           KNOWLEDGE_LOCAL_FIRECRAWL_API_KEY (document conversion) and KNOWLEDGE_LOCAL_AI_GATEWAY_API_KEY,
           KNOWLEDGE_LOCAL_JUDGE_MODEL, KNOWLEDGE_LOCAL_CROSS_FAMILY_JUDGE_MODEL (semantic); [--out <file>] [--human]
  offline  a workflow over frozen files; no service, store or provider

Exit codes
  0  success
  1  the command ran but its quality gate failed (read the JSON, fix the input, run again)
  2  usage, authorization, network or executor error (JSON on stderr); never a fallback to another profile`;

const names = (group: KsGroup) =>
  (Object.keys(KS_COMMANDS) as KsCommandName[]).filter((name) => name.split(" ")[0] === group);
const line = (name: KsCommandName) => `  ks ${name.padEnd(48)} ${PROFILE[KS_COMMANDS[name].profile]}`;

/** Help for `ks`, a group or a command prefix. Printing it constructs nothing. */
export function ksHelp(words: readonly string[] = []): string {
  const [group] = words;
  if (!group || !Object.hasOwn(KS_GROUPS, group)) {
    const groups = (Object.keys(KS_GROUPS) as KsGroup[])
      .map((name) => `  ${name.padEnd(10)} ${KS_GROUPS[name]}`)
      .join("\n");
    return `ks — Knowledge Services command line\n\nUsage: ks <group> <command> [arguments] [options]\n       ks <group> --help\n\nGroups\n${groups}\n\n${SHARED}\n`;
  }
  const prefix = words.join(" ");
  const matching = names(group as KsGroup).filter((name) => name === prefix || name.startsWith(`${prefix} `));
  const listed = (matching.length > 0 ? matching : names(group as KsGroup)).map(line).join("\n");
  return `ks ${group} — ${KS_GROUPS[group as KsGroup]}\n\n${listed || "  (no commands bound in this slice)"}\n\n${SHARED}\n`;
}
