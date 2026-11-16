import { commandDescription, operationContractForCommand } from "@aiengineer/knowledge-contracts";
import { KS_COMMANDS, KS_GROUPS, type KsCommand, type KsCommandName, type KsGroup } from "./ks-commands.js";
import { REMOTE_ENVIRONMENT } from "./remote.js";

const PROFILE: Record<KsCommand["profile"], string> = { remote: "remote", local: "local", utility: "offline" };

const SHARED = `Profiles (chosen by the command, never by a failure)
  remote   the service through KnowledgeClient: --base-url or ${REMOTE_ENVIRONMENT.url}, bearer in ${REMOTE_ENVIRONMENT.token};
           options --context '<OperationContext>' --input '<json>' [--timeout-ms N] [--wait] [--human]
  local    the local profile over a file store, loaded only for these commands: --store <dir> or KNOWLEDGE_LOCAL_STORE_DIR
           (default .knowledge-store); identity --tenant-id, --producer-deployment-id, --verifier-deployment-id,
           --producer-attempt-id, --verifier-attempt-id (or KNOWLEDGE_LOCAL_<NAME>);
           providers only when named: --providers capture or KNOWLEDGE_LOCAL_PROVIDERS, with
           KNOWLEDGE_LOCAL_FIRECRAWL_API_KEY (document conversion); [--out <file>] [--human]
  offline  a workflow over frozen files or the operation contracts; no service, store or provider

Guide and describe
  ks guide [topic]              the guidance as Markdown: without a topic the start page (the jobs, the skill and the
                                tools of each, the rules that always hold); a skill name prints that skill, and
                                <skill>/references/<name> one of its references; tools and topics list what exists
  ks describe <ref> [--human]   everything about one tool, operation or skill: purpose, input schema, field notes,
                                a valid example and the result; ref is tool:<tool name>, operation:<kind> or skill:<name>

Exit codes
  0  success
  1  the command ran but its quality gate failed (read the JSON, fix the input, run again)
  2  usage, authorization, network or executor error (JSON on stderr); never a fallback to another profile;
     an --input its operation refuses is INVALID_CONTRACT with the failing fields, and nothing is sent`;

const names = (group: KsGroup) =>
  (Object.keys(KS_COMMANDS) as KsCommandName[]).filter((name) => name.split(" ")[0] === group);
/** One line per command: its name, its profile and, when the operation has a contract, what it does. */
const line = (name: KsCommandName) => {
  const summary = operationContractForCommand(name)?.summary;
  const head = `  ks ${name.padEnd(48)} ${PROFILE[KS_COMMANDS[name].profile]}`;
  return summary ? `${head.padEnd(62)} ${summary}` : head;
};
/** What one command does, when to use it and what it returns: the description its MCP tool and API route carry. */
const detail = (name: KsCommandName) => {
  const contract = operationContractForCommand(name);
  const description = commandDescription(name);
  if (!contract || !description) return "";
  return `\n${description
    .split("\n")
    .map((text) => `  ${text}`)
    .join("\n")}\n  Input, example and result: ks describe operation:${contract.operation}\n`;
};

/** Help for `ks`, a group or a command prefix. Printing it constructs nothing. */
export function ksHelp(words: readonly string[] = []): string {
  const [group] = words;
  if (group === "describe")
    return `ks describe — explain one tool, operation or skill\n${detail("describe")}\n${SHARED}\n`;
  if (group === "guide") return `ks guide — read the guidance, start page first\n${detail("guide")}\n${SHARED}\n`;
  if (!group || !Object.hasOwn(KS_GROUPS, group)) {
    const groups = (Object.keys(KS_GROUPS) as KsGroup[])
      .map((name) => `  ${name.padEnd(10)} ${KS_GROUPS[name]}`)
      .join("\n");
    return `ks — Knowledge Services command line\n\nUsage: ks guide [topic]\n       ks <group> <command> [arguments] [options]\n       ks <group> --help\n       ks describe <ref>\n\nGroups\n${groups}\n\n${SHARED}\n`;
  }
  const prefix = words.join(" ");
  const matching = names(group as KsGroup).filter((name) => name === prefix || name.startsWith(`${prefix} `));
  const listed = (matching.length > 0 ? matching : names(group as KsGroup)).map(line).join("\n");
  // Help for exactly one command also says when to use it and what it returns.
  const exact = matching.length === 1 && matching[0] === prefix ? detail(matching[0]) : "";
  return `ks ${group} — ${KS_GROUPS[group as KsGroup]}\n\n${listed || "  (no commands bound in this slice)"}\n${exact}\n${SHARED}\n`;
}
