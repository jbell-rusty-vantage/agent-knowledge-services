import type { LocalOperation } from "@aiengineer/knowledge-host/local";
import { CLI_COMMANDS, resolveCommand, type CliCommand } from "./commands.js";

/**
 * The `ks` command names (Unit 5C). Every command runs under exactly one profile, chosen by the command and
 * never by a failure:
 *   remote  — the server profile through KnowledgeClient (API URL and bearer); never constructs host;
 *   local   — host's local profile over a file store, loaded lazily (offline, or an explicitly configured provider);
 *   utility — an offline workflow over frozen files, loaded lazily; no host, HTTP or provider.
 * Remote commands keep their resource/action key in CLI_COMMANDS, which dispatchCliCommand serves. In each group the
 * resource of the same name (`verify`, `db`) sits at the group root. `jev` is reserved until Unit 5F binds it.
 */
export type KsGroup = "knowledge" | "verify" | "db" | "jev";
export const KS_GROUPS: Readonly<Record<KsGroup, string>> = Object.freeze({
  knowledge: "sources, stores, preparation, promotion, embedding, retrieval, evaluation, publication and operations",
  verify:
    "verification operations, extraction, benchmarks, replay and the local capture tools (SV-17 retired the claims chain)",
  db: "database maintenance and fixture workflows (declared: every command fails closed with CAPABILITY_NOT_ADMITTED)",
  jev: "reserved: Unit 5F binds `ks jev`; until then use the `jev` binary",
});

type RemoteResource = keyof typeof CLI_COMMANDS;
export type KsUtility = "benchmark-capture" | "benchmark-diff" | "attestation-export" | "attestation-inspect";
export type KsCommand =
  | { readonly profile: "remote"; readonly resource: RemoteResource; readonly action: string }
  | { readonly profile: "local"; readonly operation: LocalOperation }
  | { readonly profile: "utility"; readonly utility: KsUtility };

const remote = <R extends RemoteResource>(resource: R, action: keyof (typeof CLI_COMMANDS)[R] & string): KsCommand => ({
  profile: "remote",
  resource,
  action,
});
const local = (operation: LocalOperation): KsCommand => ({ profile: "local", operation });
const utility = (name: KsUtility): KsCommand => ({ profile: "utility", utility: name });

