import type { KsUtility } from "./ks-commands.js";
import { EXIT, type KsIo } from "./io.js";

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
