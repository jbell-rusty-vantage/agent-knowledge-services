import { describeReference, guidePage } from "@aiengineer/knowledge-contracts";
import type { KsUtility } from "./ks-commands.js";
import { EXIT, KsUsageError, type KsIo } from "./io.js";

type Run = (args: readonly string[], io: KsIo) => Promise<number>;
const print = (io: KsIo, value: unknown) => io.stdout(`${JSON.stringify(value)}\n`);
const failure = (io: KsIo, code: string, error?: unknown) => {
  io.stderr(
    `${JSON.stringify(error === undefined ? { code } : { code, message: error instanceof Error ? error.message : "Unknown error" })}\n`,
  );
  return EXIT.error;
};

/**
 * Offline workflows over frozen files. Each module loads only when its command runs, so `--help` and remote commands
 * never load application benchmark or attestation code. `args` start at the resource (`benchmark …`,
 * `attestation …`); the `verify` group word is already consumed.
 */
const UTILITIES: Readonly<Record<KsUtility, Run>> = {
  // `ks guide [topic]`: the page the MCP tool knowledge_guide and GET /v1/guide return, as Markdown on stdout.
  // The pages are bundled in this binary, so it needs no service, store, credentials or skills directory.
  guide: async (args, io) => {
    const [topic, ...extra] = args;
    if (extra.length > 0 || topic?.startsWith("-"))
      throw new KsUsageError("at most one topic: a skill name, <skill>/<path of one of its files>, tools or topics");
    const result = guidePage(topic);
    if (!result.ok) {
      io.stderr(`${JSON.stringify(result.refusal)}\n`);
      return EXIT.error;
    }
    io.stdout(result.markdown);
    return EXIT.ok;
  },
  // `ks describe <ref>`: the answer of the MCP tool knowledge_describe and of GET /v1/describe, computed from the
  // operation contracts in this binary. It needs no service, store or credentials.
  describe: async (args, io) => {
    const [ref, ...extra] = args.filter((token) => token !== "--human");
    if (ref === undefined || extra.length > 0 || ref.startsWith("-"))
      throw new KsUsageError("one reference is required: tool:<tool name>, operation:<kind> or skill:<name>");
    const result = describeReference(ref);
    if (!result.ok) {
      io.stderr(`${JSON.stringify(result.refusal)}\n`);
      return EXIT.error;
    }
    io.stdout(`${JSON.stringify(result.description, null, args.includes("--human") ? 2 : undefined)}\n`);
    return EXIT.ok;
  },
  "benchmark-capture": async (args, io) => {
    try {
      const [{ runDiagnosticsBenchmarkCapture }, { writeBenchmarkRefreshProposal }] = await Promise.all([
        import("./benchmark-capture.js"),
        import("./benchmark-refresh-writer.js"),
      ]);
      const result = await runDiagnosticsBenchmarkCapture(args, { writer: { writeBenchmarkRefreshProposal } });
      print(io, result);
      return result.exitCode;
    } catch (error) {
      return failure(io, "BENCHMARK_CAPTURE_ERROR", error);
    }
  },
  "benchmark-diff": async (args, io) => {
    try {
      const { runLocalBenchmarkVersionDiff } = await import("./benchmark-version-diff.js");
      print(io, await runLocalBenchmarkVersionDiff(args));
      return EXIT.ok;
    } catch (error) {
      return failure(io, "BENCHMARK_DIFF_ERROR", error);
    }
  },
  "attestation-export": async (args, io) => {
    const attestation = await import("./verification-attestation.js");
    try {
      const result = await attestation.runVerificationAttestationExport(args);
      print(io, result.output);
      return result.exitCode;
    } catch (error) {
      return failure(
        io,
        attestation.isVerificationAttestationCliError(error) ? error.code : "ATTESTATION_EXPORT_FAILED",
      );
    }
  },
  "attestation-inspect": async (args, io) => {
    const attestation = await import("./verification-attestation.js");
    try {
      const result = await attestation.runVerificationAttestationInspect(args);
      print(io, result.output);
      return result.exitCode;
    } catch (error) {
      return failure(
        io,
        attestation.isVerificationAttestationCliError(error) ? error.code : "ATTESTATION_INSPECTION_FAILED",
      );
    }
  },
};

export const runUtility = (utility: KsUtility, args: readonly string[], io: KsIo): Promise<number> =>
  UTILITIES[utility](args, io);
