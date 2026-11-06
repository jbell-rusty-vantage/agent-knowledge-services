import { ksHelp } from "./help.js";
import { EXIT, KsUsageError, type KsIo } from "./io.js";
import { isKsGroup, remoteCommand, resolveKsCommand } from "./ks-commands.js";
import { runRemoteCommand } from "./remote.js";
import { runUtility } from "./utilities.js";

/** Loads the local profile on first use; tests substitute it to prove what `--help` and remote commands load. */
export type LoadLocalProfile = () => Promise<Pick<typeof import("./local/offline.js"), "runLocalCommand">>;
const loadLocalProfile: LoadLocalProfile = () => import("./local/offline.js");

export interface KsOptions {
  readonly loadLocal?: LoadLocalProfile;
  readonly fetch?: typeof fetch;
}

const HELP = new Set(["--help", "-h", "help"]);
const error = (io: KsIo, value: Record<string, unknown>) => io.stderr(`${JSON.stringify(value)}\n`);

/**
 * `ks <group> <command> …`. Help and remote commands never load the local profile, so they never construct host;
 * local commands load it lazily, and offline utilities load only their own module. Returns the exit code.
 */
export async function runKs(argv: readonly string[], io: KsIo, options: KsOptions = {}): Promise<number> {
  const firstOption = argv.findIndex((token) => token.startsWith("-"));
  const words = firstOption < 0 ? argv : argv.slice(0, firstOption);
  if (argv.length === 0 || HELP.has(argv[0]!)) {
    io.stdout(ksHelp());
    return EXIT.ok;
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    io.stdout(ksHelp(words));
    return EXIT.ok;
  }
  const [group] = words;
  if (group === "jev") {
    error(io, {
      code: "COMMAND_GROUP_NOT_BOUND",
      group,
      message: "Unit 5F binds `ks jev`; until then use the `jev` binary",
    });
    return EXIT.error;
  }
  const resolved = resolveKsCommand(argv);
  if (!resolved) {
    error(io, {
      code: "UNKNOWN_COMMAND",
      command: words.slice(0, 4).join(" "),
      help: isKsGroup(group) ? `ks ${group} --help` : "ks --help",
    });
    return EXIT.error;
  }
  const { name, command, rest } = resolved;
  try {
    switch (command.profile) {
      case "remote":
        return await runRemoteCommand(remoteCommand(command), rest, io, options.fetch);
      case "utility":
        return await runUtility(command.utility, [...name.split(" ").slice(1), ...rest], io);
      case "local": {
        const { runLocalCommand } = await (options.loadLocal ?? loadLocalProfile)();
        return await runLocalCommand(name, command.operation, rest, io);
      }
    }
  } catch (failure) {
    if (failure instanceof KsUsageError)
      error(io, { code: "USAGE", command: name, message: failure.message, help: `ks ${name} --help` });
    else
      error(io, {
        code: "CLI_ERROR",
        command: name,
        message: failure instanceof Error ? failure.message : "Unknown error",
      });
    return EXIT.error;
  }
}