export const KS_COMMANDS = Object.freeze({
  "knowledge source discover": remote("source", "discover"),
  "knowledge source fetch": remote("source", "fetch"),
  "knowledge source inspect": remote("source", "inspect"),
  "knowledge source vet": remote("source", "vet"),
  "knowledge store create": remote("store", "create"),
  "knowledge store show": remote("store", "show"),
  "knowledge store add-documents": remote("store", "add-documents"),
  "knowledge store search": remote("store", "search"),
  "knowledge store evaluate": remote("store", "evaluate"),
  "knowledge store status": remote("store", "status"),
  "knowledge document convert": remote("document", "convert"),
  "knowledge document inspect": remote("document", "inspect"),
  "knowledge document compare": remote("document", "compare"),
  "knowledge chunk preview": remote("chunk", "preview"),
  "knowledge chunk build": remote("chunk", "build"),
  "knowledge chunk inspect": remote("chunk", "inspect"),
  "knowledge promotion propose": remote("promotion", "propose"),
  "knowledge promotion review": remote("promotion", "review"),
  "knowledge promotion status": remote("promotion", "status"),
  "knowledge embed run": remote("embed", "run"),
  "knowledge embed status": remote("embed", "status"),
  "knowledge embed verify": remote("embed", "verify"),
  "knowledge retrieve plan": remote("retrieve", "plan"),
  "knowledge retrieve search": remote("retrieve", "search"),
  "knowledge retrieve explain": remote("retrieve", "explain"),
  "knowledge retrieve run": remote("retrieve", "run"),
  "knowledge retrieve packet": remote("retrieve", "packet"),
  "knowledge retrieve citations": remote("retrieve", "citations"),
  "knowledge eval generate": remote("eval", "generate"),
  "knowledge eval run": remote("eval", "run"),
  "knowledge eval compare": remote("eval", "compare"),
  "knowledge eval failures": remote("eval", "failures"),
  "knowledge space publish": remote("space", "publish"),
  "knowledge space rollback": remote("space", "rollback"),
  "knowledge space rebuild": remote("space", "rebuild"),
  "knowledge operation status": remote("operation", "status"),
  "knowledge operation events": remote("operation", "events"),
  "knowledge operation retry": remote("operation", "retry"),
  "knowledge operation reconcile": remote("operation", "reconcile"),

  "verify status": remote("verify", "status"),
  "verify extract": remote("verify", "extract"),
  "verify reconciliation apply": remote("reconciliation", "apply"),
  "verify reconciliation show": remote("reconciliation", "show"),
  "verify extraction run": remote("extraction", "run"),
  "verify extraction show": remote("extraction", "show"),
  "verify benchmark comparison": remote("benchmark", "comparison"),
  "verify benchmark compare": remote("benchmark", "compare"),
  "verify benchmark show": remote("benchmark", "show"),
  "verify benchmark manifest": remote("benchmark", "manifest"),
  "verify benchmark run": remote("benchmark", "run"),
  "verify benchmark capture": remote("benchmark", "capture"),
  "verify benchmark capture diagnostics-companies": utility("benchmark-capture"),
  "verify benchmark diff": utility("benchmark-diff"),
  "verify artifact parse": remote("artifact", "parse"),
  "verify artifact register": local("verify_register_artifact"),
  "verify artifact get": local("verify_get_artifact"),
  "verify bundle replay": remote("bundle", "replay"),
  "verify capture source": local("verify_capture_source"),
  "verify capture file": local("verify_capture_file"),
  "verify capture list": local("verify_list_captures"),
  "verify capture read": local("verify_read_capture"),
  "verify capture search": local("verify_search_capture"),
  "verify capture locate": local("verify_locate_quote"),
  "verify capture media-types": local("verify_supported_media_types"),
  "verify attestation export": utility("attestation-export"),
  "verify attestation inspect": utility("attestation-inspect"),

  "db verify": remote("db", "verify"),
  "db types": remote("db", "types"),
  "db rls-test": remote("db", "rls-test"),
  "db fixture load": remote("fixture", "load"),
  "db fixture reset": remote("fixture", "reset"),
} satisfies Record<string, KsCommand>);

export type KsCommandName = keyof typeof KS_COMMANDS;
const MAX_WORDS = Math.max(...Object.keys(KS_COMMANDS).map((name) => name.split(" ").length));

export const isKsGroup = (value: string | undefined): value is KsGroup =>
  value !== undefined && Object.hasOwn(KS_GROUPS, value);

/** The longest command name the leading words of `argv` spell, and the arguments after it. */
export function resolveKsCommand(
  argv: readonly string[],
): { readonly name: KsCommandName; readonly command: KsCommand; readonly rest: readonly string[] } | undefined {
  const words: string[] = [];
  for (const token of argv) {
    if (token.startsWith("-") || words.length === MAX_WORDS) break;
    words.push(token);
  }
  for (let length = words.length; length > 0; length -= 1) {
    const name = words.slice(0, length).join(" ");
    if (Object.hasOwn(KS_COMMANDS, name))
      return { name: name as KsCommandName, command: KS_COMMANDS[name as KsCommandName], rest: argv.slice(length) };
  }
  return undefined;
}

/** The dispatcher entry a remote `ks` command binds. */
export function remoteCommand(command: Extract<KsCommand, { profile: "remote" }>): CliCommand {
  const resolved = resolveCommand(command.resource, command.action);
  if (!resolved) throw new Error(`KS_COMMAND_UNBOUND:${command.resource} ${command.action}`);
  return resolved;
}

/** The `ks` name of a remote resource/action key, for catalogs and tests. */
export function ksNameOf(resource: string, action: string): KsCommandName | undefined {
  return (Object.keys(KS_COMMANDS) as KsCommandName[]).find((name) => {
    const command = KS_COMMANDS[name];
    return command.profile === "remote" && command.resource === resource && command.action === action;
  });
}
